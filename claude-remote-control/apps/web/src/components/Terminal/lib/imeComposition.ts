/**
 * IME composition reconciler for the web terminal.
 *
 * Problem (xterm.js @5.5.0, upstream Issue #3191 class): hybrid IMEs such as
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
 * It is inert for ordinary physical-keyboard typing (no `compositionstart` ever
 * fires) and for flush-only desktop IMEs (nothing was streamed, so the flush is
 * passed through verbatim — no input is lost).
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

export function createImeReconciler(): ImeReconciler {
  let composing = false;
  // Characters streamed incrementally during the current composition.
  let streamed = '';
  // When true, the next chunk may be the redundant compositionend flush.
  let flushArmed = false;
  // The streamed word the flush is expected to duplicate.
  let flushAlready = '';

  return {
    startComposition(): void {
      composing = true;
      streamed = '';
    },

    endComposition(): void {
      composing = false;
      flushAlready = streamed;
      flushArmed = streamed.length > 0;
      streamed = '';
    },

    process(data: string): string {
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
        // Non-overlapping chunk arrived before the flush (e.g. a space the IME
        // committed separately). Pass it through but stay armed — the real
        // flush is still expected on this same tick.
        return data;
      }

      if (composing) {
        streamed += data;
        return data;
      }

      return data;
    },

    disarmFlush(): void {
      flushArmed = false;
      flushAlready = '';
    },
  };
}
