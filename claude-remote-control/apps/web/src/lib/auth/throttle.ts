/**
 * In-memory login throttle (mirrors pair-rate-limit.ts pattern).
 *
 * Single-instance assumption (NFR6): the self-host dashboard runs a single web
 * process, so an in-memory map is correct. A multi-instance deploy would need
 * shared state (Redis, etc.).
 *
 * Tracks failed-login counts per client IP in a 15-minute fixed window.
 * A successful login does NOT consume the budget — only failures increment.
 */

import { getClientIP } from '@/lib/pair-rate-limit';

// Login-specific limits: 10 failures per 15-minute window
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FAILURES = 10;

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

// Sweep expired buckets every minute (guarded for non-Node contexts).
// unref() so this timer never keeps the process alive (clean exit in test/CLI).
if (typeof setInterval !== 'undefined') {
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of buckets.entries()) {
      if (bucket.windowStart + WINDOW_MS < now) {
        buckets.delete(ip);
      }
    }
  }, 60 * 1000);
  sweep.unref?.();
}

/**
 * Check whether the given IP is over the login failure budget.
 * Returns true if the caller should be denied (429).
 */
export function isLoginRateLimited(ip: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket) return false;
  if (bucket.windowStart + WINDOW_MS < now) {
    // Window expired — clean up, not limited.
    buckets.delete(ip);
    return false;
  }
  return bucket.count >= MAX_FAILURES;
}

/**
 * Record a failed login attempt for the given IP.
 * Resets the window if it has expired.
 */
export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || bucket.windowStart + WINDOW_MS < now) {
    buckets.set(ip, { count: 1, windowStart: now });
    return;
  }
  bucket.count += 1;
}

/**
 * Reset the failure bucket for an IP on successful login.
 * A legit user retrying a typo then succeeding isn't locked out by their own success.
 */
export function resetLoginFailures(ip: string): void {
  buckets.delete(ip);
}

// Re-export getClientIP for convenience (login routes import from here)
export { getClientIP };

// Export for testing
export { buckets, WINDOW_MS, MAX_FAILURES };
