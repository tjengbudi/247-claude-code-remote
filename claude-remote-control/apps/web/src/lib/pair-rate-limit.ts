/**
 * In-memory rate limiter for pairing code lookups.
 *
 * Tracks failed-lookup counts per client IP in a 10-minute fixed window.
 * Returns whether the caller is over the 5-failure limit (HTTP 429).
 *
 * Single-instance assumption (NFR6): the self-host dashboard runs a single
 * web process, so an in-memory map is correct. A successful lookup does NOT
 * consume the budget — only failures (not found / expired) increment the counter.
 */

const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_FAILURES = 5;

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

// Sweep expired buckets every minute, same shape as pairing-codes cleanup.
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of buckets.entries()) {
      if (bucket.windowStart + WINDOW_MS < now) {
        buckets.delete(ip);
      }
    }
  }, 60 * 1000);
}

/**
 * Extract client IP from request headers.
 * Prefers first hop of x-forwarded-for (trusted-LAN assumption), falls back to x-real-ip.
 *
 * KNOWN LIMITATION (trusted-LAN, NFR6): when the dashboard is reached directly
 * with no reverse proxy, neither header is set and all callers collapse into the
 * single 'unknown' bucket — so 5 failed lookups from any one device rate-limit
 * the whole LAN. Acceptable for the trusted-LAN posture (the rate limit guards a
 * 6-digit-code brute-force, not mutual isolation); revisit if the dashboard is
 * ever fronted by a proxy or exposed beyond a trusted LAN.
 */
export function getClientIP(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp;
  return 'unknown';
}

/**
 * Check whether the given IP is over the failure budget.
 * Returns true if the caller should be denied (429).
 */
export function isRateLimited(ip: string): boolean {
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
 * Record a failed lookup for the given IP. Resets the window if it has expired.
 */
export function recordFailure(ip: string): void {
  const now = Date.now();
  const bucket = buckets.get(ip);
  if (!bucket || bucket.windowStart + WINDOW_MS < now) {
    buckets.set(ip, { count: 1, windowStart: now });
    return;
  }
  bucket.count += 1;
}

/**
 * Reset the failure bucket for an IP on successful lookup.
 * A legit user retrying a typo then succeeding isn't locked out by their own success.
 */
export function resetFailures(ip: string): void {
  buckets.delete(ip);
}

// Export for testing
export { buckets, WINDOW_MS, MAX_FAILURES };
