// @vitest-environment node
/**
 * Route-level tests for GET /api/token-coverage (Story 5.2).
 *
 * Mirrors the connections.test.ts harness: real temp web.db via WEB_DB_PATH,
 * requireUser() mocked via vi.hoisted(), $client.close() in afterEach.
 *
 * Covers: presence rule, verdict states, 401 gate, per-user scoping,
 * Cache-Control: no-store header. Degraded-DB branch is in token-coverage-degraded.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

// Mutable auth mock — tests flip the returned user between authed/unauthed.
const { mockUser, MockAuthError } = vi.hoisted(() => {
  const mockUser: { id: string | null } = { id: 'test-user-1' };
  class MockAuthError extends Error {
    readonly status = 401;
    constructor(message = 'Unauthorized') {
      super(message);
      this.name = 'AuthError';
    }
  }
  return { mockUser, MockAuthError };
});

vi.mock('@/lib/auth', () => ({
  AuthError: MockAuthError,
  requireUser: vi.fn(async () => {
    if (!mockUser.id) throw new MockAuthError();
    return { user: { id: mockUser.id } };
  }),
}));

describe('GET /api/token-coverage', () => {
  let tempDir: string;
  let originalEnv: { WEB_DB_PATH?: string; HOME?: string };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'token-cov-test-'));
    originalEnv = {
      WEB_DB_PATH: process.env.WEB_DB_PATH,
      HOME: process.env.HOME,
    };
    process.env.WEB_DB_PATH = join(tempDir, 'web.db');

    mockUser.id = 'test-user-1';
    vi.resetModules();

    // Boot the DB (runs migrations) so route imports see a ready schema
    const { getDb } = await import('@/lib/db');
    getDb();
  });

  afterEach(async () => {
    try {
      const { db } = await import('@/lib/db');
      (db as unknown as { $client: { close: () => void } }).$client.close();
    } catch {
      // db may not have been initialized in a given test — ignore
    }
    if (originalEnv.WEB_DB_PATH !== undefined) {
      process.env.WEB_DB_PATH = originalEnv.WEB_DB_PATH;
    } else {
      delete process.env.WEB_DB_PATH;
    }
    if (originalEnv.HOME !== undefined) {
      process.env.HOME = originalEnv.HOME;
    } else {
      delete process.env.HOME;
    }
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  /** Helper: seed an agent_connection row for a given user. */
  async function seedConnection(
    userId: string,
    token: string | null,
    machineId = `m-${Math.random().toString(36).slice(2, 8)}`,
  ) {
    const { db, agentConnection } = await import('@/lib/db');
    const id = crypto.randomUUID();
    await db.insert(agentConnection).values({
      id,
      userId,
      url: 'http://agent:3000',
      name: `conn-${id.slice(0, 8)}`,
      machineId,
      method: 'tailscale',
      token,
    });
    return id;
  }

  // ─── Presence rule ────────────────────────────────────────────────────

  describe('presence rule', () => {
    it('counts NULL token as tokenless', async () => {
      await seedConnection('test-user-1', null);

      const { GET } = await import('@/app/api/token-coverage/route');
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.total).toBe(1);
      expect(body.tokenless).toBe(1);
      expect(body.covered).toBe(0);
    });

    it('counts blank "" token as tokenless', async () => {
      await seedConnection('test-user-1', '');

      const { GET } = await import('@/app/api/token-coverage/route');
      const res = await GET();
      const body = await res.json();

      expect(body.tokenless).toBe(1);
    });

    it('counts whitespace-only token as tokenless', async () => {
      await seedConnection('test-user-1', '   ');

      const { GET } = await import('@/app/api/token-coverage/route');
      const res = await GET();
      const body = await res.json();

      expect(body.tokenless).toBe(1);
    });

    it('counts real token as covered', async () => {
      await seedConnection('test-user-1', 'real-token-abc123');

      const { GET } = await import('@/app/api/token-coverage/route');
      const res = await GET();
      const body = await res.json();

      expect(body.tokenless).toBe(0);
      expect(body.covered).toBe(1);
    });

    it('handles mix of real and null tokens', async () => {
      await seedConnection('test-user-1', 'real-token');
      await seedConnection('test-user-1', null);
      await seedConnection('test-user-1', '');
      await seedConnection('test-user-1', 'another-real');

      const { GET } = await import('@/app/api/token-coverage/route');
      const res = await GET();
      const body = await res.json();

      expect(body.total).toBe(4);
      expect(body.tokenless).toBe(2);
      expect(body.covered).toBe(2);
    });
  });

  // ─── Verdict states (AC3) ─────────────────────────────────────────────

  describe('verdict states (AC3)', () => {
    it('PASS-zero: zero connections → status "empty"', async () => {
      const { GET } = await import('@/app/api/token-coverage/route');
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe('empty');
      expect(body.total).toBe(0);
      expect(body.tokenless).toBe(0);
      expect(body.covered).toBe(0);
    });

    it('PASS-covered: all tokenized → status "covered"', async () => {
      await seedConnection('test-user-1', 'tok-a');
      await seedConnection('test-user-1', 'tok-b');

      const { GET } = await import('@/app/api/token-coverage/route');
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe('covered');
      expect(body.total).toBe(2);
      expect(body.tokenless).toBe(0);
    });

    it('ATTENTION: tokenless > 0 → status "tokenless"', async () => {
      await seedConnection('test-user-1', 'tok-a');
      await seedConnection('test-user-1', null);

      const { GET } = await import('@/app/api/token-coverage/route');
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.status).toBe('tokenless');
      expect(body.total).toBe(2);
      expect(body.tokenless).toBe(1);
    });

    it('PASS-zero is distinguishable from PASS-covered', async () => {
      // Empty state
      const { GET } = await import('@/app/api/token-coverage/route');
      const emptyRes = await GET();
      const emptyBody = await emptyRes.json();
      expect(emptyBody.status).toBe('empty');

      // Seed a tokenized row
      await seedConnection('test-user-1', 'tok');
      const coveredRes = await GET();
      const coveredBody = await coveredRes.json();
      expect(coveredBody.status).toBe('covered');

      // Different status values
      expect(emptyBody.status).not.toBe(coveredBody.status);
    });
  });

  // ─── requireUser gate (AC1) ───────────────────────────────────────────

  describe('requireUser gate', () => {
    it('returns 401 when requireUser() throws', async () => {
      mockUser.id = null;
      const { GET } = await import('@/app/api/token-coverage/route');
      const res = await GET();

      expect(res.status).toBe(401);
    });

    it('returns the Unauthorized error shape', async () => {
      mockUser.id = null;
      const { GET } = await import('@/app/api/token-coverage/route');
      const res = await GET();
      const body = await res.json();

      expect(body).toEqual({ error: 'Unauthorized' });
    });

    it('does not leak DB data when unauthenticated', async () => {
      await seedConnection('test-user-1', 'secret-token');
      mockUser.id = null;

      const { GET } = await import('@/app/api/token-coverage/route');
      const res = await GET();
      const body = await res.json();

      expect(body.total).toBeUndefined();
      expect(body.tokenless).toBeUndefined();
      expect(body.covered).toBeUndefined();
    });
  });

  // ─── Per-user scoping (Trap #5) ──────────────────────────────────────

  describe('per-user scoping', () => {
    it('counts only the authenticated users rows', async () => {
      // Seed rows for two different users
      await seedConnection('test-user-1', 'tok-a');
      await seedConnection('test-user-1', 'tok-b');
      await seedConnection('test-user-1', null);
      await seedConnection('other-user', 'tok-c');
      await seedConnection('other-user', null);

      const { GET } = await import('@/app/api/token-coverage/route');
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.total).toBe(3); // only test-user-1's rows
      expect(body.tokenless).toBe(1);
      expect(body.covered).toBe(2);
    });
  });

  // ─── Cache-Control: no-store (AC2) ────────────────────────────────────

  describe('Cache-Control: no-store', () => {
    it('sets the header on success response', async () => {
      const { GET } = await import('@/app/api/token-coverage/route');
      const res = await GET();

      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });

    it('sets the header on 401 response', async () => {
      mockUser.id = null;
      const { GET } = await import('@/app/api/token-coverage/route');
      const res = await GET();

      expect(res.status).toBe(401);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    });
  });

});
