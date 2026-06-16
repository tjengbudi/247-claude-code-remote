/**
 * First-run bootstrap: WEB_AUTH_SECRET provisioning and owner-existence check.
 *
 * Secret provisioning (AC5):
 * - Env-first: read `process.env.WEB_AUTH_SECRET` (Docker secret / compose env)
 * - Min-entropy enforcement: reject too-short env values
 * - Native/dev fallback: generate 32 bytes, persist in `web.db` (user_settings table)
 * - Fail-closed in prod: throw if neither env nor persisted value exists
 * - Memoized: stable per process
 *
 * Storage choice (AC5 Task 5):
 * Reuses `user_settings` table with reserved owner `__system__` and key `web_auth_secret`.
 * Avoids schema change (no drizzle migration) in this additive story.
 *
 * Owner existence (AC6):
 * `ownerExists()` returns true iff at least one `user` row exists.
 * Consumed by 4.2's `GET /api/auth/session` and 4.3's two-UI-state branch.
 *
 * Migration-before-use (AC6):
 * All DB access goes through the `db` Proxy / `getDb()`, which runs `migrate()` on init.
 * No second migration mechanism.
 */

import { randomBytes, randomUUID } from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '@/lib/db';
import { user, userSettings } from '@/lib/db/schema';

// Reserved owner/key for WEB_AUTH_SECRET in user_settings table
const SYSTEM_OWNER = '__system__';
const SECRET_KEY = 'web_auth_secret';

// Min entropy: 32 bytes = 256 bits (reject env values shorter than this)
const MIN_SECRET_BYTES = 32;

// Memoize so the secret is stable per process
let _cachedSecret: string | null = null;

/**
 * Get the WEB_AUTH_SECRET, provisioning if needed.
 *
 * Priority:
 * 1. `process.env.WEB_AUTH_SECRET` (enforce min length if set)
 * 2. Persisted secret in `web.db` (user_settings table)
 * 3. Generate + persist (native/dev only)
 * 4. Throw in prod if neither env nor persisted
 */
export async function getWebAuthSecret(): Promise<string> {
  if (_cachedSecret) {
    return _cachedSecret;
  }

  // Env-first
  const envSecret = process.env.WEB_AUTH_SECRET;
  if (envSecret) {
    // Min-entropy enforcement: reject too-short values
    if (Buffer.byteLength(envSecret, 'utf8') < MIN_SECRET_BYTES) {
      throw new Error(
        `[bootstrap] WEB_AUTH_SECRET env value is too short ` +
          `(min ${MIN_SECRET_BYTES} bytes, got ${Buffer.byteLength(envSecret, 'utf8')})`
      );
    }
    _cachedSecret = envSecret;
    return envSecret;
  }

  // Try persisted value
  const persisted = await readPersistedSecret();
  if (persisted) {
    // A persisted value must clear the same entropy bar as an env value —
    // a short/empty/corrupted row must not silently become the signing secret.
    if (Buffer.byteLength(persisted, 'utf8') < MIN_SECRET_BYTES) {
      throw new Error(
        `[bootstrap] persisted WEB_AUTH_SECRET is too short ` +
          `(min ${MIN_SECRET_BYTES} bytes, got ${Buffer.byteLength(persisted, 'utf8')})`
      );
    }
    _cachedSecret = persisted;
    return persisted;
  }

  // No env, no persisted — generate (dev/native only)
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[bootstrap] WEB_AUTH_SECRET is not set in production. ' +
        'Set process.env.WEB_AUTH_SECRET or ensure a persisted secret exists.'
    );
  }

  // Generate 32 bytes, persist, return.
  // Race-safe: two concurrent first-runs would each generate a distinct secret.
  // onConflictDoNothing lets only the first insert win (UNIQUE on userId+key);
  // we then re-read so every caller converges on the single stored value rather
  // than caching divergent secrets.
  const generated = randomBytes(32).toString('hex');
  await db
    .insert(userSettings)
    .values({
      id: randomUUID(),
      userId: SYSTEM_OWNER,
      key: SECRET_KEY,
      value: generated,
    })
    .onConflictDoNothing({
      target: [userSettings.userId, userSettings.key],
    });

  const winner = (await readPersistedSecret()) ?? generated;
  _cachedSecret = winner;
  return winner;
}

/**
 * Read the persisted WEB_AUTH_SECRET row, or null if absent.
 */
async function readPersistedSecret(): Promise<string | null> {
  const rows = await db
    .select({ value: userSettings.value })
    .from(userSettings)
    .where(and(eq(userSettings.userId, SYSTEM_OWNER), eq(userSettings.key, SECRET_KEY)))
    .limit(1);

  if (rows.length > 0 && rows[0]) {
    return rows[0].value;
  }
  return null;
}

/**
 * Check if at least one user exists (registration closed by default after first owner).
 */
export async function ownerExists(): Promise<boolean> {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .limit(1);

  return rows.length > 0;
}

// Export for testing (reset memoization)
export function _resetSecretCache(): void {
  _cachedSecret = null;
}
