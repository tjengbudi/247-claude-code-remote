// @vitest-environment node
/**
 * Route-level E2E tests for agent_connection API routes.
 *
 * Exercises the actual exported route handlers (GET/POST/PUT/DELETE) against a
 * real temp web.db via WEB_DB_PATH. neonAuth() is mocked at the module level
 * so the identity layer is stubbed but the DB path is fully real.
 *
 * Proves AC2 (connection CRUD through routes) and AC4 (neonAuth boot-safety
 * still returns 401 when unauthenticated).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

// Mutable auth mock — tests flip the returned user between authed/unauthed
const mockUser: { id: string | null } = { id: 'test-user-1' };
vi.mock('@neondatabase/auth/next/server', () => ({
  neonAuth: vi.fn(async () => ({
    user: mockUser.id ? { id: mockUser.id } : null,
  })),
}));

describe('api/connections route handlers', () => {
  let tempDir: string;
  let originalEnv: { WEB_DB_PATH?: string; HOME?: string };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'conn-route-test-'));
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
    // Close the better-sqlite3 handle before deleting the temp dir, otherwise the
    // OS file handle (+ web.db-wal/-shm) lingers until GC. vi.resetModules() only
    // drops the JS reference, not the open connection.
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

  describe('GET /api/connections', () => {
    it('lists connections scoped to the authenticated user', async () => {
      const { POST } = await import('@/app/api/connections/route');
      const { GET } = await import('@/app/api/connections/route');

      // Seed two rows for the authed user + one for a different user
      const seedReq = (body: object) =>
        new Request('http://x/api/connections', {
          method: 'POST',
          body: JSON.stringify(body),
        });

      await POST(seedReq({ url: 'http://a', name: 'A', machineId: 'm-a' }));
      await POST(seedReq({ url: 'http://b', name: 'B', machineId: 'm-b' }));

      mockUser.id = 'other-user';
      await POST(seedReq({ url: 'http://c', name: 'C', machineId: 'm-c' }));

      mockUser.id = 'test-user-1';
      const res = await GET();
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
      expect(body.every((r: { userId: string }) => r.userId === 'test-user-1')).toBe(true);
    });

    it('returns 401 when neonAuth() returns no user (AC4)', async () => {
      mockUser.id = null;
      const { GET } = await import('@/app/api/connections/route');
      const res = await GET();
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/connections', () => {
    it('inserts a row and returns it', async () => {
      const { POST } = await import('@/app/api/connections/route');
      const req = new Request('http://x/api/connections', {
        method: 'POST',
        body: JSON.stringify({
          url: 'http://agent:3000',
          name: 'My Agent',
          machineId: 'machine-abc',
          method: 'tailscale',
          color: '#112233',
        }),
      });
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.id).toBeDefined();
      expect(body.userId).toBe('test-user-1');
      expect(body.name).toBe('My Agent');
      expect(body.url).toBe('http://agent:3000');
      expect(body.machineId).toBe('machine-abc');
      expect(body.method).toBe('tailscale');
      expect(body.color).toBe('#112233');
    });

    it("defaults method to 'tailscale' when omitted", async () => {
      const { POST } = await import('@/app/api/connections/route');
      const req = new Request('http://x/api/connections', {
        method: 'POST',
        body: JSON.stringify({ url: 'http://agent', name: 'NoMethod', machineId: 'm' }),
      });
      const res = await POST(req);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.method).toBe('tailscale');
    });

    it('returns 500 on a malformed (non-JSON) body', async () => {
      const { POST } = await import('@/app/api/connections/route');
      const req = new Request('http://x/api/connections', {
        method: 'POST',
        body: 'not-json',
      });
      const res = await POST(req);
      expect(res.status).toBe(500);
    });

    it('returns 401 when unauthenticated', async () => {
      mockUser.id = null;
      const { POST } = await import('@/app/api/connections/route');
      const req = new Request('http://x/api/connections', {
        method: 'POST',
        body: JSON.stringify({ url: 'http://a', name: 'A' }),
      });
      const res = await POST(req);
      expect(res.status).toBe(401);
    });
  });

  describe('PUT /api/connections/[id]', () => {
    it('updates name/url/method/color and bumps updatedAt', async () => {
      const { POST } = await import('@/app/api/connections/route');
      const createRes = await POST(
        new Request('http://x/api/connections', {
          method: 'POST',
          body: JSON.stringify({ url: 'http://old', name: 'Old', machineId: 'm' }),
        })
      );
      const created = await createRes.json();

      // Small delay so updatedAt can differ from createdAt
      await new Promise((r) => setTimeout(r, 10));

      const { PUT } = await import('@/app/api/connections/[id]/route');
      const res = await PUT(
        new Request('http://x/api/connections/x', {
          method: 'PUT',
          body: JSON.stringify({
            name: 'Renamed',
            url: 'http://new',
            method: 'cloud',
            color: '#aabbcc',
          }),
        }),
        { params: Promise.resolve({ id: created.id }) }
      );
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.name).toBe('Renamed');
      expect(body.url).toBe('http://new');
      expect(body.method).toBe('cloud');
      expect(body.color).toBe('#aabbcc');
      expect(new Date(body.updatedAt).getTime()).toBeGreaterThan(
        new Date(created.updatedAt).getTime()
      );
    });

    it("does not update another user's row (scoped by userId → 404)", async () => {
      const { POST } = await import('@/app/api/connections/route');
      const createRes = await POST(
        new Request('http://x/api/connections', {
          method: 'POST',
          body: JSON.stringify({ url: 'http://owned', name: 'Owned', machineId: 'm' }),
        })
      );
      const created = await createRes.json();

      // A different user attempts to update the row → must not match (404)
      mockUser.id = 'attacker';
      const { PUT } = await import('@/app/api/connections/[id]/route');
      const res = await PUT(
        new Request('http://x/api/connections/x', {
          method: 'PUT',
          body: JSON.stringify({ name: 'Hijacked', url: 'http://evil', method: 'cloud' }),
        }),
        { params: Promise.resolve({ id: created.id }) }
      );
      expect(res.status).toBe(404);

      // Confirm the original row is untouched for the real owner
      mockUser.id = 'test-user-1';
      const { GET } = await import('@/app/api/connections/route');
      const list = await (await GET()).json();
      const row = list.find((r: { id: string }) => r.id === created.id);
      expect(row.name).toBe('Owned');
      expect(row.url).toBe('http://owned');
    });

    it('returns 404 when the row does not exist', async () => {
      const { PUT } = await import('@/app/api/connections/[id]/route');
      const res = await PUT(
        new Request('http://x/api/connections/x', {
          method: 'PUT',
          body: JSON.stringify({ name: 'X', url: 'http://x', method: 'tailscale' }),
        }),
        { params: Promise.resolve({ id: 'nonexistent-id' }) }
      );
      expect(res.status).toBe(404);
    });

    it('returns 401 when unauthenticated', async () => {
      mockUser.id = null;
      const { PUT } = await import('@/app/api/connections/[id]/route');
      const res = await PUT(
        new Request('http://x/api/connections/x', {
          method: 'PUT',
          body: JSON.stringify({ name: 'X' }),
        }),
        { params: Promise.resolve({ id: 'any' }) }
      );
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/connections/[id]', () => {
    it('removes the row', async () => {
      const { POST } = await import('@/app/api/connections/route');
      const createRes = await POST(
        new Request('http://x/api/connections', {
          method: 'POST',
          body: JSON.stringify({ url: 'http://a', name: 'A', machineId: 'm' }),
        })
      );
      const created = await createRes.json();

      const { DELETE } = await import('@/app/api/connections/[id]/route');
      const delRes = await DELETE(new Request('http://x/api/connections/x', { method: 'DELETE' }), {
        params: Promise.resolve({ id: created.id }),
      });
      expect(delRes.status).toBe(200);

      // Confirm row is gone
      const { GET } = await import('@/app/api/connections/route');
      const listRes = await GET();
      const list = await listRes.json();
      expect(list.find((r: { id: string }) => r.id === created.id)).toBeUndefined();
    });

    it("does not delete another user's row (scoped by userId)", async () => {
      const { POST } = await import('@/app/api/connections/route');
      const createRes = await POST(
        new Request('http://x/api/connections', {
          method: 'POST',
          body: JSON.stringify({ url: 'http://a', name: 'A', machineId: 'm' }),
        })
      );
      const created = await createRes.json();

      // A different user attempts the delete — the where(id AND userId) clause
      // matches no row, so the owner's row must survive.
      mockUser.id = 'attacker';
      const { DELETE } = await import('@/app/api/connections/[id]/route');
      const delRes = await DELETE(new Request('http://x/api/connections/x', { method: 'DELETE' }), {
        params: Promise.resolve({ id: created.id }),
      });
      expect(delRes.status).toBe(200); // delete is a no-op but still 200

      mockUser.id = 'test-user-1';
      const { GET } = await import('@/app/api/connections/route');
      const list = await (await GET()).json();
      expect(list.find((r: { id: string }) => r.id === created.id)).toBeDefined();
    });

    it('returns 401 when unauthenticated', async () => {
      mockUser.id = null;
      const { DELETE } = await import('@/app/api/connections/[id]/route');
      const res = await DELETE(new Request('http://x/api/connections/x', { method: 'DELETE' }), {
        params: Promise.resolve({ id: 'any' }),
      });
      expect(res.status).toBe(401);
    });
  });
});
