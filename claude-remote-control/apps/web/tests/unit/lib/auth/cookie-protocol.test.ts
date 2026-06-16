/**
 * Tests for cookie-protocol.ts — server-side protocol detection
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cookieIsSecure, cookieName } from '@/lib/auth/cookie-protocol';

// Mock next/headers
const mockHeaders = {
  get: vi.fn(),
};

vi.mock('next/headers', () => ({
  headers: vi.fn(() => Promise.resolve(mockHeaders)),
}));

describe('cookie-protocol', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('cookieIsSecure', () => {
    it('returns true when x-forwarded-proto is https', async () => {
      mockHeaders.get.mockReturnValue('https');
      const result = await cookieIsSecure();
      expect(result).toBe(true);
      expect(mockHeaders.get).toHaveBeenCalledWith('x-forwarded-proto');
    });

    it('returns false when x-forwarded-proto is http', async () => {
      mockHeaders.get.mockReturnValue('http');
      const result = await cookieIsSecure();
      expect(result).toBe(false);
    });

    it('returns false when x-forwarded-proto is not set', async () => {
      mockHeaders.get.mockReturnValue(null);
      const result = await cookieIsSecure();
      expect(result).toBe(false);
    });

    it('handles comma-separated x-forwarded-proto (first hop)', async () => {
      // First hop is https, but subsequent hops might differ
      mockHeaders.get.mockReturnValue('https, http');
      const result = await cookieIsSecure();
      expect(result).toBe(true);
    });

    it('returns false when headers() throws', async () => {
      vi.mocked(await import('next/headers')).headers.mockRejectedValueOnce(
        new Error('No headers available')
      );
      const result = await cookieIsSecure();
      expect(result).toBe(false);
    });
  });

  describe('cookieName', () => {
    it('returns __Host-247_session for secure protocol', () => {
      const name = cookieName(true);
      expect(name).toBe('__Host-247_session');
    });

    it('returns 247_session for insecure protocol', () => {
      const name = cookieName(false);
      expect(name).toBe('247_session');
    });
  });
});
