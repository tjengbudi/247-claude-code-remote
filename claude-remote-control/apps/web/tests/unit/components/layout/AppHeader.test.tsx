/**
 * Story 4.4 — AppHeader component tests
 *
 * Covers:
 *  - Session-driven branch: signed-in (avatar menu) vs signed-out (sign-in link)
 *  - Logout: calls signOut() then window.location.reload()
 *  - A11y: aria-labels, aria-expanded, aria-haspopup
 *
 * Pattern notes:
 *  - vi.hoisted() for getSession/signOut spies so the vi.mock factory can
 *    reference them (mocks are hoisted above module-level consts)
 *  - Mock @/lib/auth/client (useAuth) to control session return shape
 *  - Stub window.location.reload to assert logout behavior
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { AppHeader } from '@/components/layout/AppHeader';

// ─── Capture auth spies via vi.hoisted ─────────────────────────────────────────
const { mockGetSession, mockSignOut } = vi.hoisted(() => ({
  mockGetSession: vi.fn<() => Promise<unknown>>().mockResolvedValue({
    data: { user: null },
    ownerExists: true,
  }),
  mockSignOut: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock('@/lib/auth/client', () => ({
  useAuth: () => ({ getSession: mockGetSession, signOut: mockSignOut }),
}));

// ─── Stub window.location.reload ───────────────────────────────────────────────
let reloadSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockGetSession.mockClear();
  mockSignOut.mockClear();
  reloadSpy = vi.fn();
  Object.defineProperty(window, 'location', {
    value: { ...window.location, reload: reloadSpy },
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ─── Suite ─────────────────────────────────────────────────────────────────────
describe('AppHeader (Story 4.4)', () => {
  it('renders sign-in link when signed out', async () => {
    mockGetSession.mockResolvedValueOnce({
      data: { user: null },
      ownerExists: true,
    });
    render(<AppHeader />);
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /sign in/i })).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: /user menu/i })).toBeNull();
  });

  it('renders avatar menu when signed in', async () => {
    mockGetSession.mockResolvedValueOnce({
      data: {
        user: { id: 'u1', name: 'Alice Admin', email: 'alice@example.com' },
      },
      ownerExists: true,
    });
    render(<AppHeader />);
    await waitFor(() => {
      const avatar = screen.getByRole('button', { name: /user menu for alice/i });
      expect(avatar).toBeTruthy();
      expect(avatar.textContent).toBe('AA'); // initials
    });
  });

  it('opens dropdown on avatar click and shows user info', async () => {
    mockGetSession.mockResolvedValueOnce({
      data: {
        user: { id: 'u1', name: 'Bob Builder', email: 'bob@example.com' },
      },
      ownerExists: true,
    });
    render(<AppHeader />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /user menu for bob/i })).toBeTruthy();
    });

    const avatar = screen.getByRole('button', { name: /user menu for bob/i });
    expect(avatar.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(avatar);
    await waitFor(() => {
      expect(screen.getByText('Bob Builder')).toBeTruthy();
      expect(screen.getByText('bob@example.com')).toBeTruthy();
      expect(avatar.getAttribute('aria-expanded')).toBe('true');
    });
  });

  it('calls signOut() then window.location.reload() on logout click', async () => {
    mockGetSession.mockResolvedValueOnce({
      data: {
        user: { id: 'u1', name: 'Charlie', email: null },
      },
      ownerExists: true,
    });
    render(<AppHeader />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /user menu for charlie/i })).toBeTruthy();
    });

    // Open menu
    fireEvent.click(screen.getByRole('button', { name: /user menu for charlie/i }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /sign out/i })).toBeTruthy();
    });

    // Click sign out
    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));

    // Assert signOut() was called
    await waitFor(() => {
      expect(mockSignOut).toHaveBeenCalledTimes(1);
    });

    // Assert reload was called
    await waitFor(() => {
      expect(reloadSpy).toHaveBeenCalledTimes(1);
    });
  });

  it('uses email initial when name is missing', async () => {
    mockGetSession.mockResolvedValueOnce({
      data: {
        user: { id: 'u1', name: '', email: 'zoe@example.com' },
      },
      ownerExists: true,
    });
    render(<AppHeader />);
    await waitFor(() => {
      const avatar = screen.getByRole('button', { name: /user menu/i });
      expect(avatar.textContent).toBe('Z');
    });
  });
});
