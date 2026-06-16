/**
 * Tests for index.ts — auth seam (getCurrentUser, requireUser)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock next/headers
const mockCookieStore = {
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
};

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve(mockCookieStore)),
}));

// Mock cookie-protocol
vi.mock('@/lib/auth/cookie-protocol', () => ({
  cookieIsSecure: vi.fn(() => Promise.resolve(false)),
  cookieName: vi.fn((secure: boolean) => secure ? '__Host-247_session' : '247_session'),
  cookieNames: vi.fn(() => ['__Host-247_session', '247_session'] as const),
}));

// Mock session
vi.mock('@/lib/auth/session', () => ({
  validateSession: vi.fn(),
  createSession: vi.fn(),
  destroySession: vi.fn(),
}));

import { getCurrentUser, requireUser, AuthError } from '@/lib/auth/index';
import { validateSession } from '@/lib/auth/session';

describe('auth seam', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getCurrentUser', () => {
    it('returns null when no cookie present', async () => {
      mockCookieStore.get.mockReturnValue(undefined);

      const result = await getCurrentUser();

      expect(result).toBeNull();
    });

    it('returns null when cookie present but session invalid', async () => {
      mockCookieStore.get.mockReturnValue({ value: 'invalid-token' });
      vi.mocked(validateSession).mockResolvedValue(null);

      const result = await getCurrentUser();

      expect(result).toBeNull();
    });

    it('returns user id when valid session', async () => {
      mockCookieStore.get.mockReturnValue({ value: 'valid-token' });
      vi.mocked(validateSession).mockResolvedValue({ id: 'user-123' });

      const result = await getCurrentUser();

      expect(result).toEqual({ id: 'user-123' });
    });

    it('finds the session when stored under the OTHER protocol name (P1)', async () => {
      // Cookie was set as plain `247_session` (http), but this request only has
      // the secure-named cookie absent — the both-names read must still find it.
      mockCookieStore.get.mockImplementation((name: string) =>
        name === '247_session' ? { value: 'plain-token' } : undefined
      );
      vi.mocked(validateSession).mockResolvedValue({ id: 'user-flip' });

      const result = await getCurrentUser();

      expect(result).toEqual({ id: 'user-flip' });
      expect(validateSession).toHaveBeenCalledWith('plain-token');
    });
  });

  describe('requireUser', () => {
    it('returns { user: { id } } on valid session', async () => {
      mockCookieStore.get.mockReturnValue({ value: 'valid-token' });
      vi.mocked(validateSession).mockResolvedValue({ id: 'user-456' });

      const result = await requireUser();

      expect(result).toEqual({ user: { id: 'user-456' } });
    });

    it('throws AuthError when no session', async () => {
      mockCookieStore.get.mockReturnValue(undefined);

      await expect(requireUser()).rejects.toThrow(AuthError);
    });

    it('throws AuthError with status 401', async () => {
      mockCookieStore.get.mockReturnValue(undefined);

      try {
        await requireUser();
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthError);
        expect((err as AuthError).status).toBe(401);
      }
    });

    it('is arg-less (reads cookies internally)', async () => {
      mockCookieStore.get.mockReturnValue({ value: 'valid-token' });
      vi.mocked(validateSession).mockResolvedValue({ id: 'user-789' });

      // Call with no args (like neonAuth)
      const result = await requireUser();

      expect(result).toEqual({ user: { id: 'user-789' } });
    });

    it('accepts optional req param (forward-compat)', async () => {
      mockCookieStore.get.mockReturnValue({ value: 'valid-token' });
      vi.mocked(validateSession).mockResolvedValue({ id: 'user-abc' });

      const req = new Request('http://localhost/api/test');
      const result = await requireUser(req);

      expect(result).toEqual({ user: { id: 'user-abc' } });
    });
  });

  describe('AuthError', () => {
    it('is a discriminable error type', () => {
      const err = new AuthError();

      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(AuthError);
      expect(err.name).toBe('AuthError');
      expect(err.status).toBe(401);
      expect(err.message).toBe('Unauthorized');
    });

    it('accepts custom message', () => {
      const err = new AuthError('Custom message');

      expect(err.message).toBe('Custom message');
    });
  });
});
