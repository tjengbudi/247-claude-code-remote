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

describe('POST /api/auth/bootstrap', () => {
  let tempDir: string;
  let originalEnv: { WEB_DB_PATH?: string; HOME?: string };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'bootstrap-route-test-'));
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

  it('returns 201 and creates owner on empty DB', async () => {
    const { POST } = await import('@/app/api/auth/bootstrap/route');
    const req = new Request('http://x/api/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'securepass123' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.user.id).toBeDefined();
    expect(body.data.user.name).toBe('admin');
    expect(body.data.user.email).toBeNull();

    // Verify user row exists
    const { db } = await import('@/lib/db');
    const { user } = await import('@/lib/db/schema');
    const rows = await db.select().from(user);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.username).toBe('admin');
  });

  it('returns 409 on second bootstrap attempt', async () => {
    const { POST } = await import('@/app/api/auth/bootstrap/route');

    // First bootstrap
    const req1 = new Request('http://x/api/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'securepass123' }),
    });
    await POST(req1);

    // Second bootstrap
    const req2 = new Request('http://x/api/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin2', password: 'securepass456' }),
    });
    const res = await POST(req2);

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('Owner already exists');

    // Verify only one user exists
    const { db } = await import('@/lib/db');
    const { user } = await import('@/lib/db/schema');
    const rows = await db.select().from(user);
    expect(rows).toHaveLength(1);
  });

  it('returns 400 on missing username or password', async () => {
    const { POST } = await import('@/app/api/auth/bootstrap/route');
    const req = new Request('http://x/api/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ username: '', password: '' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Missing username or password');
  });

  it('returns 400 on password shorter than 8 characters', async () => {
    const { POST } = await import('@/app/api/auth/bootstrap/route');
    const req = new Request('http://x/api/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'short' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Password must be at least 8 characters');
  });

  it('returns 400 on non-string password (cannot bypass 8-char floor)', async () => {
    const { POST } = await import('@/app/api/auth/bootstrap/route');
    const req = new Request('http://x/api/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 12345678 }),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Missing username or password');

    // No owner row created
    const { db } = await import('@/lib/db');
    const { user } = await import('@/lib/db/schema');
    const rows = await db.select().from(user);
    expect(rows).toHaveLength(0);
  });

  it('returns 400 on malformed JSON body', async () => {
    const { POST } = await import('@/app/api/auth/bootstrap/route');
    const req = new Request('http://x/api/auth/bootstrap', {
      method: 'POST',
      body: '{not valid json',
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Missing username or password');
  });

  it('rejects a whitespace-only username and persists no owner', async () => {
    const { POST } = await import('@/app/api/auth/bootstrap/route');
    const req = new Request('http://x/api/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ username: '   ', password: 'securepass123' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('Missing username or password');

    const { db } = await import('@/lib/db');
    const { user } = await import('@/lib/db/schema');
    const rows = await db.select().from(user);
    expect(rows).toHaveLength(0);
  });

  it('trims surrounding whitespace from a valid username', async () => {
    const { POST } = await import('@/app/api/auth/bootstrap/route');
    const req = new Request('http://x/api/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ username: '  admin  ', password: 'securepass123' }),
    });
    const res = await POST(req);

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.user.name).toBe('admin');

    const { db } = await import('@/lib/db');
    const { user } = await import('@/lib/db/schema');
    const rows = await db.select().from(user);
    expect(rows[0]?.username).toBe('admin');
  });

  it('auto-logs-in after bootstrap (session cookie set)', async () => {
    const { POST } = await import('@/app/api/auth/bootstrap/route');
    const req = new Request('http://x/api/auth/bootstrap', {
      method: 'POST',
      body: JSON.stringify({ username: 'admin', password: 'securepass123' }),
    });
    await POST(req);

    // Verify session cookie was set
    expect(mockCookieStore.set).toHaveBeenCalled();
    const setCall = mockCookieStore.set.mock.calls[0];
    expect(setCall[0]).toBe('247_session'); // http protocol
    expect(setCall[1]).toMatch(/^[A-Za-z0-9_-]{43}$/); // base64url token
  });
});
