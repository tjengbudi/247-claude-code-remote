import { describe, it, expect, beforeEach } from 'vitest';
import {
  getClientIP,
  isRateLimited,
  recordFailure,
  resetFailures,
  buckets,
  MAX_FAILURES,
  WINDOW_MS,
} from '@/lib/pair-rate-limit';

describe('pair-rate-limit', () => {
  beforeEach(() => {
    buckets.clear();
  });

  describe('getClientIP', () => {
    it('should extract IP from x-forwarded-for (first hop)', () => {
      const req = new Request('http://localhost', {
        headers: { 'x-forwarded-for': '192.168.1.100, 10.0.0.1' },
      });
      expect(getClientIP(req)).toBe('192.168.1.100');
    });

    it('should fallback to x-real-ip', () => {
      const req = new Request('http://localhost', {
        headers: { 'x-real-ip': '192.168.1.50' },
      });
      expect(getClientIP(req)).toBe('192.168.1.50');
    });

    it('should return "unknown" if no IP headers', () => {
      const req = new Request('http://localhost');
      expect(getClientIP(req)).toBe('unknown');
    });
  });

  describe('isRateLimited', () => {
    it('should return false for new IP', () => {
      expect(isRateLimited('192.168.1.1')).toBe(false);
    });

    it('should return false when under limit', () => {
      recordFailure('192.168.1.1');
      recordFailure('192.168.1.1');
      expect(isRateLimited('192.168.1.1')).toBe(false);
    });

    it('should return true when at limit', () => {
      for (let i = 0; i < MAX_FAILURES; i++) {
        recordFailure('192.168.1.1');
      }
      expect(isRateLimited('192.168.1.1')).toBe(true);
    });

    it('should return true when over limit', () => {
      for (let i = 0; i < MAX_FAILURES + 2; i++) {
        recordFailure('192.168.1.1');
      }
      expect(isRateLimited('192.168.1.1')).toBe(true);
    });

    it('should return false for expired window', () => {
      recordFailure('192.168.1.1');
      const bucket = buckets.get('192.168.1.1')!;
      bucket.windowStart = Date.now() - WINDOW_MS - 1000;
      expect(isRateLimited('192.168.1.1')).toBe(false);
    });
  });

  describe('recordFailure', () => {
    it('should create bucket on first failure', () => {
      recordFailure('192.168.1.1');
      const bucket = buckets.get('192.168.1.1');
      expect(bucket).toBeDefined();
      expect(bucket?.count).toBe(1);
    });

    it('should increment count on subsequent failures', () => {
      recordFailure('192.168.1.1');
      recordFailure('192.168.1.1');
      recordFailure('192.168.1.1');
      const bucket = buckets.get('192.168.1.1');
      expect(bucket?.count).toBe(3);
    });

    it('should reset window if expired', () => {
      recordFailure('192.168.1.1');
      const bucket = buckets.get('192.168.1.1')!;
      bucket.windowStart = Date.now() - WINDOW_MS - 1000;
      recordFailure('192.168.1.1');
      const newBucket = buckets.get('192.168.1.1');
      expect(newBucket?.count).toBe(1);
    });
  });

  describe('resetFailures', () => {
    it('should delete bucket on successful lookup', () => {
      recordFailure('192.168.1.1');
      recordFailure('192.168.1.1');
      resetFailures('192.168.1.1');
      expect(buckets.has('192.168.1.1')).toBe(false);
    });

    it('should handle reset for non-existent IP', () => {
      resetFailures('192.168.1.1');
      expect(buckets.has('192.168.1.1')).toBe(false);
    });
  });

  describe('integration', () => {
    it('should allow 5 failures then block', () => {
      const ip = '192.168.1.100';
      for (let i = 0; i < MAX_FAILURES; i++) {
        expect(isRateLimited(ip)).toBe(false);
        recordFailure(ip);
      }
      expect(isRateLimited(ip)).toBe(true);
    });

    it('should reset and allow retries after success', () => {
      const ip = '192.168.1.100';
      for (let i = 0; i < MAX_FAILURES - 1; i++) {
        recordFailure(ip);
      }
      resetFailures(ip);
      expect(isRateLimited(ip)).toBe(false);
      for (let i = 0; i < MAX_FAILURES; i++) {
        recordFailure(ip);
      }
      expect(isRateLimited(ip)).toBe(true);
    });
  });
});
