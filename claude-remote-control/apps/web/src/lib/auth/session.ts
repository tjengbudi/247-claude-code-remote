/**
 * Session management: 256-bit random tokens, SHA-256 at rest, protocol-conditional cookies.
 *
 * Token lifecycle:
 * - Mint: `crypto.randomBytes(32)` → base64url → raw token (returned to caller)
 * - Store: only `sha256(raw)` in `session.tokenHash` (raw token NEVER persisted)
 * - Validate: hash presented cookie, lookup by tokenHash, reject if missing or expired
 * - Destroy: delete row by tokenHash, clear cookie
 *
 * Cookie:
 * - Always `httpOnly` + `sameSite=lax`
 * - Protocol-conditional: https → `__Host-247_session` + Secure; http → `247_session`
 * - NEVER mirrored to localStorage (server-only)
 *
 * TTL: absolute expiry from creation (no sliding refresh in Track 2).
 */

import { randomBytes, randomUUID, createHash } from 'crypto';
import { cookies } from 'next/headers';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db';
import { session as sessionTable } from '@/lib/db/schema';
import { cookieIsSecure, cookieName, cookieNames } from './cookie-protocol';

// Absolute session lifetime: 30 days (no sliding refresh)
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Mint a new session token and persist its hash.
 *
 * @returns The raw token (caller sets the cookie via `setSessionCookie(rawToken)`)
 */
export async function createSession(userId: string): Promise<string> {
  // 256-bit random token, URL-safe base64
  const raw = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(raw).digest('hex');

  // Fresh session id (anti-fixation)
  const id = randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  // Insert via db Proxy (migrate-on-init guaranteed)
  await db.insert(sessionTable).values({
    id,
    userId,
    tokenHash,
    expiresAt,
    createdAt: now,
  });

  // Set the cookie
  await setSessionCookie(raw);

  return raw;
}

/**
 * Validate a raw session token.
 *
 * @returns `{ id: userId }` if valid, `null` if missing/expired
 */
export async function validateSession(rawToken: string): Promise<{ id: string } | null> {
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');

  // Lookup by tokenHash
  const rows = await db
    .select({ userId: sessionTable.userId, expiresAt: sessionTable.expiresAt })
    .from(sessionTable)
    .where(eq(sessionTable.tokenHash, tokenHash))
    .limit(1);

  if (!rows.length) {
    return null;
  }

  const row = rows[0];
  if (!row) {
    return null;
  }

  // Check absolute expiry
  const now = new Date();
  if (row.expiresAt < now) {
    // Opportunistic cleanup: delete expired row. Guarded — a locked/busy DB
    // must not turn a benign expired token into a 500; the token is invalid
    // either way, so swallow the cleanup error and return null.
    try {
      await db.delete(sessionTable).where(eq(sessionTable.tokenHash, tokenHash));
    } catch {
      // Cleanup is best-effort; the row stays and gets swept on a later hit.
    }
    return null;
  }

  return { id: row.userId };
}

/**
 * Destroy the current session: delete the row and clear the cookie.
 */
export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();

  // Read + clear under BOTH names: the protocol detected when the cookie was
  // set may differ from the current request's, so a single-name lookup could
  // miss the active session (orphaned DB row + cookie that never clears).
  for (const name of cookieNames()) {
    const raw = cookieStore.get(name)?.value;
    if (raw) {
      const tokenHash = createHash('sha256').update(raw).digest('hex');
      // Guarded like validateSession's opportunistic delete: a busy/locked DB
      // must not turn logout into a 500 and leave the cookie uncleared. Clear
      // the cookie regardless so the client is logged out client-side even if
      // the row delete fails (it gets swept later on expiry).
      try {
        await db.delete(sessionTable).where(eq(sessionTable.tokenHash, tokenHash));
      } catch {
        // best-effort row delete; cookie clear below still runs
      }
    }
    cookieStore.delete({ name, path: '/' });
  }
}

/**
 * Set the session cookie with protocol-conditional name/flags.
 * Internal helper used by `createSession`.
 */
async function setSessionCookie(rawToken: string): Promise<void> {
  const cookieStore = await cookies();
  const secure = await cookieIsSecure();
  const name = cookieName(secure);

  cookieStore.set(name, rawToken, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure,
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

// Export TTL for tests
export { SESSION_TTL_MS };
