/**
 * Tests for password.ts — argon2id hash/verify/needsRehash
 */

import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, needsRehash } from '@/lib/auth/password';

describe('password', () => {
  describe('hashPassword + verifyPassword', () => {
    it('round-trip: hash then verify succeeds', async () => {
      const plain = 'correct-horse-battery-staple';
      const hash = await hashPassword(plain);

      // Hash should be a PHC string with embedded params
      expect(hash).toMatch(/^\$argon2id?\$v=\d+\$m=\d+,t=\d+,p=\d+\$/);

      // Verify should succeed
      const ok = await verifyPassword(hash, plain);
      expect(ok).toBe(true);
    });

    it('wrong password returns false', async () => {
      const plain = 'correct-horse-battery-staple';
      const wrong = 'wrong-password';
      const hash = await hashPassword(plain);

      const ok = await verifyPassword(hash, wrong);
      expect(ok).toBe(false);
    });
  });

  describe('needsRehash', () => {
    it('returns false for a hash at the current floor', async () => {
      const plain = 'test-password';
      const hash = await hashPassword(plain);

      // Hash at current floor should not need rehash
      expect(needsRehash(hash)).toBe(false);
    });

    it('returns true for a hash below the current floor', () => {
      // Fabricated hash with weaker params (m=65536 < 19456? No, 65536 > 19456)
      // Use params clearly below floor: m=4096, t=1, p=1
      const weakHash = '$argon2id$v=19$m=4096,t=1,p=1$somesalt$somehash';
      expect(needsRehash(weakHash)).toBe(true);
    });

    it('returns true for unknown format', () => {
      const unknown = 'not-a-phc-string';
      expect(needsRehash(unknown)).toBe(true);
    });

    it('returns false for a version-less PHC hash at the floor (P6)', () => {
      // PHC spec makes the `v=` segment optional. @node-rs/argon2 always emits
      // v=19, but a hash produced elsewhere may omit it — the regex must still
      // parse it rather than force a needless rehash of a sound hash.
      const noVersion = '$argon2id$m=19456,t=2,p=1$somesalt$somehash';
      expect(needsRehash(noVersion)).toBe(false);
    });

    it('returns true for a weaker argon2 variant even at the param floor', () => {
      // argon2i (not argon2id) at floor params: the variant itself is weaker,
      // so it must be flagged for upgrade rather than accepted.
      const argon2iAtFloor = '$argon2i$v=19$m=19456,t=2,p=1$somesalt$somehash';
      expect(needsRehash(argon2iAtFloor)).toBe(true);
    });

    it('returns true for argon2d at the param floor', () => {
      const argon2dAtFloor = '$argon2d$v=19$m=19456,t=2,p=1$somesalt$somehash';
      expect(needsRehash(argon2dAtFloor)).toBe(true);
    });
  });
});
