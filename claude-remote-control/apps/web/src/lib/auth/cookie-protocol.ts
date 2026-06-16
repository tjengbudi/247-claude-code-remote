/**
 * Server-side page-protocol detection for cookie Secure flag and __Host- prefix.
 *
 * WHY NOT use `pageIsSecure()` from utils.ts?
 * That helper reads `window.location.protocol`, which is only available in browser
 * contexts. Cookie-setting runs server-side (route handlers, RSC), where `window`
 * is undefined — so `pageIsSecure()` would always return false on the server,
 * breaking the https path (plain cookie on https = works but misses __Host- prefix).
 *
 * This module provides the server-side equivalent by reading the
 * `x-forwarded-proto` request header (first hop only). When that header is
 * absent it assumes http (LAN direct access) — there is no request-URL
 * fallback because `headers()` does not expose the request URL and the
 * trusted-LAN posture treats a missing header as plain http.
 * It is the SINGLE source for the cookie decision (one rule used 4×: ws/wss in
 * Track 1, cookie Secure, cookie name prefix, D7 WS).
 */

import { headers as getHeaders } from 'next/headers';

// Cookie names for both protocols. Setting uses the protocol-appropriate name;
// reading/deleting must consider BOTH, because the detected protocol can differ
// between the request that set the cookie and a later request (e.g. an
// intermittent proxy toggling x-forwarded-proto). See cookieNames().
const SECURE_COOKIE_NAME = '__Host-247_session';
const PLAIN_COOKIE_NAME = '247_session';

/**
 * Detect if the current request arrived over HTTPS.
 *
 * Checks x-forwarded-proto (trusted-LAN: first hop). If the header is absent
 * (or headers() throws outside a request context), assumes http.
 *
 * Call only from server contexts (route handlers, RSC).
 */
export async function cookieIsSecure(): Promise<boolean> {
  try {
    const h = await getHeaders();
    const xfp = h.get('x-forwarded-proto');
    if (xfp) {
      // First hop only (trusted-LAN, no multi-hop proxy). Case-insensitive:
      // some proxies emit "HTTPS"/"Https".
      const first = xfp.split(',')[0]?.trim().toLowerCase();
      if (first === 'https') return true;
    }
    // x-forwarded-proto not set — assume http (LAN direct access)
    return false;
  } catch {
    // headers() can throw outside request context (e.g. during build).
    // Fail safe: assume http.
    return false;
  }
}

/**
 * Return the session cookie name appropriate for the protocol.
 *
 * - https: `__Host-247_session` (requires Secure + path=/)
 * - http:  `247_session`        (plain name, no Secure flag)
 *
 * __Host- prefix hard-requires Secure, which requires https. On LAN-http,
 * using __Host- + Secure makes the cookie un-settable.
 */
export function cookieName(secure: boolean): string {
  return secure ? SECURE_COOKIE_NAME : PLAIN_COOKIE_NAME;
}

/**
 * Both possible session cookie names, secure name first.
 *
 * Reading and deleting must check both: the protocol detected when the cookie
 * was set may differ from the protocol detected on a later request, so keying
 * the lookup solely on the current request's protocol would silently miss a
 * session stored under the other name (spurious logout / orphaned cookie).
 */
export function cookieNames(): readonly [string, string] {
  return [SECURE_COOKIE_NAME, PLAIN_COOKIE_NAME];
}
