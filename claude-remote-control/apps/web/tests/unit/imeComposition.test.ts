import { describe, it, expect } from 'vitest';
import { createImeReconciler } from '../../src/components/Terminal/lib/imeComposition';

describe('createImeReconciler', () => {
  describe('Problem A - Hybrid IME streaming (Gboard on Chrome)', () => {
    it('should dedupe when same word streamed and flushed', () => {
      const ime = createImeReconciler();

      // Stream characters one-by-one during composition
      ime.startComposition();
      expect(ime.process('c')).toBe('c');
      expect(ime.process('e')).toBe('e');
      expect(ime.process('k')).toBe('k');
      ime.endComposition();
      ime.disarmFlush();

      // Flush should be fully suppressed (xterm re-emits the whole word)
      expect(ime.process('cek')).toBe('');
    });

    it('should emit only trailing space when flush includes it', () => {
      const ime = createImeReconciler();

      // Stream 'a' then 'p' during composition
      ime.startComposition();
      expect(ime.process('a')).toBe('a');
      expect(ime.process('p')).toBe('p');
      ime.endComposition();
      ime.disarmFlush();

      // Flush re-emits "ap " — only the trailing space is new
      expect(ime.process('ap ')).toBe(' ');
    });

    it('should handle partial flush suppression', () => {
      const ime = createImeReconciler();

      ime.startComposition();
      expect(ime.process('h')).toBe('h');
      expect(ime.process('e')).toBe('e');
      ime.endComposition();
      ime.disarmFlush();

      // Flush is just 'he' — fully suppressed
      expect(ime.process('he')).toBe('');
    });
  });

  describe('Firefox per-char composition (Problem B)', () => {
    it('should dedupe per-char flush in Firefox mode', () => {
      const ime = createImeReconciler();

      // Firefox: each char gets its own composition cycle
      // Char 'a'
      ime.startComposition();
      expect(ime.process('a')).toBe('a');
      ime.endComposition();
      // xterm flush arrives
      expect(ime.process('a')).toBe(''); // suppressed by flushArmed
      ime.disarmFlush();

      // Char 'p'
      ime.startComposition();
      expect(ime.process('p')).toBe('p');
      ime.endComposition();
      expect(ime.process('p')).toBe(''); // suppressed
      ime.disarmFlush();

      // Char 'c'
      ime.startComposition();
      expect(ime.process('c')).toBe('c');
      ime.endComposition();
      expect(ime.process('c')).toBe(''); // suppressed
      ime.disarmFlush();
    });

    it('should suppress word-level re-emit that arrives after disarmFlush', () => {
      const ime = createImeReconciler();

      // Per-char cycles for "apc"
      ime.startComposition();
      expect(ime.process('a')).toBe('a');
      ime.endComposition();
      expect(ime.process('a')).toBe(''); // flush suppressed
      ime.disarmFlush();

      ime.startComposition();
      expect(ime.process('p')).toBe('p');
      ime.endComposition();
      expect(ime.process('p')).toBe('');
      ime.disarmFlush();

      ime.startComposition();
      expect(ime.process('c')).toBe('c');
      ime.endComposition();
      expect(ime.process('c')).toBe('');
      ime.disarmFlush();

      // Firefox word-level re-emit arrives late
      expect(ime.process('apc')).toBe(''); // fully suppressed
    });

    it('should emit only trailing space from word-level re-emit with space', () => {
      const ime = createImeReconciler();

      // Per-char cycles for "apc"
      ime.startComposition();
      expect(ime.process('a')).toBe('a');
      ime.endComposition();
      expect(ime.process('a')).toBe('');
      ime.disarmFlush();

      ime.startComposition();
      expect(ime.process('p')).toBe('p');
      ime.endComposition();
      expect(ime.process('p')).toBe('');
      ime.disarmFlush();

      ime.startComposition();
      expect(ime.process('c')).toBe('c');
      ime.endComposition();
      expect(ime.process('c')).toBe('');
      ime.disarmFlush();

      // Word-level re-emit includes trailing space
      expect(ime.process('apc ')).toBe(' '); // only space is new
    });

    it('should handle word-level re-emit arriving BEFORE disarmFlush', () => {
      const ime = createImeReconciler();

      // Per-char cycles for first two chars
      ime.startComposition();
      expect(ime.process('a')).toBe('a');
      ime.endComposition();
      expect(ime.process('a')).toBe('');
      ime.disarmFlush();

      ime.startComposition();
      expect(ime.process('p')).toBe('p');
      ime.endComposition();
      expect(ime.process('p')).toBe('');
      ime.disarmFlush();

      // Last char cycle
      ime.startComposition();
      expect(ime.process('c')).toBe('c');
      ime.endComposition();
      // flushArmed=true, flushAlready="c"

      // Word-level re-emit arrives BEFORE disarmFlush
      expect(ime.process('apc')).toBe(''); // suppressed via recentSingle check

      // Then the per-char flush arrives
      expect(ime.process('c')).toBe(''); // suppressed by flushArmed

      ime.disarmFlush();
    });
  });

  describe('Firefox double-input bug (apc → apcapc)', () => {
    it('should handle "Apc " → "Apcpc " via single composition', () => {
      const ime = createImeReconciler();

      // All chars in one composition cycle
      ime.startComposition();
      expect(ime.process('A')).toBe('A');
      expect(ime.process('p')).toBe('p');
      expect(ime.process('c')).toBe('c');
      expect(ime.process(' ')).toBe(' ');
      ime.endComposition();
      // flushAlready="Apc ", flushArmed=true

      // Re-emit "Apcpc " — starts with "Apc " → strip prefix → "pc "
      expect(ime.process('Apcpc ')).toBe('pc ');
    });

    it('should handle "apc " → "apcapc " via per-char composition', () => {
      const ime = createImeReconciler();

      // Per-char cycles
      ime.startComposition();
      expect(ime.process('a')).toBe('a');
      ime.endComposition();
      expect(ime.process('a')).toBe('');
      ime.disarmFlush();

      ime.startComposition();
      expect(ime.process('p')).toBe('p');
      ime.endComposition();
      expect(ime.process('p')).toBe('');
      ime.disarmFlush();

      ime.startComposition();
      expect(ime.process('c')).toBe('c');
      ime.endComposition();
      expect(ime.process('c')).toBe('');
      ime.disarmFlush();

      // Space outside composition
      expect(ime.process(' ')).toBe(' ');

      // Word-level re-emit with duplicate suffix: "apcapc "
      // recentSingle has "apc ", data starts with "apc " → suppress prefix → "apc "
      // "apc" is suffix of "apc" → suppress → ""
      // Return " " (trailing space already sent)
      expect(ime.process('apcapc ')).toBe('');
    });
  });

  describe('Edge cases', () => {
    it('should pass through non-composing single chars normally', () => {
      const ime = createImeReconciler();

      expect(ime.process('a')).toBe('a');
      expect(ime.process('b')).toBe('b');
      expect(ime.process('c')).toBe('c');
    });

    it('should handle empty data gracefully', () => {
      const ime = createImeReconciler();

      expect(ime.process('')).toBe('');
      ime.startComposition();
      expect(ime.process('')).toBe('');
      ime.endComposition();
      expect(ime.process('')).toBe('');
    });

    it('should handle unrelated multi-char input outside composition', () => {
      const ime = createImeReconciler();

      // Paste or macro — should pass through and reset buffer
      expect(ime.process('hello world')).toBe('hello world');
    });
  });
});
