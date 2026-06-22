// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

// Mock next/headers (session cookie set during auto-login)
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

describe('POST /api/auth/signup', () => {
  let tempDir: string;
  let originalEnv: { WEB_DB_PATH?: string; HOME?: string };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'signup-route-test-'));
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

  it('returns 201 and creates a user on empty DB', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');
    const req = new Request('http://x/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password: 'securepass123' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.user.id).toBeDefined();
    expect(body.data.user.name).toBe('alice');
    expect(body.data.user.email).toBeNull();

    const { db } = await import('@/lib/db');
    const { user } = await import('@/lib/db/schema');
    const rows = await db.select().from(user);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.username).toBe('alice');
  });

  it('allows a second account with a different username (multi-user)', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');

    const req1 = new Request('http://x/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password: 'securepass123' }),
    });
    const res1 = await POST(req1);
    expect(res1.status).toBe(201);

    const req2 = new Request('http://x/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username: 'bob', password: 'securepass456' }),
    });
    const res2 = await POST(req2);
    expect(res2.status).toBe(201);

    const { db } = await import('@/lib/db');
    const { user } = await import('@/lib/db/schema');
    const rows = await db.select().from(user);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.username).sort()).toEqual(['alice', 'bob']);
  });

  it('returns 409 when the username is already taken', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');

    const req1 = new Request('http://x/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password: 'securepass123' }),
    });
    await POST(req1);

    const req2 = new Request('http://x/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password: 'differentpass789' }),
    });
    const res = await POST(req2);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('Username already taken');

    // Only the original row survives
    const { db } = await import('@/lib/db');
    const { user } = await import('@/lib/db/schema');
    const rows = await db.select().from(user);
    expect(rows).toHaveLength(1);
  });

  it('returns 400 when username is missing', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');
    const req = new Request('http://x/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ password: 'securepass123' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Missing username or password');
  });

  it('returns 400 when password is shorter than 8 characters', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');
    const req = new Request('http://x/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password: 'short' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Password must be at least 8 characters');
  });

  it('trims surrounding whitespace from a valid username', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');
    const req = new Request('http://x/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username: '  alice  ', password: 'securepass123' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.user.name).toBe('alice');

    const { db } = await import('@/lib/db');
    const { user } = await import('@/lib/db/schema');
    const rows = await db.select().from(user);
    expect(rows[0]?.username).toBe('alice');
  });

  it('auto-logs-in after signup (session cookie set)', async () => {
    const { POST } = await import('@/app/api/auth/signup/route');
    const req = new Request('http://x/api/auth/signup', {
      method: 'POST',
      body: JSON.stringify({ username: 'alice', password: 'securepass123' }),
    });
    await POST(req);

    expect(mockCookieStore.set).toHaveBeenCalled();
  });
});
