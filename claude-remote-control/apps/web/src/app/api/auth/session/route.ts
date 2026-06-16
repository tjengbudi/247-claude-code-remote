import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { getCurrentUser, ownerExists } from '@/lib/auth';
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

    return NextResponse.json({
      data: {
        user: {
          id: row.id,
          name: row.username,
          email: row.email ?? null,
        },
      },
      ownerExists: true,
    });
  } catch {
    return NextResponse.json(
      { error: 'Session check failed' },
      { status: 500 }
    );
  }
}
