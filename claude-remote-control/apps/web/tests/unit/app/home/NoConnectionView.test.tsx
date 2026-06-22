/**
 * NoConnectionView — auth header links (Story 4.7 follow-up)
 *
 * The logged-out landing header offers BOTH "Sign in" → /auth/sign-in and
 * "Sign up" → /auth/signup. When a session exists, neither appears (the user
 * menu replaces them). framer-motion + heavy child components are mocked to
 * passthroughs so the test stays focused on the auth-link branch in AuthButton.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { NoConnectionView } from '@/app/home/NoConnectionView';

const { mockGetSession } = vi.hoisted(() => ({ mockGetSession: vi.fn() }));

vi.mock('@/lib/auth/client', () => ({
  useAuth: () => ({ getSession: mockGetSession, signOut: vi.fn() }),
}));

// framer-motion → render plain elements (strip animation props)
vi.mock('framer-motion', async () => {
  const ReactMod = (await import('react')).default;
  const FRAMER_PROPS = new Set([
    'whileHover',
    'whileTap',
    'whileInView',
    'initial',
    'animate',
    'exit',
    'transition',
    'variants',
    'viewport',
  ]);
  const passthrough = (tag: string) =>
    function Mock({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) {
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (!FRAMER_PROPS.has(k)) rest[k] = v;
      }
      return ReactMod.createElement(tag, rest, children);
    };
  return {
    motion: new Proxy({}, { get: (_t, tag: string) => passthrough(tag) }),
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => children,
  };
});

// Heavy children not under test
vi.mock('@/components/AgentConnectionSettings', () => ({
  AgentConnectionSettings: () => null,
  saveAgentConnection: vi.fn(),
}));
vi.mock('@/components/InstallationGuide', () => ({
  InstallationGuide: () => null,
}));

const baseProps = {
  modalOpen: false,
  onModalOpenChange: vi.fn(),
  onConnectionSaved: vi.fn(),
};

describe('NoConnectionView — auth header links', () => {
  beforeEach(() => {
    mockGetSession.mockReset();
  });

  it('shows both Sign in and Sign up links when logged out', async () => {
    mockGetSession.mockResolvedValue(null);
    render(<NoConnectionView {...baseProps} />);

    const signIn = await screen.findByRole('link', { name: /sign in/i });
    const signUp = await screen.findByRole('link', { name: /sign up/i });

    expect(signIn.getAttribute('href')).toBe('/auth/sign-in');
    expect(signUp.getAttribute('href')).toBe('/auth/signup');
  });

  it('hides the Sign up link once a session exists', async () => {
    mockGetSession.mockResolvedValue({ data: { user: { name: 'alice', email: null } } });
    render(<NoConnectionView {...baseProps} />);

    // Wait for the user-menu avatar (initials) to replace the auth links
    await waitFor(() => {
      expect(screen.queryByRole('link', { name: /sign up/i })).toBeNull();
    });
    expect(screen.queryByRole('link', { name: /^sign in$/i })).toBeNull();
  });
});
