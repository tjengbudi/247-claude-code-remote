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

  it('disarmFlush() prevents the guard from catching a later identical word', () => {
    ime.startComposition();
    ime.process('c');
    ime.process('e');
    ime.process('k');
    ime.endComposition();
    ime.disarmFlush();
    // After disarm, an identical word typed later must NOT be swallowed.
    expect(ime.process('cek')).toBe('cek');
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
});
