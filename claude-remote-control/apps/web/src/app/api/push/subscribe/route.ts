import { NextResponse } from 'next/server';
import { db, pushSubscription } from '@/lib/db';
import { and, eq } from 'drizzle-orm';
import { requireUser, AuthError } from '@/lib/auth';

/**
 * POST /api/push/subscribe
 * Subscribe to push notifications (requires authentication)
 */
export async function POST(req: Request) {
  try {
    const { user } = await requireUser();

    const body = await req.json();
    const { subscription, userAgent } = body;

    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
      return NextResponse.json({ error: 'Invalid subscription' }, { status: 400 });
    }

    const id = crypto.randomUUID();

    // Upsert subscription (update if endpoint already exists)
    const [result] = await db
      .insert(pushSubscription)
      .values({
        id,
        userId: user.id,
        endpoint: subscription.endpoint,
        p256dh: subscription.keys.p256dh,
        auth: subscription.keys.auth,
        userAgent: userAgent || req.headers.get('user-agent'),
      })
      .onConflictDoUpdate({
        target: pushSubscription.endpoint,
        set: {
          userId: user.id,
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
          userAgent: userAgent || req.headers.get('user-agent'),
        },
      })
      .returning();

    return NextResponse.json({ success: true, id: result.id });
  } catch (error) {
    // Option A: discriminable 401 before generic 500
    if (error instanceof AuthError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: error.status });
    }
    return NextResponse.json({ error: 'Failed to subscribe' }, { status: 500 });
  }
}

/**
 * DELETE /api/push/subscribe
 * Unsubscribe from push notifications
 */
export async function DELETE(req: Request) {
  try {
    const { user } = await requireUser();

    const body = await req.json();
    const { endpoint } = body;

    if (!endpoint) {
      return NextResponse.json({ error: 'Endpoint required' }, { status: 400 });
    }

    // Scope delete to the authenticated user so one user cannot unsubscribe
    // another user's endpoint (endpoint is globally UNIQUE, so id alone is not
    // owner-safe).
    await db
      .delete(pushSubscription)
      .where(and(eq(pushSubscription.endpoint, endpoint), eq(pushSubscription.userId, user.id)));

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: error.status });
    }
    return NextResponse.json({ error: 'Failed to unsubscribe' }, { status: 500 });
  }
}
