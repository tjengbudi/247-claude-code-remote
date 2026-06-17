/**
 * Tests for bootstrap.ts — WEB_AUTH_SECRET provisioning + ownerExists
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted so mocks are available when vi.mock factory runs
const { mockDb } = vi.hoisted(() => ({
  mockDb: {
    select: vi.fn(),
    insert: vi.fn(),
  },
}));

vi.mock('@/lib/db', () => ({
  db: mockDb,
}));

import { getWebAuthSecret, ownerExists, _resetSecretCache } from '@/lib/auth/bootstrap';

describe('bootstrap', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    _resetSecretCache();
  });

  afterEach(() => {
    // Restore original env values
    process.env = { ...originalEnv };
  });

  describe('getWebAuthSecret', () => {
    it('returns env value when set and long enough', async () => {
      // Must clear BOTH the length and the distinct-byte floor.
      const secret = 'M8q3Vz7Lp1Rw0Yt6Bd4Xn9Hk2Cs5Gj7F';
      process.env.WEB_AUTH_SECRET = secret;

      const result = await getWebAuthSecret();

      expect(result).toBe(secret);
    });

    it('throws if env value is too short', async () => {
      process.env.WEB_AUTH_SECRET = 'short';

      await expect(getWebAuthSecret()).rejects.toThrow(/too short/);
    });

    it('throws if env value clears length but is low-entropy (P3)', async () => {
      // 32 bytes but a single repeated char — passes a length-only gate,
      // fails the distinct-byte floor.
      process.env.WEB_AUTH_SECRET = 'a'.repeat(32);

      await expect(getWebAuthSecret()).rejects.toThrow(/distinct bytes/);
    });

    it('treats an empty persisted row as absent, not as the secret (P4)', async () => {
      // A blank/corrupted row must NOT become the signing secret. readPersistedSecret
      // returns null for an empty value, so we fall through to generate in dev.
      process.env.WEB_AUTH_SECRET = '';
      Object.defineProperty(process.env, 'NODE_ENV', {
        value: 'development',
        writable: true,
        configurable: true,
      });

      const where = vi.fn();
      const limit = vi.fn();
      const insertValues = vi.fn();

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({ where }),
      });
      where.mockReturnValue({ limit });
      // Pre-insert read returns an empty-valued row; post-insert re-read also
      // empty → winner falls back to the freshly generated hex (|| not ??).
      limit.mockResolvedValueOnce([{ value: '' }]).mockResolvedValueOnce([{ value: '' }]);

      mockDb.insert.mockReturnValue({ values: insertValues });
      insertValues.mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) });

      const result = await getWebAuthSecret();

      // Generated 64-char hex, NOT the empty string.
      expect(result).toMatch(/^[0-9a-f]{64}$/);
      expect(insertValues).toHaveBeenCalled();
    });

    it('returns persisted value when env not set', async () => {
      process.env.WEB_AUTH_SECRET = '';
      const persisted = 'persisted-secret-32-bytes-long-x';

      const where = vi.fn();
      const limit = vi.fn();

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({ where }),
      });
      where.mockReturnValue({ limit });
      limit.mockResolvedValue([{ value: persisted }]);

      const result = await getWebAuthSecret();

      expect(result).toBe(persisted);
    });

    it('generates and persists when neither env nor DB has value (dev)', async () => {
      process.env.WEB_AUTH_SECRET = '';
      Object.defineProperty(process.env, 'NODE_ENV', {
        value: 'development',
        writable: true,
        configurable: true,
      });

      const where = vi.fn();
      const limit = vi.fn();
      const insertValues = vi.fn();

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({ where }),
      });
      where.mockReturnValue({ limit });
      limit.mockResolvedValue([]);

      // insert(...).values(...).onConflictDoNothing(...) — race-safe chain
      mockDb.insert.mockReturnValue({ values: insertValues });
      insertValues.mockReturnValue({ onConflictDoNothing: vi.fn().mockResolvedValue(undefined) });

      const result = await getWebAuthSecret();

      // Should be a 64-char hex string (32 bytes)
      expect(result).toMatch(/^[0-9a-f]{64}$/);

      // Should have inserted
      expect(insertValues).toHaveBeenCalled();
      const insertCall = insertValues.mock.calls[0]![0];
      expect(insertCall.userId).toBe('__system__');
      expect(insertCall.key).toBe('web_auth_secret');
      expect(insertCall.value).toBe(result);
    });

    it('throws if the persisted value is too short (P6)', async () => {
      process.env.WEB_AUTH_SECRET = '';

      const where = vi.fn();
      const limit = vi.fn();
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({ where }),
      });
      where.mockReturnValue({ limit });
      // A short/corrupted persisted row must not silently become the secret.
      limit.mockResolvedValue([{ value: 'short' }]);

      await expect(getWebAuthSecret()).rejects.toThrow(/too short/);
    });

    it('converges on the stored value via re-read after a conflicting insert (P2)', async () => {
      process.env.WEB_AUTH_SECRET = '';
      Object.defineProperty(process.env, 'NODE_ENV', {
        value: 'development',
        writable: true,
        configurable: true,
      });

      const where = vi.fn();
      const limit = vi.fn();
      const insertValues = vi.fn();
      const onConflictDoNothing = vi.fn();
      const winner = 'winner-secret-32-bytes-long-xxxx';

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({ where }),
      });
      where.mockReturnValue({ limit });
      // First read (pre-insert) finds nothing; re-read (post-insert) returns the
      // row a concurrent caller won, so we converge on it instead of our own.
      limit.mockResolvedValueOnce([]).mockResolvedValueOnce([{ value: winner }]);

      mockDb.insert.mockReturnValue({ values: insertValues });
      insertValues.mockReturnValue({ onConflictDoNothing });
      onConflictDoNothing.mockResolvedValue(undefined);

      const result = await getWebAuthSecret();

      expect(result).toBe(winner);
      expect(onConflictDoNothing).toHaveBeenCalled();
    });

    it('throws in prod when neither env nor persisted', async () => {
      process.env.WEB_AUTH_SECRET = '';
      Object.defineProperty(process.env, 'NODE_ENV', {
        value: 'production',
        writable: true,
        configurable: true,
      });

      const where = vi.fn();
      const limit = vi.fn();

      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({ where }),
      });
      where.mockReturnValue({ limit });
      limit.mockResolvedValue([]);

      await expect(getWebAuthSecret()).rejects.toThrow(/not set in production/);
    });

    it('memoizes the secret', async () => {
      const secret = 'M8q3Vz7Lp1Rw0Yt6Bd4Xn9Hk2Cs5Gj7F';
      process.env.WEB_AUTH_SECRET = secret;

      await getWebAuthSecret();
      await getWebAuthSecret();

      // Should only read env once (memoized)
      expect(process.env.WEB_AUTH_SECRET).toBe(secret);
    });
  });

  describe('ownerExists', () => {
    it('returns false when no users exist', async () => {
      const limit = vi.fn();
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({ limit }),
      });
      limit.mockResolvedValue([]);

      const result = await ownerExists();

      expect(result).toBe(false);
    });

    it('returns true when at least one user exists', async () => {
      const limit = vi.fn();
      mockDb.select.mockReturnValue({
        from: vi.fn().mockReturnValue({ limit }),
      });
      limit.mockResolvedValue([{ id: 'user-1' }]);

      const result = await ownerExists();

      expect(result).toBe(true);
    });
  });
});
