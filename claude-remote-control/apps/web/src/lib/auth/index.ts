/**
 * Auth seam entry point — single consistent local-auth interface for all routes/pages.
 *
 * Exports:
 * - `requireUser()`: route-handler guard, arg-less (reads cookies internally),
 *   returns `{ user: { id } }` on success or throws `AuthError` (discriminable 401)
 * - `getCurrentUser()`: RSC/page helper, non-throwing, returns `{ id } | null`
 * - `createSession(userId)`: mint token + set cookie (re-exported from session.ts)
 * - `destroySession()`: delete row + clear cookie (re-exported from session.ts)
 *
 * Call shape matches existing `const { user } = await neonAuth()` so the 4.4 swap
 * is import-and-call-shape only, not a logic rewrite.
 *
 * Discriminable-401 mechanism:
 * `requireUser` throws `AuthError` (a typed sentinel). Route handlers catch it
 * and return `NextResponse.json({ error: 'Unauthorized' }, { status: 401 })`.
 * The route's generic catch-all still handles other errors as 500.
 */

import { cookies } from 'next/headers';
import { validateSession } from './session';
import { cookieNames } from './cookie-protocol';

// Re-export session primitives
export { createSession, destroySession } from './session';

// Re-export password/bootstrap/throttle for completeness (routes import from @/lib/auth)
export { hashPassword, verifyPassword, needsRehash } from './password';
export { getWebAuthSecret, ownerExists, getOwnerUserId } from './bootstrap';
export { isLoginRateLimited, recordLoginFailure, resetLoginFailures, getClientIP } from './throttle';

/**
 * Discriminable auth error thrown by `requireUser` when no valid session exists.
 * Route handlers catch this and return 401 (not swallowed by generic 500).
 */
export class AuthError extends Error {
  readonly status = 401;
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Get the current user from the session cookie (non-throwing).
 *
 * Use in RSC/pages where a logged-out state is valid (returns null).
 * Use `requireUser` in route handlers where auth is mandatory.
 */
export async function getCurrentUser(): Promise<{ id: string } | null> {
  const cookieStore = await cookies();
  // Read under both names: the protocol detected when the cookie was set may
  // differ from the current request's, so a single-name lookup could miss it.
  // Validate each present token and return the first VALID one — breaking on
  // mere presence would let a stale cookie under one name mask a live session
  // under the other (e.g. after an https↔http flip leaves both cookies set).
  for (const name of cookieNames()) {
    const raw = cookieStore.get(name)?.value;
    if (!raw) continue;
    const user = await validateSession(raw);
    if (user) return user;
  }

  return null;
}

/**
 * Route-handler guard: require a valid session, throw `AuthError` (401) if absent.
 *
 * Arg-less (reads `cookies()` internally, like `neonAuth()`). The optional `req`
 * param is kept for forward-compat but never required — arg-less `GET()` handlers
 * in 4.4 must not need to add a param.
 *
 * @returns `{ user: { id } }` on success (matches `neonAuth()` destructure shape)
 * @throws {AuthError} if no valid session (route maps to 401)
 */
export async function requireUser(_req?: Request): Promise<{ user: { id: string } }> {
  const user = await getCurrentUser();

  if (!user) {
    throw new AuthError();
  }

  return { user };
}
