// @vitest-environment node
/**
 * Degraded-DB tests for GET /api/token-coverage (Story 5.2, AC4).
 *
 * Separate file because it needs a different DB mock (throws on access)
 * vs the main token-coverage.test.ts which uses a real temp web.db.
 *
 * Covers: structured error verdict on DB failure, no path/stack leak.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Mutable auth mock
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

// Mock DB to throw — simulates a corrupted/unreadable database.
// Provide a minimal agentConnection export so the route can import it.
vi.mock('@/lib/db', () => ({
  agentConnection: sqliteTable('agent_connection', {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    token: text('token'),
  }),
  db: new Proxy({} as Record<string, unknown>, {
    get() {
      throw new Error(
        '[web.db] cannot open /some/absolute/path/web.db: SQLITE_CANTOPEN',
      );
    },
  }),
}));

describe('GET /api/token-coverage — degraded-DB (AC4)', () => {
  beforeEach(() => {
    mockUser.id = 'test-user-1';
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('returns structured error verdict when DB is unreadable (no raw stack)', async () => {
    const { GET } = await import('@/app/api/token-coverage/route');
    const res = await GET();
    const body = await res.json();

    // Should be a 500 with a structured message, not a raw stack trace
    expect(res.status).toBe(500);
    expect(body.status).toBe('error');
    expect(body.message).toBeDefined();
    expect(typeof body.message).toBe('string');
    expect(body.message.length).toBeGreaterThan(0);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('does not leak the DB path in the error body', async () => {
    const { GET } = await import('@/app/api/token-coverage/route');
    const res = await GET();
    const body = await res.json();

    // The error message should NOT contain the resolved DB path
    expect(body.message).not.toContain('/some/absolute/path/web.db');
    // Should not contain generic path patterns
    expect(body.message).not.toMatch(/\/.*\/web\.db/);
    expect(body.message).not.toMatch(/\\.*\\web\.db/);
  });

  it('returns operator-actionable message about WEB_DB_PATH and permissions', async () => {
    const { GET } = await import('@/app/api/token-coverage/route');
    const res = await GET();
    const body = await res.json();

    // Message should tell the operator what to check
    expect(body.message).toMatch(/WEB_DB_PATH/);
    expect(body.message).toMatch(/permission/i);
  });

  it('keeps AuthError → 401 distinct from DB-error → 500', async () => {
    // First: auth fails → 401 (auth happens before DB access)
    mockUser.id = null;
    const { GET } = await import('@/app/api/token-coverage/route');
    const authErrorRes = await GET();
    expect(authErrorRes.status).toBe(401);
    const authBody = await authErrorRes.json();
    expect(authBody).toEqual({ error: 'Unauthorized' });

    // Second: auth passes but DB throws → 500
    mockUser.id = 'test-user-1';
    vi.resetModules();
    const { GET: GET2 } = await import('@/app/api/token-coverage/route');
    const dbErrorRes = await GET2();
    expect(dbErrorRes.status).toBe(500);
  });
});
