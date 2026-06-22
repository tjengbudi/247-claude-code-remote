/**
 * Story 4.3 — auth/[path]/page.tsx component tests
 *
 * Covers:
 *  - Session-driven branch: bootstrap / login / logged-in / UNKNOWN (null)
 *  - Bootstrap: success 201→/, 409→inline+flip, client-validation <8+no-fetch
 *  - Login: success 200→/ (returnTo safe vs hostile), 401/429 inline
 *  - A11y: labels (getByLabelText), Enter-to-submit (fireEvent.submit),
 *    focus-to-first-error
 *
 * Pattern notes (from 4.1 debug log + 4.2 client.test.ts):
 *  - vi.hoisted() for the captured push/replace/searchState spies so the
 *    vi.mock('next/navigation') factory can reference them (mocks are hoisted
 *    above module-level consts; a plain const throws ReferenceError)
 *  - Mock @/lib/auth/client (useAuth) to control getSession return shape
 *  - Mock global.fetch per-test to drive login/bootstrap route responses
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import AuthPage from '@/app/auth/[path]/page';

// ─── Capture next/navigation spies via vi.hoisted ─────────────────────────────
// Router MUST be a stable object reference — Next.js useRouter() returns the
// same object across renders. A fresh { push, replace } per call would make
// the page's useEffect (which has `router` in deps) re-fire on every
// re-render, calling getSession() multiple times and clobbering state set by
// submit handlers (e.g. 409 → phase='login' gets overridden back to 'bootstrap').
const { push, replace, searchState, router, paramsState } = vi.hoisted(() => {
  const push = vi.fn();
  const replace = vi.fn();
  const searchState = { current: '' };
  // Mutable so tests can switch the [path] segment (e.g. 'signup') before render.
  const paramsState = { path: 'sign-in' };
  const router = { push, replace, prefetch: vi.fn(), back: vi.fn() };
  return { push, replace, searchState, router, paramsState };
});

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => `/auth/${paramsState.path}`,
  useSearchParams: () => new URLSearchParams(searchState.current),
  useParams: () => ({ path: paramsState.path }),
}));

// ─── Capture getSession mock ──────────────────────────────────────────────────
const { mockGetSession } = vi.hoisted(() => ({
  mockGetSession: vi.fn<() => Promise<unknown>>().mockResolvedValue({
    data: { user: null },
    ownerExists: true,
  }),
}));

vi.mock('@/lib/auth/client', () => ({
  useAuth: () => ({ getSession: mockGetSession, signOut: vi.fn() }),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────
let fetchSpy: ReturnType<typeof vi.fn>;

interface MockFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function jsonResponse(body: unknown, status: number): MockFetchResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

function setFetchResponse(url: string, response: MockFetchResponse) {
  fetchSpy.mockImplementation((input: string | URL | Request) => {
    const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (u === url) {
      return Promise.resolve(response as unknown as Response);
    }
    return Promise.reject(new Error(`unmocked fetch to ${u}`));
  });
}

function renderPage() {
  return render(<AuthPage />);
}

// Query helpers — the page has <h2>Sign in</h2> / <h2>Create your account</h2>
// so we use getByRole('heading') for form identification, not getByLabelText.
function getLoginForm() {
  return screen.getByRole('heading', { name: /sign in/i });
}
function getBootstrapForm() {
  return screen.getByRole('heading', { name: /create your account/i });
}

// ─── Suite ────────────────────────────────────────────────────────────────────
describe('AuthPage (Story 4.3)', () => {
  beforeEach(() => {
    push.mockClear();
    replace.mockClear();
    mockGetSession.mockClear();
    // Default: logged-out with owner exists (most tests expect this)
    mockGetSession.mockResolvedValue({
      data: { user: null },
      ownerExists: true,
    });
    searchState.current = '';
    paramsState.path = 'sign-in';
    fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // ─── AC1 — branch on ownerExists from a single getSession() call ────────────
  describe('session-driven branch (AC1)', () => {
    it('renders the bootstrap form when ownerExists === false', async () => {
      mockGetSession.mockResolvedValueOnce({
        data: { user: null },
        ownerExists: false,
      });
      renderPage();
      await waitFor(() => {
        expect(getBootstrapForm()).toBeTruthy();
      });
      expect(screen.getByLabelText(/confirm password/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: /create account/i })).toBeTruthy();
    });

    it('renders the login form when ownerExists === true', async () => {
      mockGetSession.mockResolvedValueOnce({
        data: { user: null },
        ownerExists: true,
      });
      renderPage();
      await waitFor(() => {
        expect(getLoginForm()).toBeTruthy();
      });
      expect(screen.queryByLabelText(/confirm password/i)).toBeNull();
      expect(screen.getByRole('button', { name: /sign in/i })).toBeTruthy();
    });

    it('redirects to / (no form) when already logged in', async () => {
      mockGetSession.mockResolvedValueOnce({
        data: { user: { id: 'u1', name: 'admin', email: null } },
        ownerExists: true,
      });
      renderPage();
      await waitFor(() => {
        expect(replace).toHaveBeenCalledWith('/');
      });
      expect(screen.queryByRole('form')).toBeNull();
      expect(push).not.toHaveBeenCalled();
    });

    it('renders login (NEVER bootstrap) when ownerExists === null (UNKNOWN)', async () => {
      mockGetSession.mockResolvedValueOnce({
        data: { user: null },
        ownerExists: null,
      });
      renderPage();
      await waitFor(() => {
        expect(getLoginForm()).toBeTruthy();
      });
      expect(screen.queryByLabelText(/confirm password/i)).toBeNull();
      expect(screen.getByText(/couldn't confirm setup state/i)).toBeTruthy();
    });

    it('only calls getSession() once on mount', async () => {
      mockGetSession.mockResolvedValueOnce({
        data: { user: null },
        ownerExists: true,
      });
      renderPage();
      await waitFor(() => getLoginForm());
      expect(mockGetSession).toHaveBeenCalledTimes(1);
    });
  });

  // ─── AC2 — Bootstrap submit ─────────────────────────────────────────────────
  describe('bootstrap submit (AC2)', () => {
    beforeEach(() => {
      mockGetSession.mockResolvedValue({
        data: { user: null },
        ownerExists: false,
      });
    });

    it('POSTs /api/auth/bootstrap and redirects to / on 201', async () => {
      setFetchResponse('/api/auth/bootstrap', jsonResponse({ data: { user: {} } }, 201));
      renderPage();
      await waitFor(() => getBootstrapForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'admin' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      fireEvent.change(screen.getByLabelText(/confirm password/i), {
        target: { value: 'password123' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /create account/i }));

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          '/api/auth/bootstrap',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ username: 'admin', password: 'password123' }),
          }),
        );
      });
      await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    });

    it('does NOT POST and shows inline error when password < 8 chars', async () => {
      renderPage();
      await waitFor(() => getBootstrapForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'admin' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'short' },
      });
      fireEvent.change(screen.getByLabelText(/confirm password/i), {
        target: { value: 'short' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /create account/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toMatch(/at least 8/i);
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(screen.getByLabelText(/^password$/i));
    });

    it('does NOT POST when passwords do not match', async () => {
      renderPage();
      await waitFor(() => getBootstrapForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'admin' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      fireEvent.change(screen.getByLabelText(/confirm password/i), {
        target: { value: 'password456' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /create account/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toMatch(/do not match/i);
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(screen.getByLabelText(/confirm password/i));
    });

    it('does NOT POST when username is blank', async () => {
      renderPage();
      await waitFor(() => getBootstrapForm());

      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      fireEvent.change(screen.getByLabelText(/confirm password/i), {
        target: { value: 'password123' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /create account/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toMatch(/username is required/i);
      });
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('shows inline "Owner already exists" and flips to login on 409', async () => {
      setFetchResponse(
        '/api/auth/bootstrap',
        jsonResponse({ error: 'Owner already exists' }, 409),
      );
      renderPage();
      await waitFor(() => getBootstrapForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'admin' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      fireEvent.change(screen.getByLabelText(/confirm password/i), {
        target: { value: 'password123' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /create account/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toMatch(/owner already exists/i);
      });
      // UI should have flipped to login (no confirm-password anymore)
      await waitFor(() => {
        expect(screen.queryByLabelText(/confirm password/i)).toBeNull();
      });
      expect(getLoginForm()).toBeTruthy();
    });

    it('shows inline server-400 error on the relevant field', async () => {
      setFetchResponse(
        '/api/auth/bootstrap',
        jsonResponse({ error: 'Password must be at least 8 characters' }, 400),
      );
      renderPage();
      await waitFor(() => getBootstrapForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'admin' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'exactly8' },
      });
      fireEvent.change(screen.getByLabelText(/confirm password/i), {
        target: { value: 'exactly8' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /create account/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toMatch(/at least 8/i);
      });
    });

    it('shows a generic inline error on network failure', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('network down'));
      renderPage();
      await waitFor(() => getBootstrapForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'admin' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      fireEvent.change(screen.getByLabelText(/confirm password/i), {
        target: { value: 'password123' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /create account/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toMatch(/something went wrong/i);
      });
    });

    it('disables the submit button while POST is in flight (no double-submit)', async () => {
      const holder: { resolve: (v: Response) => void } = { resolve: () => {} };
      fetchSpy.mockImplementationOnce(
        () => new Promise<Response>((r) => { holder.resolve = r; }),
      );
      renderPage();
      await waitFor(() => getBootstrapForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'admin' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      fireEvent.change(screen.getByLabelText(/confirm password/i), {
        target: { value: 'password123' },
      });
      const submit = screen.getByRole('button', { name: /create account|creating/i });
      fireEvent.submit(submit);

      await waitFor(() => {
        const btn = screen.getByRole('button');
        expect(btn.getAttribute('disabled')).toBe('');
      });
      // Resolve so the test doesn't leak
      holder.resolve(jsonResponse({ data: { user: {} } }, 201) as unknown as Response);
      await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    });
  });

  // ─── AC3 — Login submit ─────────────────────────────────────────────────────
  describe('login submit (AC3)', () => {
    beforeEach(() => {
      mockGetSession.mockResolvedValue({
        data: { user: null },
        ownerExists: true,
      });
    });

    it('POSTs /api/auth/login and redirects to / on 200', async () => {
      setFetchResponse('/api/auth/login', jsonResponse({ data: { user: {} } }, 200));
      renderPage();
      await waitFor(() => getLoginForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'admin' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          '/api/auth/login',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ username: 'admin', password: 'password123' }),
          }),
        );
      });
      await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    });

    it('honors safe same-origin returnTo when present', async () => {
      searchState.current = 'returnTo=/connect?foo=bar';
      setFetchResponse('/api/auth/login', jsonResponse({ data: { user: {} } }, 200));
      renderPage();
      await waitFor(() => getLoginForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'admin' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => expect(replace).toHaveBeenCalledWith('/connect?foo=bar'));
    });

    it('rejects a hostile //evil.com returnTo and falls back to /', async () => {
      searchState.current = 'returnTo=//evil.com/phish';
      setFetchResponse('/api/auth/login', jsonResponse({ data: { user: {} } }, 200));
      renderPage();
      await waitFor(() => getLoginForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'admin' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    });

    it('rejects an absolute cross-origin returnTo and falls back to /', async () => {
      searchState.current = 'returnTo=https://evil.com/phish';
      setFetchResponse('/api/auth/login', jsonResponse({ data: { user: {} } }, 200));
      renderPage();
      await waitFor(() => getLoginForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'admin' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    });

    it('rejects a backslash returnTo (/\\evil.com) and falls back to / (P1)', async () => {
      // Browsers normalize `/\` → `//`, so `/\evil.com` is a protocol-relative
      // open-redirect vector. The single-slash regex MUST reject it.
      searchState.current = 'returnTo=' + encodeURIComponent('/\\evil.com');
      setFetchResponse('/api/auth/login', jsonResponse({ data: { user: {} } }, 200));
      renderPage();
      await waitFor(() => getLoginForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'admin' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    });

    it('trims the username before POSTing (P3)', async () => {
      setFetchResponse('/api/auth/login', jsonResponse({ data: { user: {} } }, 200));
      renderPage();
      await waitFor(() => getLoginForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: '  admin  ' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          '/api/auth/login',
          expect.objectContaining({
            body: JSON.stringify({ username: 'admin', password: 'password123' }),
          }),
        );
      });
    });

    it('shows generic "Invalid username or password" on 401', async () => {
      setFetchResponse(
        '/api/auth/login',
        jsonResponse({ error: 'Invalid credentials' }, 401),
      );
      renderPage();
      await waitFor(() => getLoginForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'admin' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'wrong' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toMatch(/invalid username or password/i);
      });
    });

    it('shows "Too many attempts" on 429', async () => {
      setFetchResponse(
        '/api/auth/login',
        jsonResponse({ error: 'Too many attempts' }, 429),
      );
      renderPage();
      await waitFor(() => getLoginForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'admin' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toMatch(/too many attempts/i);
      });
    });

    it('shows a generic inline error on network failure', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('network down'));
      renderPage();
      await waitFor(() => getLoginForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'admin' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toMatch(/something went wrong/i);
      });
    });

    it('disables submit button while POST is in flight', async () => {
      let resolveFetch: ((v: Response) => void) | null = null;
      fetchSpy.mockImplementationOnce(
        () => new Promise<Response>((r) => { resolveFetch = r; }),
      );
      renderPage();
      await waitFor(() => getLoginForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'admin' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      const submit = screen.getByRole('button', { name: /sign in|signing/i });
      fireEvent.submit(submit);

      await waitFor(() => {
        expect(screen.getByRole('button').getAttribute('disabled')).toBe('');
      });
      if (resolveFetch) {
        (resolveFetch as (v: Response) => void)(jsonResponse({ data: { user: {} } }, 200) as unknown as Response);
      }
      await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    });

    it('shows field-level error and focuses first invalid on empty submit', async () => {
      renderPage();
      await waitFor(() => getLoginForm());

      fireEvent.submit(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toMatch(/username is required/i);
      });
      expect(document.activeElement).toBe(screen.getByLabelText(/^username$/i));
    });
  });

  // ─── AC6 — Accessibility ────────────────────────────────────────────────────
  describe('accessibility (AC6)', () => {
    it('login: every input has a programmatic label (getByLabelText)', async () => {
      mockGetSession.mockResolvedValueOnce({
        data: { user: null },
        ownerExists: true,
      });
      renderPage();
      await waitFor(() => getLoginForm());

      expect(screen.getByLabelText(/^username$/i)).toBeTruthy();
      expect(screen.getByLabelText(/^password$/i)).toBeTruthy();
    });

    it('bootstrap: every input has a programmatic label (getByLabelText)', async () => {
      mockGetSession.mockResolvedValueOnce({
        data: { user: null },
        ownerExists: false,
      });
      renderPage();
      await waitFor(() => getBootstrapForm());

      expect(screen.getByLabelText(/^username$/i)).toBeTruthy();
      expect(screen.getByLabelText(/^password$/i)).toBeTruthy();
      expect(screen.getByLabelText(/confirm password/i)).toBeTruthy();
    });

    it('bootstrap: focus moves to first invalid field on validation failure', async () => {
      mockGetSession.mockResolvedValueOnce({
        data: { user: null },
        ownerExists: false,
      });
      renderPage();
      await waitFor(() => getBootstrapForm());

      // Empty username — first invalid
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      fireEvent.change(screen.getByLabelText(/confirm password/i), {
        target: { value: 'password123' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /create account/i }));

      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByLabelText(/^username$/i));
      });
    });

    it('aria-invalid is set on the offending input', async () => {
      mockGetSession.mockResolvedValueOnce({
        data: { user: null },
        ownerExists: false,
      });
      renderPage();
      await waitFor(() => getBootstrapForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'admin' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'short' },
      });
      fireEvent.change(screen.getByLabelText(/confirm password/i), {
        target: { value: 'short' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /create account/i }));

      await waitFor(() => {
        expect(screen.getByLabelText(/^password$/i).getAttribute('aria-invalid')).toBe('true');
      });
    });

    it('error region uses role="alert"', async () => {
      mockGetSession.mockResolvedValueOnce({
        data: { user: null },
        ownerExists: false,
      });
      setFetchResponse(
        '/api/auth/bootstrap',
        jsonResponse({ error: 'Owner already exists' }, 409),
      );
      renderPage();
      await waitFor(() => getBootstrapForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'admin' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      fireEvent.change(screen.getByLabelText(/confirm password/i), {
        target: { value: 'password123' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /create account/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeTruthy();
      });
    });

    it('Enter-to-submit works via fireEvent.submit on the form', async () => {
      mockGetSession.mockResolvedValueOnce({
        data: { user: null },
        ownerExists: true,
      });
      setFetchResponse('/api/auth/login', jsonResponse({ data: { user: {} } }, 200));
      renderPage();
      await waitFor(() => getLoginForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'admin' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      const form = screen.getByLabelText(/^username$/i).closest('form')!;
      fireEvent.submit(form);

      await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    });
  });

  // ─── AC4 — redirect safety ──────────────────────────────────────────────────
  describe('redirect safety (AC4)', () => {
    it('uses router.replace (not push) so back-button does not return to auth', async () => {
      mockGetSession.mockResolvedValueOnce({
        data: { user: null },
        ownerExists: true,
      });
      setFetchResponse('/api/auth/login', jsonResponse({ data: { user: {} } }, 200));
      renderPage();
      await waitFor(() => getLoginForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'admin' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /sign in/i }));

      await waitFor(() => {
        expect(replace).toHaveBeenCalled();
        expect(push).not.toHaveBeenCalled();
      });
    });
  });

  // ─── Loading + UNKNOWN retry ────────────────────────────────────────────────
  describe('loading + UNKNOWN retry', () => {
    it('shows spinner while initial getSession() is in flight', async () => {
      let resolveSession: ((v: unknown) => void) | null = null;
      mockGetSession.mockImplementationOnce(
        () => new Promise((r) => { resolveSession = r; }),
      );
      renderPage();

      await waitFor(() => {
        const svg = document.querySelector('.animate-spin');
        expect(svg).toBeTruthy();
      });
      expect(screen.queryByLabelText(/^username$/i)).toBeNull();

      if (resolveSession) {
        (resolveSession as (v: unknown) => void)({ data: { user: null }, ownerExists: true });
      }
      await waitFor(() => getLoginForm());
    });

    it('UNKNOWN retry re-runs getSession() when retry is clicked', async () => {
      mockGetSession
        .mockResolvedValueOnce({ data: { user: null }, ownerExists: null })
        .mockResolvedValueOnce({ data: { user: null }, ownerExists: false });
      renderPage();
      await waitFor(() => screen.getByText(/couldn't confirm setup state/i));

      fireEvent.click(screen.getByRole('button', { name: /retry/i }));

      await waitFor(() => getBootstrapForm());
      expect(mockGetSession).toHaveBeenCalledTimes(2);
    });
  });

  // ─── Unmount safety (P2 regression guard) ───────────────────────────────────
  describe('unmount safety', () => {
    it('does NOT navigate when login resolves after unmount', async () => {
      let resolveFetch: ((v: Response) => void) | null = null;
      fetchSpy.mockImplementationOnce(
        () => new Promise<Response>((r) => { resolveFetch = r; }),
      );
      const { unmount } = renderPage();
      await waitFor(() => getLoginForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'admin' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /sign in/i }));

      // Unmount while the POST is still in flight, then resolve it.
      unmount();
      if (resolveFetch) {
        (resolveFetch as (v: Response) => void)(
          jsonResponse({ data: { user: {} } }, 200) as unknown as Response,
        );
      }

      // Give the resolved promise a tick to (not) run its continuation.
      await Promise.resolve();
      await Promise.resolve();
      expect(replace).not.toHaveBeenCalled();
    });

    it('does NOT navigate when the initial session resolves after unmount', async () => {
      let resolveSession: ((v: unknown) => void) | null = null;
      mockGetSession.mockImplementationOnce(
        () => new Promise((r) => { resolveSession = r; }),
      );
      const { unmount } = renderPage();
      // Spinner phase — unmount before the session resolves.
      unmount();
      if (resolveSession) {
        (resolveSession as (v: unknown) => void)({
          data: { user: { id: 'u1', name: 'admin', email: null } },
          ownerExists: true,
        });
      }

      await Promise.resolve();
      await Promise.resolve();
      expect(replace).not.toHaveBeenCalled();
    });
  });

  // ─── Signup route (/auth/signup) — multi-user registration ──────────────────
  describe('signup route (multi-user)', () => {
    function getSignupForm() {
      return screen.getByRole('heading', { name: /create your account/i });
    }

    it('renders the signup form on /auth/signup even when an owner exists', async () => {
      paramsState.path = 'signup';
      mockGetSession.mockResolvedValueOnce({
        data: { user: null },
        ownerExists: true,
      });
      renderPage();
      await waitFor(() => {
        expect(getSignupForm()).toBeTruthy();
        // Subtitle distinguishes signup from first-run bootstrap copy.
        expect(screen.getByText(/sign up to get started/i)).toBeTruthy();
        expect(screen.getByLabelText(/confirm password/i)).toBeTruthy();
      });
    });

    it('POSTs /api/auth/signup and redirects to / on 201', async () => {
      paramsState.path = 'signup';
      setFetchResponse('/api/auth/signup', jsonResponse({ data: { user: {} } }, 201));
      renderPage();
      await waitFor(() => getSignupForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'alice' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      fireEvent.change(screen.getByLabelText(/confirm password/i), {
        target: { value: 'password123' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /create account/i }));

      await waitFor(() => {
        expect(fetchSpy).toHaveBeenCalledWith(
          '/api/auth/signup',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ username: 'alice', password: 'password123' }),
          }),
        );
      });
      await waitFor(() => expect(replace).toHaveBeenCalledWith('/'));
    });

    it('shows inline "Username already taken" on 409 and does NOT redirect', async () => {
      paramsState.path = 'signup';
      setFetchResponse(
        '/api/auth/signup',
        jsonResponse({ error: 'Username already taken' }, 409),
      );
      renderPage();
      await waitFor(() => getSignupForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'alice' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'password123' },
      });
      fireEvent.change(screen.getByLabelText(/confirm password/i), {
        target: { value: 'password123' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /create account/i }));

      await waitFor(() => {
        expect(screen.getByRole('alert').textContent).toMatch(/username already taken/i);
      });
      // Still on the signup form, no navigation.
      expect(getSignupForm()).toBeTruthy();
      expect(replace).not.toHaveBeenCalled();
    });

    it('does NOT POST and shows inline error when password < 8 chars', async () => {
      paramsState.path = 'signup';
      renderPage();
      await waitFor(() => getSignupForm());

      fireEvent.change(screen.getByLabelText(/^username$/i), {
        target: { value: 'alice' },
      });
      fireEvent.change(screen.getByLabelText(/^password$/i), {
        target: { value: 'short' },
      });
      fireEvent.change(screen.getByLabelText(/confirm password/i), {
        target: { value: 'short' },
      });
      fireEvent.submit(screen.getByRole('button', { name: /create account/i }));

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toBeTruthy();
    });

    it('login form links to /auth/signup', async () => {
      // Default beforeEach: logged-out, ownerExists true → login form.
      renderPage();
      await waitFor(() => getLoginForm());

      const link = screen.getByRole('link', { name: /create account/i });
      expect(link.getAttribute('href')).toBe('/auth/signup');
    });
  });
});
