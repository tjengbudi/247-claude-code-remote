import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getCurrentUser, ownerExists, getOwnerUserId } from '@/lib/auth';
import { db } from '@/lib/db';
import { user } from '@/lib/db/schema';

export async function GET() {
  try {
    const current = await getCurrentUser();

    if (!current) {
      return NextResponse.json({
        data: { user: null },
        ownerExists: await ownerExists(),
      });
    }

    // Fetch the user row by id
    const rows = await db
      .select()
      .from(user)
      .where(eq(user.id, current.id))
      .limit(1);

    const row = rows[0];

    // If the row is missing (deleted mid-session), treat as logged-out
    if (!row) {
      return NextResponse.json({
        data: { user: null },
        ownerExists: await ownerExists(),
      });
    }

    // isOwner: this user is the dashboard owner (first/bootstrap account).
    // Used for per-user agent-session view isolation (owner sees untagged
    // legacy/CLI sessions; other users see only their own).
    const ownerId = await getOwnerUserId();

    return NextResponse.json({
      data: {
        user: {
          id: row.id,
          name: row.username,
          email: row.email ?? null,
        },
      },
      ownerExists: true,
      isOwner: ownerId === row.id,
    });
  } catch {
    return NextResponse.json(
      { error: 'Session check failed' },
      { status: 500 }
    );
  }
}
