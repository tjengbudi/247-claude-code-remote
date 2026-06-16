/**
 * Tests for throttle.ts — in-memory login throttle
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/pair-rate-limit', () => ({
  getClientIP: vi.fn((req: Request) => req.headers.get('x-client-ip') || 'unknown'),
}));

import {
  isLoginRateLimited,
  recordLoginFailure,
  resetLoginFailures,
  buckets,
  WINDOW_MS,
  MAX_FAILURES,
} from '@/lib/auth/throttle';

describe('throttle', () => {
  beforeEach(() => {
    buckets.clear();
  });

  describe('isLoginRateLimited', () => {
    it('returns false for unknown IP', () => {
      expect(isLoginRateLimited('new-ip')).toBe(false);
    });

    it('returns false when under limit', () => {
      const ip = 'test-ip';
      buckets.set(ip, { count: MAX_FAILURES - 1, windowStart: Date.now() });

      expect(isLoginRateLimited(ip)).toBe(false);
    });

    it('returns true when at or over limit', () => {
      const ip = 'test-ip';
      buckets.set(ip, { count: MAX_FAILURES, windowStart: Date.now() });

      expect(isLoginRateLimited(ip)).toBe(true);
    });

    it('returns false and cleans up expired window', () => {
      const ip = 'test-ip';
      buckets.set(ip, { count: MAX_FAILURES + 5, windowStart: Date.now() - WINDOW_MS - 1000 });

      expect(isLoginRateLimited(ip)).toBe(false);
      expect(buckets.has(ip)).toBe(false);
    });
  });

  describe('recordLoginFailure', () => {
    it('creates new bucket for unknown IP', () => {
      const ip = 'new-ip';
      recordLoginFailure(ip);

      const bucket = buckets.get(ip);
      expect(bucket).toBeDefined();
      expect(bucket!.count).toBe(1);
    });

    it('increments count for existing bucket', () => {
      const ip = 'test-ip';
      recordLoginFailure(ip);
      recordLoginFailure(ip);

      const bucket = buckets.get(ip);
      expect(bucket!.count).toBe(2);
    });

    it('resets window if expired', () => {
      const ip = 'test-ip';
      const oldStart = Date.now() - WINDOW_MS - 1000;
      buckets.set(ip, { count: 10, windowStart: oldStart });

      recordLoginFailure(ip);

      const bucket = buckets.get(ip);
      expect(bucket!.count).toBe(1);
      expect(bucket!.windowStart).toBeGreaterThan(oldStart);
    });
  });

  describe('resetLoginFailures', () => {
    it('deletes bucket for IP', () => {
      const ip = 'test-ip';
      buckets.set(ip, { count: 5, windowStart: Date.now() });

      resetLoginFailures(ip);

      expect(buckets.has(ip)).toBe(false);
    });
  });

  describe('integration', () => {
    it('limits after MAX_FAILURES failures', () => {
      const ip = 'test-ip';

      for (let i = 0; i < MAX_FAILURES - 1; i++) {
        recordLoginFailure(ip);
        expect(isLoginRateLimited(ip)).toBe(false);
      }

      recordLoginFailure(ip);
      expect(isLoginRateLimited(ip)).toBe(true);
    });

    it('success does not consume budget (reset clears)', () => {
      const ip = 'test-ip';

      for (let i = 0; i < MAX_FAILURES - 1; i++) {
        recordLoginFailure(ip);
      }

      resetLoginFailures(ip);

      for (let i = 0; i < MAX_FAILURES - 1; i++) {
        recordLoginFailure(ip);
        expect(isLoginRateLimited(ip)).toBe(false);
      }
    });
  });
});
