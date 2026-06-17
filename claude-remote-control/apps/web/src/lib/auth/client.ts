'use client';

import { useCallback } from 'react';

interface SessionUser {
  id: string;
  name: string;
  email: string | null;
}

interface SessionResult {
  data: {
    user: SessionUser | null;
  };
  // boolean from a healthy response; null when the owner state is UNKNOWN
  // (network/HTTP/parse failure). Consumers MUST treat null as "don't know" —
  // never as "no owner" — so a transient blip can't trigger a second-owner
  // bootstrap. [Source: code-review BS1]
  ownerExists: boolean | null;
}

function isSessionUser(v: unknown): v is SessionUser {
  if (typeof v !== 'object' || v === null) return false;
  const u = v as Record<string, unknown>;
  return (
    typeof u.id === 'string' &&
    typeof u.name === 'string' &&
    (u.email === null || typeof u.email === 'string')
  );
}

const UNKNOWN: SessionResult = { data: { user: null }, ownerExists: null };

/**
 * Auth hook for consuming the local auth API routes.
 * Returns stable useCallback references for getSession and signOut so consumers
 * can destructure at component top level and call inside useEffect/handlers.
 *
 * This is a standalone hook — no provider/context required in 4.2.
 * The AuthProvider swap is 4.4's job.
 */
export function useAuth() {
  const getSession = useCallback(async (): Promise<SessionResult> => {
    try {
      const res = await fetch('/api/auth/session');
      if (!res.ok) {
        return UNKNOWN;
      }
      const json: unknown = await res.json();
      // res.ok does not guarantee body shape — validate before trusting it.
      if (typeof json !== 'object' || json === null) {
        return UNKNOWN;
      }
      const body = json as Record<string, unknown>;
      const data = body.data as Record<string, unknown> | undefined;
      const rawUser = data?.user;
      const user = isSessionUser(rawUser) ? rawUser : null;
      const ownerExists =
        typeof body.ownerExists === 'boolean' ? body.ownerExists : null;
      return { data: { user }, ownerExists };
    } catch {
      return UNKNOWN;
    }
  }, []);

  const signOut = useCallback(async () => {
    // Swallow network/HTTP failures so consumers can rely on signOut() never
    // throwing — the post-logout window.location.reload() must always run, and
    // a failed logout is recovered by the next session check. [Source: 4.4 review #2]
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // ignore — reload + session re-check is the recovery path
    }
  }, []);

  return { getSession, signOut };
}
