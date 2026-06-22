'use client';

import { useState, useEffect, useRef, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams, useParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useAuth } from '@/lib/auth/client';
import { Button } from '@/components/ui/button';

type Phase = 'loading' | 'login' | 'bootstrap' | 'signup' | 'redirecting';

// Accept only same-origin relative paths. Reject `//evil`, `/\evil`, `https://...`.
// `connect/page.tsx` passes an absolute URL — we parse it and only honor the
// pathname+search when the origin matches. Anything else falls back to `/`.
function safeReturnTo(raw: string): string {
  if (!raw) return '/';
  // Relative path: single leading slash, NOT followed by `/` or `\`
  // (browsers normalize `/\` → `//`, so a backslash is a protocol-relative
  // open-redirect vector). Query/fragment content is irrelevant for a
  // single-slash path — it is always same-origin.
  if (/^\/(?![/\\])/.test(raw)) {
    return raw;
  }
  // Absolute URL — only honor if same origin
  try {
    const url = new URL(raw);
    if (url.origin === window.location.origin) {
      return url.pathname + url.search;
    }
  } catch {
    // fall through
  }
  return '/';
}

// Parse a JSON body without throwing. Returns null on parse failure OR when the
// body is literal JSON `null` — callers must use optional access on the result.
async function safeJson(res: Response): Promise<{ error?: unknown } | null> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

interface FormFieldError {
  field: 'username' | 'password' | 'confirmPassword';
  message: string;
}

function AuthContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const params = useParams();
  const { getSession } = useAuth();

  // The [path] catch-all segment drives form selection by URL: `/auth/signup`
  // always offers registration (multi-user), while `/auth/sign-in` keeps the
  // session-driven login/first-run-bootstrap behavior.
  const pathSeg = Array.isArray(params?.path) ? params.path[0] : params?.path;
  const isSignupRoute = pathSeg === 'signup';

  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState<string | null>(null);
  const [unknownNotice, setUnknownNotice] = useState(false);
  const [fieldError, setFieldError] = useState<FormFieldError | null>(null);
  const [pending, setPending] = useState(false);

  // Login fields
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');

  // Bootstrap fields
  const [bsUsername, setBsUsername] = useState('');
  const [bsPassword, setBsPassword] = useState('');
  const [bsConfirm, setBsConfirm] = useState('');

  // Refs for focus-to-first-error
  const loginUsernameRef = useRef<HTMLInputElement>(null);
  const loginPasswordRef = useRef<HTMLInputElement>(null);
  const bsUsernameRef = useRef<HTMLInputElement>(null);
  const bsPasswordRef = useRef<HTMLInputElement>(null);
  const bsConfirmRef = useRef<HTMLInputElement>(null);

  // Tracks mount state so async handlers (session fetch, submit) never setState
  // or navigate after the component has unmounted.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Single source of truth for the session→phase branch, shared by the mount
  // effect and the UNKNOWN retry. Scope-trap #2: `null` is UNKNOWN, NEVER
  // bootstrap. All setState/navigation is unmount-guarded by the caller.
  const applySession = useCallback(
    (data: { user: unknown }, ownerExists: boolean | null) => {
      if (!mountedRef.current) return;
      if (data.user) {
        setPhase('redirecting');
        router.replace('/');
        return;
      }
      // `/auth/signup` is always open for additional accounts, regardless of
      // whether an owner already exists. (First-run bootstrap stays on the
      // sign-in route via the ownerExists branch below.)
      if (isSignupRoute) {
        setPhase('signup');
        return;
      }
      if (ownerExists === false) {
        setPhase('bootstrap');
      } else if (ownerExists === true) {
        setPhase('login');
      } else {
        // null — network/HTTP/parse failure. Show login + retry notice.
        setPhase('login');
        setUnknownNotice(true);
      }
    },
    [router, isSignupRoute],
  );

  // Initial session fetch
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const { data, ownerExists } = await getSession();
      if (cancelled) return;
      applySession(data, ownerExists);
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [getSession, applySession]);

  const retrySession = async () => {
    if (pending) return; // guard against double-click before re-render
    setPending(true);
    setUnknownNotice(false);
    setPhase('loading');
    setError(null);
    try {
      const { data, ownerExists } = await getSession();
      applySession(data, ownerExists);
    } finally {
      if (mountedRef.current) setPending(false);
    }
  };

  // ─── Login submit ────────────────────────────────────────────────────────────
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldError(null);
    setUnknownNotice(false);

    // Basic client validation (login has no password-length floor, mirror server)
    if (!loginUsername.trim() || !loginPassword) {
      if (!loginUsername.trim()) {
        setFieldError({ field: 'username', message: 'Username is required' });
        loginUsernameRef.current?.focus();
      } else {
        setFieldError({ field: 'password', message: 'Password is required' });
        loginPasswordRef.current?.focus();
      }
      return;
    }

    setPending(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUsername.trim(), password: loginPassword }),
      });
      if (!mountedRef.current) return;
      if (res.ok) {
        // Stay on the spinner through navigation so the form can't be
        // re-submitted in the brief window before the route changes.
        setPhase('redirecting');
        setUnknownNotice(false);
        const raw = searchParams.get('returnTo');
        router.replace(safeReturnTo(raw ?? ''));
        return;
      } else if (res.status === 401) {
        setError('Invalid username or password');
      } else if (res.status === 429) {
        setError('Too many attempts. Try again later.');
      } else if (res.status === 400) {
        const body = await safeJson(res);
        const msg =
          typeof body?.error === 'string' ? body.error : 'Missing username or password';
        setFieldError({ field: 'username', message: msg });
        loginUsernameRef.current?.focus();
      } else {
        setError('Something went wrong. Please try again.');
      }
    } catch {
      if (mountedRef.current) setError('Something went wrong. Please try again.');
    } finally {
      if (mountedRef.current) setPending(false);
    }
  };

  // ─── Bootstrap submit ────────────────────────────────────────────────────────
  const handleBootstrap = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldError(null);

    // Client validation (mirror server: non-blank username, ≥8 chars, confirm match)
    if (!bsUsername.trim()) {
      setFieldError({ field: 'username', message: 'Username is required' });
      bsUsernameRef.current?.focus();
      return;
    }
    if (bsPassword.length < 8) {
      setFieldError({
        field: 'password',
        message: 'Password must be at least 8 characters',
      });
      bsPasswordRef.current?.focus();
      return;
    }
    if (bsConfirm !== bsPassword) {
      setFieldError({
        field: 'confirmPassword',
        message: 'Passwords do not match',
      });
      bsConfirmRef.current?.focus();
      return;
    }

    setPending(true);
    try {
      const res = await fetch('/api/auth/bootstrap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: bsUsername.trim(), password: bsPassword }),
      });
      if (!mountedRef.current) return;
      if (res.ok) {
        // Cookie already set (best-effort auto-login); always redirect to /.
        // Stay on the spinner through navigation (no re-submit window).
        setPhase('redirecting');
        router.replace('/');
        return;
      } else if (res.status === 409) {
        setError('Owner already exists');
        setPhase('login');
      } else if (res.status === 400) {
        const body = await safeJson(res);
        const msg =
          typeof body?.error === 'string' ? body.error : 'Missing username or password';
        // Map server 400 messages to fields: password-length goes to the
        // password field, everything else to username.
        if (/password/i.test(msg) && /\d/.test(msg)) {
          setFieldError({ field: 'password', message: msg });
          bsPasswordRef.current?.focus();
        } else {
          setFieldError({ field: 'username', message: msg });
          bsUsernameRef.current?.focus();
        }
      } else {
        setError('Something went wrong. Please try again.');
      }
    } catch {
      if (mountedRef.current) setError('Something went wrong. Please try again.');
    } finally {
      if (mountedRef.current) setPending(false);
    }
  };

  // ─── Signup submit ───────────────────────────────────────────────────────────
  // Mirrors handleBootstrap (same client validation + bs* fields, which never
  // render alongside the signup form) but hits /api/auth/signup and treats a
  // 409 as a username-taken field error instead of flipping to login.
  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldError(null);

    // Client validation (mirror server: non-blank username, ≥8 chars, confirm match)
    if (!bsUsername.trim()) {
      setFieldError({ field: 'username', message: 'Username is required' });
      bsUsernameRef.current?.focus();
      return;
    }
    if (bsPassword.length < 8) {
      setFieldError({
        field: 'password',
        message: 'Password must be at least 8 characters',
      });
      bsPasswordRef.current?.focus();
      return;
    }
    if (bsConfirm !== bsPassword) {
      setFieldError({
        field: 'confirmPassword',
        message: 'Passwords do not match',
      });
      bsConfirmRef.current?.focus();
      return;
    }

    setPending(true);
    try {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: bsUsername.trim(), password: bsPassword }),
      });
      if (!mountedRef.current) return;
      if (res.ok) {
        // Cookie already set (best-effort auto-login); honor returnTo like login.
        setPhase('redirecting');
        router.replace(safeReturnTo(searchParams.get('returnTo') ?? ''));
        return;
      } else if (res.status === 409) {
        setFieldError({ field: 'username', message: 'Username already taken' });
        bsUsernameRef.current?.focus();
      } else if (res.status === 400) {
        const body = await safeJson(res);
        const msg =
          typeof body?.error === 'string' ? body.error : 'Missing username or password';
        // Password-length messages go to the password field, everything else
        // to username (same mapping as handleBootstrap).
        if (/password/i.test(msg) && /\d/.test(msg)) {
          setFieldError({ field: 'password', message: msg });
          bsPasswordRef.current?.focus();
        } else {
          setFieldError({ field: 'username', message: msg });
          bsUsernameRef.current?.focus();
        }
      } else {
        setError('Something went wrong. Please try again.');
      }
    } catch {
      if (mountedRef.current) setError('Something went wrong. Please try again.');
    } finally {
      if (mountedRef.current) setPending(false);
    }
  };

  // ─── Spinner for loading / redirecting ───────────────────────────────────────
  if (phase === 'loading' || phase === 'redirecting') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#0a0a10] to-[#1a1a2e]">
        <Loader2 className="h-12 w-12 animate-spin text-orange-500" />
      </div>
    );
  }

  // ─── Bootstrap form ──────────────────────────────────────────────────────────
  if (phase === 'bootstrap') {
    const errorId = 'auth-error';
    const hasError = error !== null || fieldError !== null;
    return (
      <div className="bg-background flex min-h-screen items-center justify-center">
        <div className="w-full max-w-md p-8">
          <h1 className="mb-8 text-center text-2xl font-bold">247</h1>
          <h2 className="mb-2 text-center text-lg font-semibold">Create your account</h2>
          <p className="mb-6 text-center text-sm text-white/60">
            First time here — set up your owner account to get started.
          </p>
          <form onSubmit={handleBootstrap} noValidate className="space-y-4">
            <div>
              <label
                htmlFor="bs-username"
                className="mb-1 block text-sm font-medium text-white/80"
              >
                Username
              </label>
              <input
                id="bs-username"
                ref={bsUsernameRef}
                type="text"
                name="username"
                autoComplete="username"
                value={bsUsername}
                onChange={(e) => setBsUsername(e.target.value)}
                aria-invalid={fieldError?.field === 'username' ? 'true' : undefined}
                aria-describedby={
                  fieldError?.field === 'username' ? errorId : undefined
                }
                className="w-full rounded-md border border-white/20 bg-white/5 px-3 py-2 text-white placeholder-white/40 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
              />
            </div>
            <div>
              <label
                htmlFor="bs-password"
                className="mb-1 block text-sm font-medium text-white/80"
              >
                Password
              </label>
              <input
                id="bs-password"
                ref={bsPasswordRef}
                type="password"
                name="password"
                autoComplete="new-password"
                value={bsPassword}
                onChange={(e) => setBsPassword(e.target.value)}
                aria-invalid={fieldError?.field === 'password' ? 'true' : undefined}
                aria-describedby={
                  fieldError?.field === 'password' ? errorId : undefined
                }
                className="w-full rounded-md border border-white/20 bg-white/5 px-3 py-2 text-white placeholder-white/40 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
              />
            </div>
            <div>
              <label
                htmlFor="bs-confirm"
                className="mb-1 block text-sm font-medium text-white/80"
              >
                Confirm password
              </label>
              <input
                id="bs-confirm"
                ref={bsConfirmRef}
                type="password"
                name="confirmPassword"
                autoComplete="new-password"
                value={bsConfirm}
                onChange={(e) => setBsConfirm(e.target.value)}
                aria-invalid={
                  fieldError?.field === 'confirmPassword' ? 'true' : undefined
                }
                aria-describedby={
                  fieldError?.field === 'confirmPassword' ? errorId : undefined
                }
                className="w-full rounded-md border border-white/20 bg-white/5 px-3 py-2 text-white placeholder-white/40 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
              />
            </div>

            {hasError && (
              <div
                id={errorId}
                role="alert"
                className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400"
              >
                {fieldError?.message ?? error}
              </div>
            )}

            <Button type="submit" disabled={pending} className="w-full">
              {pending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creating account…
                </>
              ) : (
                'Create account'
              )}
            </Button>
          </form>
        </div>
      </div>
    );
  }

  // ─── Signup form (phase === 'signup') ────────────────────────────────────────
  if (phase === 'signup') {
    const errorId = 'auth-error';
    const hasError = error !== null || fieldError !== null;
    return (
      <div className="bg-background flex min-h-screen items-center justify-center">
        <div className="w-full max-w-md p-8">
          <h1 className="mb-8 text-center text-2xl font-bold">247</h1>
          <h2 className="mb-2 text-center text-lg font-semibold">Create your account</h2>
          <p className="mb-6 text-center text-sm text-white/60">
            Sign up to get started.
          </p>
          <form onSubmit={handleSignup} noValidate className="space-y-4">
            <div>
              <label
                htmlFor="su-username"
                className="mb-1 block text-sm font-medium text-white/80"
              >
                Username
              </label>
              <input
                id="su-username"
                ref={bsUsernameRef}
                type="text"
                name="username"
                autoComplete="username"
                value={bsUsername}
                onChange={(e) => setBsUsername(e.target.value)}
                aria-invalid={fieldError?.field === 'username' ? 'true' : undefined}
                aria-describedby={
                  fieldError?.field === 'username' ? errorId : undefined
                }
                className="w-full rounded-md border border-white/20 bg-white/5 px-3 py-2 text-white placeholder-white/40 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
              />
            </div>
            <div>
              <label
                htmlFor="su-password"
                className="mb-1 block text-sm font-medium text-white/80"
              >
                Password
              </label>
              <input
                id="su-password"
                ref={bsPasswordRef}
                type="password"
                name="password"
                autoComplete="new-password"
                value={bsPassword}
                onChange={(e) => setBsPassword(e.target.value)}
                aria-invalid={fieldError?.field === 'password' ? 'true' : undefined}
                aria-describedby={
                  fieldError?.field === 'password' ? errorId : undefined
                }
                className="w-full rounded-md border border-white/20 bg-white/5 px-3 py-2 text-white placeholder-white/40 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
              />
            </div>
            <div>
              <label
                htmlFor="su-confirm"
                className="mb-1 block text-sm font-medium text-white/80"
              >
                Confirm password
              </label>
              <input
                id="su-confirm"
                ref={bsConfirmRef}
                type="password"
                name="confirmPassword"
                autoComplete="new-password"
                value={bsConfirm}
                onChange={(e) => setBsConfirm(e.target.value)}
                aria-invalid={
                  fieldError?.field === 'confirmPassword' ? 'true' : undefined
                }
                aria-describedby={
                  fieldError?.field === 'confirmPassword' ? errorId : undefined
                }
                className="w-full rounded-md border border-white/20 bg-white/5 px-3 py-2 text-white placeholder-white/40 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
              />
            </div>

            {hasError && (
              <div
                id={errorId}
                role="alert"
                className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400"
              >
                {fieldError?.message ?? error}
              </div>
            )}

            <Button type="submit" disabled={pending} className="w-full">
              {pending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Creating account…
                </>
              ) : (
                'Create account'
              )}
            </Button>
          </form>
          <p className="mt-6 text-center text-sm text-white/60">
            Already have an account?{' '}
            <a href="/auth/sign-in" className="text-orange-400 underline hover:text-orange-300">
              Sign in
            </a>
          </p>
        </div>
      </div>
    );
  }

  // ─── Login form (phase === 'login') ──────────────────────────────────────────
  const errorId = 'auth-error';
  const hasError = error !== null || fieldError !== null;
  return (
    <div className="bg-background flex min-h-screen items-center justify-center">
      <div className="w-full max-w-md p-8">
        <h1 className="mb-8 text-center text-2xl font-bold">247</h1>
        <h2 className="mb-2 text-center text-lg font-semibold">Sign in</h2>
        <form onSubmit={handleLogin} noValidate className="space-y-4">
          <div>
            <label
              htmlFor="login-username"
              className="mb-1 block text-sm font-medium text-white/80"
            >
              Username
            </label>
            <input
              id="login-username"
              ref={loginUsernameRef}
              type="text"
              name="username"
              autoComplete="username"
              value={loginUsername}
              onChange={(e) => setLoginUsername(e.target.value)}
              aria-invalid={fieldError?.field === 'username' ? 'true' : undefined}
              aria-describedby={
                fieldError?.field === 'username' ? errorId : undefined
              }
              className="w-full rounded-md border border-white/20 bg-white/5 px-3 py-2 text-white placeholder-white/40 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
            />
          </div>
          <div>
            <label
              htmlFor="login-password"
              className="mb-1 block text-sm font-medium text-white/80"
            >
              Password
            </label>
            <input
              id="login-password"
              ref={loginPasswordRef}
              type="password"
              name="password"
              autoComplete="current-password"
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              aria-invalid={fieldError?.field === 'password' ? 'true' : undefined}
              aria-describedby={
                fieldError?.field === 'password' ? errorId : undefined
              }
              className="w-full rounded-md border border-white/20 bg-white/5 px-3 py-2 text-white placeholder-white/40 focus:border-orange-500 focus:outline-none focus:ring-1 focus:ring-orange-500"
            />
          </div>

          {unknownNotice && (
            <div
              className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-400"
            >
              Couldn't confirm setup state — sign in, or{' '}
              <button
                type="button"
                onClick={retrySession}
                className="underline hover:text-amber-300"
              >
                retry
              </button>
              .
            </div>
          )}

          {hasError && (
            <div
              id={errorId}
              role="alert"
              className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400"
            >
              {fieldError?.message ?? error}
            </div>
          )}

          <Button type="submit" disabled={pending} className="w-full">
            {pending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Signing in…
              </>
            ) : (
              'Sign in'
            )}
          </Button>
        </form>
        <p className="mt-6 text-center text-sm text-white/60">
          New here?{' '}
          <a href="/auth/signup" className="text-orange-400 underline hover:text-orange-300">
            Create account
          </a>
        </p>
      </div>
    </div>
  );
}

// Default export wraps AuthContent in a Suspense boundary — Next 15/16
// requires useSearchParams to be inside a Suspense ancestor or next build fails.
// Mirror connect/page.tsx shape.
export default function AuthPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#0a0a10] to-[#1a1a2e]">
          <Loader2 className="h-12 w-12 animate-spin text-orange-500" />
        </div>
      }
    >
      <AuthContent />
    </Suspense>
  );
}
