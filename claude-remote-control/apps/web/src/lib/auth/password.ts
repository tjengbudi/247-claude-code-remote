/**
 * Password hashing with argon2id at OWASP floor parameters.
 *
 * Hash format: PHC string with embedded params (argon2 default output).
 * Example: $argon2id$v=19$m=19456,t=2,p=1$...salt...$...hash...
 *
 * Rehash detection: `needsRehash()` checks if stored params are below current floor.
 * Login flow (4.2) will rehash if true.
 */

import { hash, verify } from '@node-rs/argon2';

// OWASP argon2id floor (2023 recommendations)
const HASH_OPTIONS = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

/**
 * Hash a plaintext password with argon2id.
 * Params are embedded in the PHC string automatically.
 */
export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, HASH_OPTIONS);
}

/**
 * Verify a plaintext password against an argon2id hash.
 * Returns false on mismatch or verify error (never throws on bad input).
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await verify(hash, plain);
  } catch {
    return false;
  }
}

/**
 * Check if a stored hash uses params below the current floor.
 * Returns true if the hash should be rehashed (login flow rehashes on success).
 *
 * Parses the PHC string to extract m/t/p params and compares to HASH_OPTIONS.
 */
export function needsRehash(hash: string): boolean {
  // PHC format: $argon2id$v=19$m=19456,t=2,p=1$...
  // The v= segment is OPTIONAL per the PHC spec (a version-less hash is valid),
  // so match it optionally — a sound argon2id hash without v= must not be
  // force-rehashed. Match argon2id ONLY: argon2i/argon2d are weaker variants
  // that must be rehashed up to argon2id even if their m/t/p meet the floor.
  const match = hash.match(/^\$argon2id\$(?:v=\d+\$)?m=(\d+),t=(\d+),p=(\d+)\$/);
  if (!match) {
    // Unknown format or weaker variant (argon2i/argon2d) — assume needs rehash
    return true;
  }

  const [, mStr, tStr, pStr] = match;
  const m = parseInt(mStr!, 10);
  const t = parseInt(tStr!, 10);
  const p = parseInt(pStr!, 10);

  // Below floor if any param is weaker
  return (
    m < HASH_OPTIONS.memoryCost ||
    t < HASH_OPTIONS.timeCost ||
    p < HASH_OPTIONS.parallelism
  );
}
