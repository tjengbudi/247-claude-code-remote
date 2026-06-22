import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { hashPassword, createSession } from '@/lib/auth';
import { db } from '@/lib/db';
import { user } from '@/lib/db/schema';

/**
 * POST /api/auth/signup - Register an additional account (multi-user).
 *
 * Unlike /api/auth/bootstrap (first-run owner, rejects a second account), this
 * route is always open: anyone may register as long as the username is free.
 * The only guard is username uniqueness (the `user.username` UNIQUE index backs
 * this at the DB level; the in-transaction check turns races into a clean 409).
 */
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
    const { username: rawUsername, password } =
      (body as { username?: unknown; password?: unknown }) ?? {};

    // Validate required fields (must be non-empty strings)
    if (
      typeof rawUsername !== 'string' ||
      typeof password !== 'string' ||
      !rawUsername.trim() ||
      !password
    ) {
      return NextResponse.json(
        { error: 'Missing username or password' },
        { status: 400 }
      );
    }

    const username = rawUsername.trim();

    // Password floor: 8 characters (mirror bootstrap)
    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      );
    }

    // better-sqlite3 transactions are synchronous, so hash BEFORE the transaction
    const passwordHash = await hashPassword(password);

    // Race-safe insert: wrap check+insert in a transaction. The username UNIQUE
    // index is the ultimate backstop; this check makes the conflict a clean 409.
    const result = db.transaction(() => {
      const existing = db
        .select({ id: user.id })
        .from(user)
        .where(eq(user.username, username))
        .limit(1)
        .all();
      if (existing.length > 0) {
        throw new Error('Username already taken');
      }

      const id = randomUUID();
      db.insert(user).values({
        id,
        username,
        email: null,
        passwordHash,
      }).run();

      return { id };
    });

    // Auto-login (best-effort). The user row is already committed; a session
    // failure here must NOT surface as 500 — that would strand the account
    // (retry hits the 409 guard, never logs in). Fall back to a sessionless 201
    // so the client proceeds to login instead.
    try {
      await createSession(result.id);
    } catch {
      // user created, session not minted — client redirects to login
    }

    return NextResponse.json(
      {
        data: {
          user: {
            id: result.id,
            name: username,
            email: null,
          },
        },
      },
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof Error && err.message === 'Username already taken') {
      return NextResponse.json(
        { error: 'Username already taken' },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: 'Signup failed' },
      { status: 500 }
    );
  }
}
