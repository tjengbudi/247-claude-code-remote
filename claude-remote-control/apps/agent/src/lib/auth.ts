/**
 * Token verification primitive for the agent-auth token (Story 3.3).
 *
 * - This is the SINGLE token-check primitive — reused by the WS upgrade
 *   handler (server.ts) and any future middleware. Do NOT duplicate the
 *   comparison logic at call sites.
 * - The expected token lives at `config.dashboard?.apiKey` (URL-safe base64;
 *   Story 3.1 contract). May be absent on agents provisioned before 3.2 or
 *   agents that opted out of pairing.
 * - Pure pass/fail: returns false when `presented` is undefined or when no
 *   expected token is provisioned. The call site owns the enforcement-OFF
 *   policy and the "nothing to enforce" accept path (see server.ts).
 */

import { timingSafeEqual } from 'crypto';
import { config } from '../config.js';

/**
 * Verify that `presented` matches the expected agent-auth token.
 *
 * @returns `true` only when both values are present AND byte-equal.
 *   `false` when: `presented` is undefined/empty, the expected token is
 *   absent, or the values differ. Does NOT throw on length mismatch —
 *   timingSafeEqual would RangeError; we length-guard first.
 */
export function verifyAgentToken(presented: string | undefined): boolean {
  const expected = config.dashboard?.apiKey;
  if (!expected || !presented) {
    return false;
  }

  const expectedBuf = Buffer.from(expected);
  const presentedBuf = Buffer.from(presented);

  // Length-guard: timingSafeEqual throws RangeError on unequal lengths.
  if (expectedBuf.byteLength !== presentedBuf.byteLength) {
    return false;
  }

  return timingSafeEqual(expectedBuf, presentedBuf);
}
