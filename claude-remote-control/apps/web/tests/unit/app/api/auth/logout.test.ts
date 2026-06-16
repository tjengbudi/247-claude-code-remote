// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

// Mock next/headers
const { mockCookieStore } = vi.hoisted(() => {
  const store = new Map<string, { name: string; value: string }>();
  return {
    mockCookieStore: {
      get: vi.fn((name: string) => store.get(name)),
      set: vi.fn((name: string, value: string) => {
        store.set(name, { name, value });
      }),
      delete: vi.fn((opts: { name: string }) => {
        store.delete(opts.name);
      }),
    },
  };
});

vi.mock('next/headers', () => ({
  cookies: vi.fn(() => Promise.resolve(mockCookieStore)),
  headers: vi.fn(() =>
    Promise.resolve({
      get: vi.fn(() => 'http'),
    })
  ),
}));

describe('POST /api/auth/logout', () => {
  let tempDir: string;
  let originalEnv: { WEB_DB_PATH?: string; HOME?: string };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'logout-route-test-'));
    originalEnv = {
      WEB_DB_PATH: process.env.WEB_DB_PATH,
      HOME: process.env.HOME,
    };
    process.env.WEB_DB_PATH = join(tempDir, 'web.db');
    vi.resetModules();

    const { getDb } = await import('@/lib/db');
    getDb();
  });

  afterEach(async () => {
    try {
      const { db } = await import('@/lib/db');
      (db as unknown as { $client: { close: () => void } }).$client.close();
    } catch {
      // ignore
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

  it('returns 200 and destroys session when valid session exists', async () => {
    const { hashPassword, createSession } = await import('@/lib/auth');
    const { db } = await import('@/lib/db');
    const { user } = await import('@/lib/db/schema');

    const userId = 'user-logout-1';
    const passwordHash = await hashPassword('password123');
    await db.insert(user).values({ id: userId, username: 'eve', passwordHash });

    // Create a session
    await createSession(userId);

    const { POST } = await import('@/app/api/auth/logout/route');
    const res = await POST();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.success).toBe(true);

    // Verify session row is deleted
    const { session: sessionTable } = await import('@/lib/db/schema');
    const { eq } = await import('drizzle-orm');
    const remaining = await db
      .select()
      .from(sessionTable)
      .where(eq(sessionTable.userId, userId));
    expect(remaining).toHaveLength(0);
  });

  it('returns 200 even with no cookie (idempotent)', async () => {
    const { POST } = await import('@/app/api/auth/logout/route');
    const res = await POST();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.success).toBe(true);
  });
});
