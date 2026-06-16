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

describe('GET /api/auth/session', () => {
  let tempDir: string;
  let originalEnv: { WEB_DB_PATH?: string; HOME?: string };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'session-route-test-'));
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

  it('returns 200 with user:null when logged out (NEVER 401)', async () => {
    const { GET } = await import('@/app/api/auth/session/route');
    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.user).toBeNull();
    expect(body.ownerExists).toBe(false);
  });

  it('returns 200 with user data when logged in', async () => {
    const { hashPassword, createSession } = await import('@/lib/auth');
    const { db } = await import('@/lib/db');
    const { user } = await import('@/lib/db/schema');

    const userId = 'user-session-1';
    const passwordHash = await hashPassword('password123');
    await db.insert(user).values({
      id: userId,
      username: 'frank',
      email: 'frank@example.com',
      passwordHash,
    });

    await createSession(userId);

    const { GET } = await import('@/app/api/auth/session/route');
    const res = await GET();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.user.id).toBe(userId);
    expect(body.data.user.name).toBe('frank');
    expect(body.data.user.email).toBe('frank@example.com');
    expect(body.ownerExists).toBe(true);
  });

  it('ownerExists reflects the user table state', async () => {
    // Empty DB → ownerExists: false
    const { GET } = await import('@/app/api/auth/session/route');
    let res = await GET();
    let body = await res.json();
    expect(body.ownerExists).toBe(false);

    // Add a user → ownerExists: true
    const { hashPassword } = await import('@/lib/auth');
    const { db } = await import('@/lib/db');
    const { user } = await import('@/lib/db/schema');

    await db.insert(user).values({
      id: 'user-any',
      username: 'grace',
      passwordHash: await hashPassword('password123'),
    });

    res = await GET();
    body = await res.json();
    expect(body.ownerExists).toBe(true);
  });
});
