/**
 * IME composition reconciler for the web terminal.
 *
 * Problem A (xterm.js @5.5.0, upstream Issue #3191 class): hybrid IMEs such as
 * Gboard on Android both stream characters incrementally during composition
 * (via the keyCode 229 path, CompositionHelper `_handleAnyTextareaChanges`)
 * AND re-emit the whole composed word on `compositionend` (the `setTimeout(0)`
 * flush in `_finalizeComposition`). xterm's built-in dedup only subtracts the
 * LAST keydown commit (`_dataAlreadySent`), not the full accumulated word, so
 * typing `cek` then space yields `cekcek`.
 *
 * This reconciler sits at the `onData` boundary. It records what was streamed
 * during a composition and, when the `compositionend` flush arrives, strips the
 * portion already sent — emitting only the genuinely-new tail (e.g. a trailing
 * space) or nothing at all.
 *
 * Problem B (Gboard / Firefox word-level re-emit): Android keyboards on Firefox
 * fire compositionstart/end around each individual character (per-char mode),
 * then send the whole word as a single multi-char chunk AFTER the
 * setTimeout(0) disarmFlush tick. recentSingle accumulates chars sent through
 * per-char compositions; when the multi-char re-emit arrives it strips the
 * already-sent prefix and emits only the tail (e.g. trailing space).
 *
 * Firefox-specific fix (2026-07): On Firefox Android, the word-level re-emit
 * can arrive BEFORE disarmFlush for the last per-char composition. At that
 * point flushArmed=true but flushAlive only holds the LAST char (e.g. "c"),
 * while the re-emit is the whole word (e.g. "apc"). The flushArmed branch
 * would fall through and send it as a duplicate. Fix: when flushArmed and the
 * data doesn't match flushAlready, also check against the full recent word
 * (recentSingle). If data matches or is a prefix of recent, suppress/dedupe.
 *
 * Example trace for "apc " → "apcapc " (Firefox):
 * 1. compositionstart → process('a') → compositionend → armFlush("a")
 * 2. xterm flush 'a' → suppressed (flushArmed, exact match)
 * 3. disarmFlush → compositionstart → process('p') → compositionend → armFlush("p")
 * 4. xterm flush 'p' → suppressed → disarmFlush
 * 5. compositionstart → process('c') → compositionend → armFlush("c")
 * 6. Firefox word re-emit "apc" arrives BEFORE disarmFlush
 *    → flushArmed=true, flushAlive="c", data="apc" → no match on "c"
 *    → NEW: check against recent="apc" → data.startsWith("apc") → suppress!
 * 7. xterm flush 'c' → suppressed (flushArmed, exact match)
 * 8. disarmFlush → process(" ") → sent as " "
 * Result: "apc " ✓
 *
 * Important: recentSingle is NEVER cleared by disarmFlush. xterm's per-char
 * Problem A flush fires before disarmFlush (same setTimeout queue), which would
 * leave the buffer empty when the word-level re-emit arrives. TTL (500 ms)
 * naturally expires stale entries instead.
 */
export interface ImeReconciler {
  /** Begin a composition; reset the streamed accumulator. */
  startComposition(): void;
  /** End a composition; arm the flush guard with what was streamed so far. */
  endComposition(): void;
  /**
   * Reconcile a chunk arriving at the onData boundary.
   * Returns the string that should actually be sent (empty string = suppress).
   */
  process(data: string): string;
  /**
   * Disarm the flush guard. Call on a `setTimeout(0)` after `endComposition`
   * so the guard never outlives the single flush tick it protects.
   */
  disarmFlush(): void;
}

// How long (ms) a single-char chunk stays in the rolling recent-send buffer.
const RECENT_TTL_MS = 500;

/**
 * Find the length of the longest overlap where a suffix of `source`
 * matches a prefix of `target`.
 *
 * Example: source="Apc ", target="pc " → "pc " is suffix of "Apc " and prefix of "pc " → 3
 * Example: source="apc", target="pc " → "pc" is suffix of "apc" and prefix of "pc " → 2
 */
function suffixPrefixOverlap(source: string, target: string): number {
  const maxLen = Math.min(source.length, target.length);
  for (let len = maxLen; len > 0; len--) {
    if (source.endsWith(target.slice(0, len))) {
      return len;
    }
  }
  return 0;
}

/**
 * Find the length of the longest common prefix between two strings.
 */
function longestCommonPrefix(s1: string, s2: string): number {
  const maxLen = Math.min(s1.length, s2.length);
  for (let len = maxLen; len > 0; len--) {
    if (s1.slice(0, len) === s2.slice(0, len)) {
      return len;
    }
  }
  return 0;
}

export function createImeReconciler(): ImeReconciler {
  let composing = false;
  // Characters streamed incrementally during the current composition.
  let streamed = '';
  // When true, the next chunk may be the redundant compositionend flush.
  let flushArmed = false;
  // The streamed word the flush is expected to duplicate.
  let flushAlready = '';

  // Rolling buffer of chars sent (or streamed during composition), used to
  // detect word-level re-emits from Gboard/Firefox (Problem B).
  // Each entry: [char, timestamp]. Cleared only by Problem B on a successful
  // match, or by natural TTL expiry — never by disarmFlush (see module doc).
  const recentSingle: Array<[string, number]> = [];

  function pruneRecent(now: number): void {
    while (recentSingle.length > 0 && now - recentSingle[0][1] > RECENT_TTL_MS) {
      recentSingle.shift();
    }
  }

  function recentWord(now: number): string {
    pruneRecent(now);
    return recentSingle.map(([c]) => c).join('');
  }

  return {
    startComposition(): void {
      composing = true;
      streamed = '';
      // Do NOT clear recentSingle — per-char composition fires startComposition
      // for every individual character, and chars from earlier cycles must stay
      // in the buffer so the word-level re-emit can be deduped later.
    },

    endComposition(): void {
      composing = false;
      flushAlready = streamed;
      flushArmed = streamed.length > 0;
      // Merge composition-streamed chars into recentSingle so the word-level
      // re-emit that arrives later (possibly after disarmFlush on Firefox) can
      // be caught by Problem B.
      const now = Date.now();
      for (const ch of streamed) {
        recentSingle.push([ch, now]);
      }
      streamed = '';
    },

    process(data: string): string {
      const now = Date.now();

      if (flushArmed) {
        // The flush should duplicate `flushAlready`. Strip the overlap.
        if (data === flushAlready) {
          flushArmed = false;
          return '';
        }
        if (data.startsWith(flushAlready)) {
          flushArmed = false;
          return data.slice(flushAlready.length);
        }
        if (flushAlready.startsWith(data)) {
          flushArmed = false;
          return '';
        }

        // Firefox fix: word-level re-emit arrived before disarmFlush.
        // flushAlive only holds the LAST per-char composition's streamed text,
        // but the re-emit is the FULL accumulated word. Check against
        // recentSingle (which accumulates across all per-char cycles).
        if (data.length > 1) {
          const recent = recentWord(now);
          if (recent.length > 0) {
            // Use longestCommonPrefix instead of startsWith to handle cases like
            // "Apcpc ".startsWith("Apc ") which returns false but should match
            const overlap = longestCommonPrefix(data, recent);
            if (overlap > 0) {
              // Full or partial word re-emit matches recently sent — suppress overlap.
              recentSingle.length = 0;
              const tail = data.slice(overlap);
              // Also disarm: the per-char flush for the current cycle will arrive
              // next and should be suppressed by matching flushAlready.
              // Don't disarm — let the per-char flush be caught by flushArmed.
              if (tail.length === 1) recentSingle.push([tail, now]);
              return tail;
            }
            // Partial: re-emit is a suffix of recent (e.g. recent="Apc",
            // re-emit="pc" because 'A' was typed outside composition).
            const dataWord = data.endsWith(' ') ? data.slice(0, -1) : data;
            if (dataWord.length > 0 && recent.endsWith(dataWord)) {
              recentSingle.splice(recentSingle.length - dataWord.length);
              const trail = data.endsWith(' ') ? ' ' : '';
              if (trail) recentSingle.push([trail, now]);
              return trail;
            }
          }
          // Suffix-prefix overlap: flushAlready appears as a prefix within data
          // e.g., flushAlready="Apc ", data="Apcpc " → strip "Apc " → "pc "
          const overlap = suffixPrefixOverlap(flushAlready, data);
          if (overlap > 0 && overlap < data.length) {
            return data.slice(overlap);
          }
        }

        // Non-overlapping chunk arrived before the flush (e.g. a space the IME
        // committed separately). Pass it through but stay armed — the real
        // flush is still expected on this same tick.
        return data;
      }

      // Problem B: word-level re-emit — checked BEFORE the composing branch.
      // Gboard/Firefox often fires compositionstart for the next word before
      // delivering the re-emit for the previous word; without this ordering the
      // re-emit slips through the composing branch as genuine input.
      // Multi-char chunks from physical keyboards don't exist in practice (each
      // keystroke produces a single char), so matching here is safe.
      if (data.length > 1) {
        const recent = recentWord(now);
        if (recent.length > 0) {
          // Use longestCommonPrefix instead of startsWith to handle cases like
          // "apcapc ".startsWith("apc ") which returns false but should match
          const overlap = longestCommonPrefix(data, recent);
          if (overlap > 0) {
            // Full or partial word re-emit matches recently sent — suppress overlap.
            recentSingle.length = 0;
            let tail = data.slice(overlap);
            // After stripping prefix, check if tail still overlaps with recent
            // (Firefox double-input: "apcapc " → strip "apc " → "apc " still overlaps)
            const tailOverlap = suffixPrefixOverlap(recent, tail);
            if (tailOverlap > 0 && tailOverlap < tail.length) {
              tail = tail.slice(tailOverlap);
            } else if (tailOverlap === tail.length && tailOverlap > 0) {
              // Tail is entirely duplicated in recent — suppress completely
              tail = '';
            }
            if (tail.length === 1) recentSingle.push([tail, now]);
            return tail;
          }
          // Suffix match: re-emit covers only the LAST composition segment.
          // Example: recent='Npc', re-emit='pc ' — 'N' was committed in a
          // prior session so only 'pc' appears in the re-emit.
          const dataWord = data.endsWith(' ') ? data.slice(0, -1) : data;
          if (dataWord.length > 0 && recent.endsWith(dataWord)) {
            recentSingle.splice(recentSingle.length - dataWord.length);
            const trail = data.endsWith(' ') ? ' ' : '';
            if (trail) recentSingle.push([trail, now]);
            return trail;
          }
        }
        if (!composing) {
          // Unrelated multi-char chunk (e.g. paste, macro) — reset buffer.
          recentSingle.length = 0;
        } else {
          streamed += data;
        }
        return data;
      }

      if (composing) {
        streamed += data;
        return data;
      }

      // Single-char chunk outside composition — track in recent buffer.
      pruneRecent(now);
      recentSingle.push([data, now]);
      return data;
    },

    disarmFlush(): void {
      // Do NOT clear recentSingle here. On Firefox, xterm's per-char Problem A
      // flush fires in the same setTimeout(0) queue BEFORE this call, which
      // would leave the buffer empty when the word-level re-emit arrives later.
      // Stale entries expire naturally via RECENT_TTL_MS (500 ms).
      flushArmed = false;
      flushAlready = '';
    },
  };
}
