import { describe, it, expect } from 'vitest';
import { computeCoverageVerdict } from '@/lib/coverage-verdict';

describe('computeCoverageVerdict', () => {
  describe('PASS-zero (empty)', () => {
    it('returns status "empty" when total is 0', () => {
      const result = computeCoverageVerdict(0, 0);
      expect(result.status).toBe('empty');
      expect(result.total).toBe(0);
      expect(result.tokenless).toBe(0);
      expect(result.covered).toBe(0);
    });

    it('distinguishes empty from covered (different status values)', () => {
      const empty = computeCoverageVerdict(0, 0);
      const covered = computeCoverageVerdict(3, 0);
      expect(empty.status).not.toBe(covered.status);
    });

    it('mentions "nothing paired yet" in message', () => {
      const result = computeCoverageVerdict(0, 0);
      expect(result.message).toMatch(/nothing paired yet/i);
    });

    it('cautions that empty ≠ safe-to-flip-ON', () => {
      const result = computeCoverageVerdict(0, 0);
      expect(result.message).toMatch(/not.*safe/i);
    });
  });

  describe('PASS-covered', () => {
    it('returns status "covered" when total > 0 and tokenless is 0', () => {
      const result = computeCoverageVerdict(5, 0);
      expect(result.status).toBe('covered');
      expect(result.total).toBe(5);
      expect(result.tokenless).toBe(0);
      expect(result.covered).toBe(5);
    });

    it('handles single tokenized connection', () => {
      const result = computeCoverageVerdict(1, 0);
      expect(result.status).toBe('covered');
      expect(result.covered).toBe(1);
    });

    it('points to 247 token --test for reach verification', () => {
      const result = computeCoverageVerdict(3, 0);
      expect(result.message).toMatch(/247 token --test/);
    });

    it('mentions presence ≠ correctness caveat', () => {
      const result = computeCoverageVerdict(3, 0);
      expect(result.message).toMatch(/presence/i);
    });
  });

  describe('ATTENTION (tokenless)', () => {
    it('returns status "tokenless" when tokenless > 0', () => {
      const result = computeCoverageVerdict(5, 2);
      expect(result.status).toBe('tokenless');
      expect(result.total).toBe(5);
      expect(result.tokenless).toBe(2);
      expect(result.covered).toBe(3);
    });

    it('handles all-tokenless case', () => {
      const result = computeCoverageVerdict(3, 3);
      expect(result.status).toBe('tokenless');
      expect(result.tokenless).toBe(3);
      expect(result.covered).toBe(0);
    });

    it('mentions re-pair in message', () => {
      const result = computeCoverageVerdict(4, 1);
      expect(result.message).toMatch(/re-pair/i);
    });

    it('includes the tokenless count in message', () => {
      const result = computeCoverageVerdict(4, 1);
      expect(result.message).toContain('1 of 4');
    });

    it('points to 247 token --test for reach verification', () => {
      const result = computeCoverageVerdict(4, 1);
      expect(result.message).toMatch(/247 token --test/);
    });
  });

  describe('input validation', () => {
    it('throws when tokenless exceeds total', () => {
      expect(() => computeCoverageVerdict(3, 5)).toThrow(
        /tokenless.*cannot exceed total/i,
      );
    });

    it('does not throw for equal total and tokenless', () => {
      expect(() => computeCoverageVerdict(5, 5)).not.toThrow();
    });
  });

  describe('covered = total - tokenless invariant', () => {
    it('holds for all input combinations', () => {
      for (const total of [0, 1, 5, 100]) {
        for (let tokenless = 0; tokenless <= total; tokenless++) {
          const result = computeCoverageVerdict(total, tokenless);
          expect(result.covered).toBe(total - tokenless);
        }
      }
    });
  });
});
