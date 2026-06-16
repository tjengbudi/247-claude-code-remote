import { NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { hashPassword, createSession } from '@/lib/auth';
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

    // Password floor: 8 characters (sole owner-password entry point)
    if (password.length < 8) {
      return NextResponse.json(
        { error: 'Password must be at least 8 characters' },
        { status: 400 }
      );
    }

    // Guard double-owner: use a transaction with WHERE NOT EXISTS check
    // better-sqlite3 transactions are synchronous, so hash password BEFORE the transaction
    const passwordHash = await hashPassword(password);

    // Race-safe insert: wrap check+insert in a transaction
    // better-sqlite3 transactions are synchronous (D1) — use sync callback
    const result = db.transaction(() => {
      // Check if owner already exists (sync query inside transaction)
      const existing = db.select({ id: user.id }).from(user).limit(1).all();
      if (existing.length > 0) {
        throw new Error('Owner already exists');
      }

      // Insert the new owner (sync run)
      const id = randomUUID();
      db.insert(user).values({
        id,
        username,
        email: null,
        passwordHash,
      }).run();

      return { id };
    });

    // Auto-login (best-effort). The owner row is already committed; a session
    // failure here must NOT surface as 500 — that would strand the owner (retry
    // hits the 409 guard, never logs in). Fall back to a sessionless 201 so the
    // client proceeds to login instead.
    try {
      await createSession(result.id);
    } catch {
      // owner created, session not minted — client redirects to login
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
    if (err instanceof Error && err.message === 'Owner already exists') {
      return NextResponse.json(
        { error: 'Owner already exists' },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: 'Bootstrap failed' },
      { status: 500 }
    );
  }
}
