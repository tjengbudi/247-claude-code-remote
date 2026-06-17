/**
 * Tests for session.ts — token mint, SHA-256 at rest, protocol-conditional cookie
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'crypto';

// Use vi.hoisted so mocks are available when vi.mock factory runs
const { mockCookieStore, mockDb } = vi.hoisted(() => ({
  mockCookieStore: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
  mockDb: {
    insert: vi.fn(),
    select: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve(mockCookieStore)),
}));

vi.mock('@/lib/auth/cookie-protocol', () => ({
  cookieIsSecure: vi.fn(() => Promise.resolve(false)),
  cookieName: vi.fn((secure: boolean) => secure ? '__Host-247_session' : '247_session'),
  cookieNames: vi.fn(() => ['__Host-247_session', '247_session'] as const),
}));

vi.mock('@/lib/db', () => ({
  db: mockDb,
}));

import { cookieIsSecure } from '@/lib/auth/cookie-protocol';
import { createSession, validateSession, destroySession, SESSION_TTL_MS } from '@/lib/auth/session';

describe('session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createSession', () => {
    it('mints a 256-bit token and stores only SHA-256', async () => {
      const userId = 'user-123';
      const insertValues = vi.fn();

      mockDb.insert.mockReturnValue({ values: insertValues });
      insertValues.mockResolvedValue(undefined);

      const raw = await createSession(userId);

      // Raw token should be 256-bit base64url (43 chars for 32 bytes)
      expect(raw).toMatch(/^[A-Za-z0-9_-]{43}$/);

      // Verify insert was called with SHA-256 hash (not raw token)
      expect(insertValues).toHaveBeenCalled();
      const insertCall = insertValues.mock.calls[0]![0];
      expect(insertCall.tokenHash).not.toBe(raw);
      expect(insertCall.tokenHash).toBe(createHash('sha256').update(raw).digest('hex'));
      expect(insertCall.userId).toBe(userId);
      expect(insertCall.id).toMatch(/^[0-9a-f-]{36}$/); // UUID
    });

    it('sets cookie with protocol-conditional flags', async () => {
      const insertValues = vi.fn();
      mockDb.insert.mockReturnValue({ values: insertValues });
      insertValues.mockResolvedValue(undefined);

      await createSession('user-123');

      expect(mockCookieStore.set).toHaveBeenCalled();
      const setCall = mockCookieStore.set.mock.calls[0]!;
      expect(setCall[0]).toBe('247_session'); // http (mocked)
      expect(setCall[1]).toMatch(/^[A-Za-z0-9_-]{43}$/); // raw token
      expect(setCall[2]).toMatchObject({
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: false,
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
      });
    });

    it('sets __Host- name + Secure on https (P5)', async () => {
      // AC8 requires the session suite to exercise BOTH protocols. The default
      // mock returns http; drive the secure branch by overriding cookieIsSecure.
      vi.mocked(cookieIsSecure).mockResolvedValueOnce(true);

      const insertValues = vi.fn();
      mockDb.insert.mockReturnValue({ values: insertValues });
      insertValues.mockResolvedValue(undefined);

      await createSession('user-123');

      const setCall = mockCookieStore.set.mock.calls[0]!;
      expect(setCall[0]).toBe('__Host-247_session'); // https → __Host- prefix
      expect(setCall[2]).toMatchObject({
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        secure: true,
        maxAge: Math.floor(SESSION_TTL_MS / 1000),
      });
    });
  });

  describe('validateSession', () => {
    it('returns userId for valid non-expired token', async () => {
      const raw = 'valid-token-base64url-43-chars-long-here-xx';
      const userId = 'user-456';

      const where = vi.fn();
      const limit = vi.fn();

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({ where }),
      });
      where.mockReturnValue({ limit });
      limit.mockResolvedValue([{ userId, expiresAt: new Date(Date.now() + 60000) }]);

      const result = await validateSession(raw);

      expect(result).toEqual({ id: userId });
    });

    it('returns null for expired token', async () => {
      const raw = 'expired-token-base64url-43-chars-long-xxx';

      const where = vi.fn();
      const limit = vi.fn();
      const deleteWhere = vi.fn();

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({ where }),
      });
      where.mockReturnValue({ limit });
      limit.mockResolvedValue([{ userId: 'user-789', expiresAt: new Date(Date.now() - 1000) }]);

      mockDb.delete.mockReturnValue({ where: deleteWhere });
      deleteWhere.mockResolvedValue(undefined);

      const result = await validateSession(raw);

      expect(result).toBeNull();
    });

    it('returns null (not a throw) when expired-row cleanup fails (P4)', async () => {
      // A locked/busy DB must not turn a benign expired token into a 500.
      const raw = 'expired-token-cleanup-fails-43-chars-xxx';

      const where = vi.fn();
      const limit = vi.fn();
      const deleteWhere = vi.fn();

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({ where }),
      });
      where.mockReturnValue({ limit });
      limit.mockResolvedValue([{ userId: 'user-x', expiresAt: new Date(Date.now() - 1000) }]);

      mockDb.delete.mockReturnValue({ where: deleteWhere });
      deleteWhere.mockRejectedValue(new Error('SQLITE_BUSY'));

      const result = await validateSession(raw);

      expect(result).toBeNull();
    });

    it('returns null for non-existent token', async () => {
      const raw = 'nonexistent-token-base64url-43-chars-xx';

      const where = vi.fn();
      const limit = vi.fn();

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({ where }),
      });
      where.mockReturnValue({ limit });
      limit.mockResolvedValue([]);

      const result = await validateSession(raw);

      expect(result).toBeNull();
    });
  });

  describe('destroySession', () => {
    it('deletes session row and clears cookie', async () => {
      const raw = 'session-to-destroy-base64url-43-chars-x';

      mockCookieStore.get.mockReturnValue({ value: raw });

      const deleteWhere = vi.fn();
      mockDb.delete.mockReturnValue({ where: deleteWhere });
      deleteWhere.mockResolvedValue(undefined);

      await destroySession();

      expect(deleteWhere).toHaveBeenCalled();
      expect(mockCookieStore.delete).toHaveBeenCalledWith({
        name: '247_session',
        path: '/',
      });
    });

    it('clears BOTH cookie names regardless of which is set (P1)', async () => {
      // Session was stored under the secure name on a prior https request; the
      // current request is http. destroySession must still find + clear it.
      mockCookieStore.get.mockImplementation((name: string) =>
        name === '__Host-247_session' ? { value: 'stored-under-secure-name' } : undefined
      );

      const deleteWhere = vi.fn();
      mockDb.delete.mockReturnValue({ where: deleteWhere });
      deleteWhere.mockResolvedValue(undefined);

      await destroySession();

      // Row deleted (found under the secure name) and both names cleared.
      expect(deleteWhere).toHaveBeenCalled();
      expect(mockCookieStore.delete).toHaveBeenCalledWith({
        name: '__Host-247_session',
        path: '/',
      });
      expect(mockCookieStore.delete).toHaveBeenCalledWith({
        name: '247_session',
        path: '/',
      });
    });

    it('clears the cookie even when the row delete fails (P2)', async () => {
      // A busy/locked DB must not turn logout into a 500 and leave the cookie
      // uncleared — the client must still be logged out client-side.
      mockCookieStore.get.mockReturnValue({ value: 'session-busy-db-token' });

      const deleteWhere = vi.fn();
      mockDb.delete.mockReturnValue({ where: deleteWhere });
      deleteWhere.mockRejectedValue(new Error('SQLITE_BUSY'));

      await expect(destroySession()).resolves.toBeUndefined();

      expect(mockCookieStore.delete).toHaveBeenCalledWith({
        name: '__Host-247_session',
        path: '/',
      });
      expect(mockCookieStore.delete).toHaveBeenCalledWith({
        name: '247_session',
        path: '/',
      });
    });
  });
});
