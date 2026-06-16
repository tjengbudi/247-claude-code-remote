import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import {
  verifyPassword,
  needsRehash,
  hashPassword,
  createSession,
  isLoginRateLimited,
  recordLoginFailure,
  resetLoginFailures,
  getClientIP,
} from '@/lib/auth';
import { db } from '@/lib/db';
import { user } from '@/lib/db/schema';

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Missing username or password' },
      { status: 400 }
    );
  }

  try {
    const { username, password } =
      (body as { username?: unknown; password?: unknown }) ?? {};

    // Validate required fields (must be non-empty strings)
    if (
      typeof username !== 'string' ||
      typeof password !== 'string' ||
      !username ||
      !password
    ) {
      return NextResponse.json(
        { error: 'Missing username or password' },
        { status: 400 }
      );
    }

    // Check throttle before any DB/argon2 work
    const ip = getClientIP(req);
    if (isLoginRateLimited(ip)) {
      return NextResponse.json(
        { error: 'Too many attempts' },
        { status: 429 }
      );
    }

    // Look up user by username
    const rows = await db
      .select()
      .from(user)
      .where(eq(user.username, username))
      .limit(1);

    const row = rows[0];

    // Generic error for no user or wrong password (no enumeration)
    if (!row || !row.passwordHash || !(await verifyPassword(row.passwordHash, password))) {
      recordLoginFailure(ip);
      return NextResponse.json(
        { error: 'Invalid credentials' },
        { status: 401 }
      );
    }

    // Success: reset failures
    resetLoginFailures(ip);

    // Rehash-on-login if needed (guarded — never block login)
    if (needsRehash(row.passwordHash)) {
      try {
        const newHash = await hashPassword(password);
        await db
          .update(user)
          .set({ passwordHash: newHash, updatedAt: new Date() })
          .where(eq(user.id, row.id));
      } catch {
        // Rehash failure must not block login
      }
    }

    // Create session (sets cookie internally)
    await createSession(row.id);

    return NextResponse.json({
      data: {
        user: {
          id: row.id,
          name: row.username,
          email: row.email ?? null,
        },
      },
    });
  } catch {
    return NextResponse.json(
      { error: 'Login failed' },
      { status: 500 }
    );
  }
}
