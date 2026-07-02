import { describe, it, expect, beforeEach } from 'vitest';
import {
  createImeReconciler,
  type ImeReconciler,
} from '@/components/Terminal/lib/imeComposition';

/**
 * Tests the IME composition reconciler that fixes the Gboard "cek " -> "cekcek"
 * duplication (xterm.js @5.5.0, upstream Issue #3191 class).
 *
 * Sequence of a hybrid IME word like "cek" then a space on Gboard:
 *   compositionstart
 *   onData('c'), onData('e'), onData('k')   <- streamed incrementally
 *   compositionend                          <- arms the flush guard
 *   onData('cek') (or 'cek ')               <- redundant flush, must be stripped
 *
 * The reconciler emits only what should actually reach the WebSocket.
 */
describe('createImeReconciler', () => {
  let ime: ImeReconciler;

  beforeEach(() => {
    ime = createImeReconciler();
  });

  it('Gboard "cek " — strips the redundant compositionend flush', () => {
    ime.startComposition();
    expect(ime.process('c')).toBe('c');
    expect(ime.process('e')).toBe('e');
    expect(ime.process('k')).toBe('k');
    ime.endComposition();
    // Flush re-emits the whole word — must be suppressed entirely.
    expect(ime.process('cek')).toBe('');
  });

  it('strips the streamed prefix and keeps a trailing space the flush adds', () => {
    ime.startComposition();
    ime.process('c');
    ime.process('e');
    ime.process('k');
    ime.endComposition();
    // Some IMEs include the committing space in the flush.
    expect(ime.process('cek ')).toBe(' ');
  });

  it('flush-only desktop IME — passes the whole word through (no loss)', () => {
    // No incremental streaming during composition (e.g. CJK on desktop).
    ime.startComposition();
    ime.endComposition();
    expect(ime.process('世界')).toBe('世界');
  });

  it('ordinary physical-keyboard typing is inert (no composition events)', () => {
    expect(ime.process('a')).toBe('a');
    expect(ime.process('b')).toBe('b');
    expect(ime.process('\r')).toBe('\r');
  });

  it('a space arriving before the flush passes through and stays armed', () => {
    ime.startComposition();
    ime.process('c');
    ime.process('e');
    ime.process('k');
    ime.endComposition();
    // Separately-committed space (non-overlapping) — passed through, still armed.
    expect(ime.process(' ')).toBe(' ');
    // The real flush still follows on the same tick — stripped.
    expect(ime.process('cek')).toBe('');
  });

  it('disarmFlush() after flush arrived — reentrant cek lolos via Problem B only after TTL', () => {
    // A multi-char composition 'cek': streamed during composing, merged to
    // recentSingle at endComposition, then Problem A strips the flush.
    ime.startComposition();
    ime.process('c');
    ime.process('e');
    ime.process('k');
    ime.endComposition();
    // Chrome path: flush arrives → Problem A strips it; recentSingle=['c','e','k']
    expect(ime.process('cek')).toBe('');
    // disarmFlush fires (setTimeout(0)) — does NOT clear recentSingle.
    ime.disarmFlush();
    // A word-level re-emit 'cek' arrives (Firefox path: after disarmFlush) →
    // Problem B catches it: 'cek' matches recentSingle prefix → suppressed.
    expect(ime.process('cek')).toBe('');
    // A genuine re-type of 'cek' would only pass after RECENT_TTL_MS (500ms)
    // expires — not testable without fake timers but the behavior is TTL-gated.
  });

  it('backspace during composition passes through and does not disturb the guard', () => {
    ime.startComposition();
    ime.process('c');
    ime.process('e');
    expect(ime.process('\x7f')).toBe('\x7f'); // DEL — streamed, passed through
    ime.process('k');
    ime.endComposition();
    // streamed === 'ce\x7fk'; flush re-emits that exact sequence -> stripped.
    expect(ime.process('ce\x7fk')).toBe('');
  });

  it('subsequent compositions reset cleanly', () => {
    // First word
    ime.startComposition();
    ime.process('c');
    ime.process('e');
    ime.process('k');
    ime.endComposition();
    expect(ime.process('cek')).toBe('');
    ime.disarmFlush();

    // Second, different word — streamed accumulator was reset by startComposition.
    ime.startComposition();
    expect(ime.process('h')).toBe('h');
    expect(ime.process('i')).toBe('i');
    ime.endComposition();
    expect(ime.process('hi')).toBe('');
  });

  // Problem B: non-compose Latin word re-emit (Gboard English mode).
  // Gboard streams individual chars via keyCode-229 path and then re-emits
  // the full word (e.g. "npx ") without firing compositionstart/end.

  it('non-compose "npx " — strips already-sent chars, keeps trailing space', () => {
    expect(ime.process('n')).toBe('n');
    expect(ime.process('p')).toBe('p');
    expect(ime.process('x')).toBe('x');
    // Gboard re-emits "npx " as a single chunk — strip "npx", keep " "
    expect(ime.process('npx ')).toBe(' ');
  });

  it('non-compose exact word re-emit — suppressed entirely', () => {
    expect(ime.process('h')).toBe('h');
    expect(ime.process('i')).toBe('i');
    // Re-emit without trailing space — fully suppress
    expect(ime.process('hi')).toBe('');
  });

  it('non-compose: normal single-char typing after word is not suppressed', () => {
    expect(ime.process('h')).toBe('h');
    expect(ime.process('i')).toBe('i');
    expect(ime.process('hi')).toBe(''); // word re-emit suppressed
    // Next word typed fresh — should pass through normally
    expect(ime.process('a')).toBe('a');
    expect(ime.process('b')).toBe('b');
  });

  it('non-compose: multi-char chunk with no recent buffer passes through', () => {
    // No prior single chars — multi-char chunk is not a re-emit (e.g. paste)
    expect(ime.process('hello')).toBe('hello');
  });

  it('non-compose: multi-char starting with recent single char strips the prefix', () => {
    expect(ime.process('a')).toBe('a');
    // "abc" starts with recent "a" — strips "a", emits "bc" (correct dedup behavior)
    expect(ime.process('abc')).toBe('bc');
  });

  // Problem B — Gboard per-char composition: compositionstart/end fires for each
  // individual char (empty streamed), NOT per-word. recentSingle must survive across
  // these per-char composition cycles so the full-word re-emit can still be deduped.
  it('per-char composition cycles do not discard the recent buffer', () => {
    // Gboard fires compositionstart/end around each char with empty streamed.
    ime.startComposition();
    ime.endComposition();
    expect(ime.process('n')).toBe('n');

    ime.startComposition();
    ime.endComposition();
    expect(ime.process('p')).toBe('p');

    ime.startComposition();
    ime.endComposition();
    expect(ime.process('x')).toBe('x');

    // Full-word re-emit — must still be deduped.
    expect(ime.process('npx ')).toBe(' ');
  });

  it('per-char composition with full streamed word still uses Problem A, not B', () => {
    // A "real" composition that streams incrementally during composing.
    ime.startComposition();
    expect(ime.process('n')).toBe('n');
    expect(ime.process('p')).toBe('p');
    expect(ime.process('x')).toBe('x');
    ime.endComposition();
    // Flush via Problem A — strip exact match.
    expect(ime.process('npx')).toBe('');
  });

  // "Npcpc" scenario: capital N typed in a separate composition, then 'pc' in
  // another — the word-level re-emit is 'pc ' (not 'Npc '). Suffix match needed.
  it('suffix-only re-emit deduped correctly (Npc → "pc " re-emit)', () => {
    // First composition cycle: streams 'N', arms flush for 'N', flush arrives.
    ime.startComposition();
    expect(ime.process('N')).toBe('N');
    ime.endComposition();
    expect(ime.process('N')).toBe(''); // Problem A flush stripped

    // Second composition cycle: streams 'p','c' and merges into recentSingle.
    ime.startComposition();
    expect(ime.process('p')).toBe('p');
    expect(ime.process('c')).toBe('c');
    ime.endComposition();
    expect(ime.process('pc')).toBe(''); // Problem A flush for this segment stripped

    // Word-level re-emit from Gboard: only the last composition segment + space.
    // recentSingle ends in ['N','p','c'] and re-emit 'pc ' is a suffix match.
    expect(ime.process('pc ')).toBe(' ');
  });

  // "npcnpc" scenario: word-level re-emit arrives while composing=true for next word.
  it('word-level re-emit arriving during composing is caught before composing branch', () => {
    // Simulate 'npc' streamed through per-char compositions.
    ime.startComposition();
    expect(ime.process('n')).toBe('n');
    ime.endComposition();
    expect(ime.process('n')).toBe(''); // per-char flush

    ime.startComposition();
    expect(ime.process('p')).toBe('p');
    ime.endComposition();
    expect(ime.process('p')).toBe('');

    ime.startComposition();
    expect(ime.process('c')).toBe('c');
    ime.endComposition();
    expect(ime.process('c')).toBe('');

    // Gboard starts next-word composition BEFORE sending word-level re-emit.
    ime.startComposition();

    // Word-level re-emit 'npc ' arrives while composing=true — must be deduped.
    expect(ime.process('npc ')).toBe(' ');
  });
});
