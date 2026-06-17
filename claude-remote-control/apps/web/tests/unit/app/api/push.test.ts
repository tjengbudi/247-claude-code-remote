// @vitest-environment node
/**
 * Route-level E2E tests for push_subscription API routes.
 *
 * Exercises POST/DELETE /api/push/subscribe and POST /api/push/notify against
 * a real temp web.db. requireUser() is mocked for subscribe routes (auth-gated);
 * notify is unauthenticated by design.
 *
 * Proves AC2 (push_subscription CRUD including onConflictDoUpdate upsert)
 * and AC4 (requireUser boot-safety returns 401 when unauthenticated).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

// Mutable auth mock.
// vi.hoisted() ensures the AuthError class is defined before vi.mock() hoists,
// so the route's `instanceof AuthError` check matches the same class reference.
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

// Mock the push delivery layer (wraps web-push + VAPID env)
const mockSendPush = vi.fn().mockResolvedValue(true);
vi.mock('@/lib/push', () => ({
  sendPushNotification: mockSendPush,
}));

describe('api/push route handlers', () => {
  let tempDir: string;
  let originalEnv: { WEB_DB_PATH?: string; HOME?: string };

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'push-route-test-'));
    originalEnv = {
      WEB_DB_PATH: process.env.WEB_DB_PATH,
      HOME: process.env.HOME,
    };
    process.env.WEB_DB_PATH = join(tempDir, 'web.db');

    mockUser.id = 'test-user-1';
    mockSendPush.mockClear();
    vi.resetModules();

    // Boot DB (runs migrations)
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

  describe('POST /api/push/subscribe', () => {
    it('inserts a new subscription', async () => {
      const { POST } = await import('@/app/api/push/subscribe/route');
      const req = new Request('http://x/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          subscription: {
            endpoint: 'https://push.example.com/sub-1',
            keys: { p256dh: 'key-p256dh-1', auth: 'key-auth-1' },
          },
          userAgent: 'TestBrowser/1.0',
        }),
      });
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.id).toBeDefined();
    });

    it('upserts on duplicate endpoint via onConflictDoUpdate', async () => {
      const { POST } = await import('@/app/api/push/subscribe/route');

      // First insert
      const req1 = new Request('http://x/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          subscription: {
            endpoint: 'https://push.example.com/same-endpoint',
            keys: { p256dh: 'key-old', auth: 'key-auth-old' },
          },
          userAgent: 'OldBrowser',
        }),
      });
      const res1 = await POST(req1);
      const body1 = await res1.json();
      expect(res1.status).toBe(200);

      // Second insert with same endpoint (should upsert, not crash)
      const req2 = new Request('http://x/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          subscription: {
            endpoint: 'https://push.example.com/same-endpoint',
            keys: { p256dh: 'key-new', auth: 'key-auth-new' },
          },
          userAgent: 'NewBrowser',
        }),
      });
      const res2 = await POST(req2);
      const body2 = await res2.json();

      expect(res2.status).toBe(200);
      expect(body2.success).toBe(true);
      // Same row updated, not a new insert
      expect(body2.id).toBe(body1.id);

      // Verify only one row exists
      const { db, pushSubscription } = await import('@/lib/db');
      const { eq } = await import('drizzle-orm');
      const rows = await db
        .select()
        .from(pushSubscription)
        .where(eq(pushSubscription.endpoint, 'https://push.example.com/same-endpoint'));
      expect(rows).toHaveLength(1);
      expect(rows[0].p256dh).toBe('key-new');
      expect(rows[0].auth).toBe('key-auth-new');
    });

    it('returns 400 when the subscription is missing endpoint/keys', async () => {
      const { POST } = await import('@/app/api/push/subscribe/route');
      const req = new Request('http://x/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({ subscription: { endpoint: 'https://x' } }), // no keys
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it('returns 401 when unauthenticated', async () => {
      mockUser.id = null;
      const { POST } = await import('@/app/api/push/subscribe/route');
      const req = new Request('http://x/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          subscription: {
            endpoint: 'https://push.example.com/sub',
            keys: { p256dh: 'k', auth: 'k' },
          },
        }),
      });
      const res = await POST(req);
      expect(res.status).toBe(401);
    });
  });

  describe('DELETE /api/push/subscribe', () => {
    it('removes subscription by endpoint', async () => {
      const { POST } = await import('@/app/api/push/subscribe/route');
      const { DELETE } = await import('@/app/api/push/subscribe/route');

      // Seed a subscription
      const seedReq = new Request('http://x/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          subscription: {
            endpoint: 'https://push.example.com/to-delete',
            keys: { p256dh: 'k1', auth: 'k2' },
          },
        }),
      });
      await POST(seedReq);

      // Delete by endpoint
      const delReq = new Request('http://x/api/push/subscribe', {
        method: 'DELETE',
        body: JSON.stringify({ endpoint: 'https://push.example.com/to-delete' }),
      });
      const res = await DELETE(delReq);
      expect(res.status).toBe(200);

      // Verify row is gone
      const { db, pushSubscription } = await import('@/lib/db');
      const { eq } = await import('drizzle-orm');
      const rows = await db
        .select()
        .from(pushSubscription)
        .where(eq(pushSubscription.endpoint, 'https://push.example.com/to-delete'));
      expect(rows).toHaveLength(0);
    });

    it("does not delete another user's subscription (scoped by userId)", async () => {
      // user-1 subscribes an endpoint
      const { POST } = await import('@/app/api/push/subscribe/route');
      await POST(
        new Request('http://x/api/push/subscribe', {
          method: 'POST',
          body: JSON.stringify({
            subscription: {
              endpoint: 'https://push.example.com/owned',
              keys: { p256dh: 'k', auth: 'k' },
            },
          }),
        })
      );

      // a different user tries to delete it by endpoint
      mockUser.id = 'attacker';
      const { DELETE } = await import('@/app/api/push/subscribe/route');
      const res = await DELETE(
        new Request('http://x/api/push/subscribe', {
          method: 'DELETE',
          body: JSON.stringify({ endpoint: 'https://push.example.com/owned' }),
        })
      );
      expect(res.status).toBe(200); // no-op delete still returns 200

      // the owner's subscription must survive
      const { db, pushSubscription } = await import('@/lib/db');
      const { eq } = await import('drizzle-orm');
      const rows = await db
        .select()
        .from(pushSubscription)
        .where(eq(pushSubscription.endpoint, 'https://push.example.com/owned'));
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe('test-user-1');
    });

    it('returns 400 when endpoint is missing', async () => {
      const { DELETE } = await import('@/app/api/push/subscribe/route');
      const req = new Request('http://x/api/push/subscribe', {
        method: 'DELETE',
        body: JSON.stringify({}),
      });
      const res = await DELETE(req);
      expect(res.status).toBe(400);
    });

    it('returns 401 when unauthenticated', async () => {
      mockUser.id = null;
      const { DELETE } = await import('@/app/api/push/subscribe/route');
      const req = new Request('http://x/api/push/subscribe', {
        method: 'DELETE',
        body: JSON.stringify({ endpoint: 'https://any' }),
      });
      const res = await DELETE(req);
      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/push/notify (db read path)', () => {
    it('finds connection by machineId and fans out to subscriptions', async () => {
      // Seed an agent_connection
      const { POST: postConn } = await import('@/app/api/connections/route');
      const connReq = new Request('http://x/api/connections', {
        method: 'POST',
        body: JSON.stringify({
          url: 'http://agent:3000',
          name: 'Agent',
          machineId: 'machine-xyz',
        }),
      });
      const connRes = await postConn(connReq);
      const conn = await connRes.json();

      // Seed two push subscriptions for the same user
      const { POST: postSub } = await import('@/app/api/push/subscribe/route');
      await postSub(
        new Request('http://x/api/push/subscribe', {
          method: 'POST',
          body: JSON.stringify({
            subscription: {
              endpoint: 'https://push.example.com/sub-a',
              keys: { p256dh: 'ka', auth: 'ka' },
            },
          }),
        })
      );
      await postSub(
        new Request('http://x/api/push/subscribe', {
          method: 'POST',
          body: JSON.stringify({
            subscription: {
              endpoint: 'https://push.example.com/sub-b',
              keys: { p256dh: 'kb', auth: 'kb' },
            },
          }),
        })
      );

      // Trigger notify
      const { POST: postNotify } = await import('@/app/api/push/notify/route');
      const notifyReq = new Request('http://x/api/push/notify', {
        method: 'POST',
        body: JSON.stringify({
          machineId: 'machine-xyz',
          sessionName: 'project--sess-1',
          reason: 'permission',
        }),
      });
      const res = await postNotify(notifyReq);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.sent).toBe(2);
      expect(mockSendPush).toHaveBeenCalledTimes(2);

      // Both endpoints get delivered — assert the SET, not call order (the db
      // select has no ORDER BY, so call[0] vs call[1] order is not guaranteed).
      const calledEndpoints = mockSendPush.mock.calls.map((c) => c[0].endpoint).sort();
      expect(calledEndpoints).toEqual([
        'https://push.example.com/sub-a',
        'https://push.example.com/sub-b',
      ]);

      // Payload structure is the same for every fan-out target — assert on any call.
      const payload = mockSendPush.mock.calls[0][1];
      expect(payload.title).toBe('Claude - project');
      expect(payload.body).toBe('Permission requise');
      expect(payload.data.connectionId).toBe(conn.id);
    });

    it('returns 0 sent when machineId not paired', async () => {
      const { POST } = await import('@/app/api/push/notify/route');
      const req = new Request('http://x/api/push/notify', {
        method: 'POST',
        body: JSON.stringify({
          machineId: 'unpaired-machine',
          sessionName: 'proj--sess',
        }),
      });
      const res = await POST(req);
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      expect(body.sent).toBe(0);
      expect(body.message).toBe('Agent not paired');
      expect(mockSendPush).not.toHaveBeenCalled();
    });

    it('returns 400 when machineId missing', async () => {
      const { POST } = await import('@/app/api/push/notify/route');
      const req = new Request('http://x/api/push/notify', {
        method: 'POST',
        body: JSON.stringify({ sessionName: 'proj--sess' }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it('returns 400 when sessionName missing', async () => {
      const { POST } = await import('@/app/api/push/notify/route');
      const req = new Request('http://x/api/push/notify', {
        method: 'POST',
        body: JSON.stringify({ machineId: 'machine-xyz' }),
      });
      const res = await POST(req);
      expect(res.status).toBe(400);
    });

    it("returns 0 sent with 'No subscriptions' when the paired user has none", async () => {
      // Seed a connection but NO push_subscription rows for its user.
      const { POST: postConn } = await import('@/app/api/connections/route');
      await postConn(
        new Request('http://x/api/connections', {
          method: 'POST',
          body: JSON.stringify({ url: 'http://agent', name: 'Agent', machineId: 'machine-nosub' }),
        })
      );

      const { POST } = await import('@/app/api/push/notify/route');
      const res = await POST(
        new Request('http://x/api/push/notify', {
          method: 'POST',
          body: JSON.stringify({ machineId: 'machine-nosub', sessionName: 'proj--sess' }),
        })
      );
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.sent).toBe(0);
      expect(body.message).toBe('No subscriptions');
      expect(mockSendPush).not.toHaveBeenCalled();
    });

    it('falls back to default body when reason is unknown/omitted', async () => {
      const { POST: postConn } = await import('@/app/api/connections/route');
      const connRes = await postConn(
        new Request('http://x/api/connections', {
          method: 'POST',
          body: JSON.stringify({ url: 'http://agent', name: 'Agent', machineId: 'machine-def' }),
        })
      );
      await connRes.json();

      const { POST: postSub } = await import('@/app/api/push/subscribe/route');
      await postSub(
        new Request('http://x/api/push/subscribe', {
          method: 'POST',
          body: JSON.stringify({
            subscription: {
              endpoint: 'https://push.example.com/def',
              keys: { p256dh: 'k', auth: 'k' },
            },
          }),
        })
      );

      const { POST } = await import('@/app/api/push/notify/route');
      const res = await POST(
        new Request('http://x/api/push/notify', {
          method: 'POST',
          // No `reason` field → reasonMessages[undefined] || fallback
          body: JSON.stringify({ machineId: 'machine-def', sessionName: 'proj--sess' }),
        })
      );
      expect(res.status).toBe(200);
      expect(mockSendPush.mock.calls[0][1].body).toBe('Attention requise');
    });

    it('deletes an expired subscription when delivery fails and reports it', async () => {
      const { POST: postConn } = await import('@/app/api/connections/route');
      await postConn(
        new Request('http://x/api/connections', {
          method: 'POST',
          body: JSON.stringify({ url: 'http://agent', name: 'Agent', machineId: 'machine-exp' }),
        })
      );

      const { POST: postSub } = await import('@/app/api/push/subscribe/route');
      await postSub(
        new Request('http://x/api/push/subscribe', {
          method: 'POST',
          body: JSON.stringify({
            subscription: {
              endpoint: 'https://push.example.com/expired',
              keys: { p256dh: 'k', auth: 'k' },
            },
          }),
        })
      );

      // Delivery fails → route should prune the row and count it as expired.
      mockSendPush.mockResolvedValueOnce(false);

      const { POST } = await import('@/app/api/push/notify/route');
      const res = await POST(
        new Request('http://x/api/push/notify', {
          method: 'POST',
          body: JSON.stringify({ machineId: 'machine-exp', sessionName: 'proj--sess' }),
        })
      );
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.sent).toBe(0);
      expect(body.expired).toBe(1);

      // The failed subscription must have been deleted from web.db.
      const { db, pushSubscription } = await import('@/lib/db');
      const { eq } = await import('drizzle-orm');
      const rows = await db
        .select()
        .from(pushSubscription)
        .where(eq(pushSubscription.endpoint, 'https://push.example.com/expired'));
      expect(rows).toHaveLength(0);
    });
  });
});
