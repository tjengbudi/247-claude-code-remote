import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAuth } from '@/lib/auth/client';

describe('useAuth hook', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('getSession', () => {
    it('returns user data when logged in', async () => {
      const mockResponse = {
        data: {
          user: {
            id: 'user-1',
            name: 'alice',
            email: 'alice@example.com',
          },
        },
        ownerExists: true,
      };

      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const { result } = renderHook(() => useAuth());

      const session = await act(async () => {
        return await result.current.getSession();
      });

      expect(global.fetch).toHaveBeenCalledWith('/api/auth/session');
      expect(session.data.user).toEqual(mockResponse.data.user);
      expect(session.ownerExists).toBe(true);
    });

    it('returns null user when logged out', async () => {
      const mockResponse = {
        data: { user: null },
        ownerExists: false,
      };

      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => mockResponse,
      } as Response);

      const { result } = renderHook(() => useAuth());

      const session = await act(async () => {
        return await result.current.getSession();
      });

      expect(global.fetch).toHaveBeenCalledWith('/api/auth/session');
      expect(session.data.user).toBeNull();
      expect(session.ownerExists).toBe(false);
    });

    it('returns null user and UNKNOWN owner state on non-ok response', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
      } as Response);

      const { result } = renderHook(() => useAuth());

      const session = await act(async () => {
        return await result.current.getSession();
      });

      expect(session.data.user).toBeNull();
      // transient failure must NOT report "no owner" (BS1) — owner state unknown
      expect(session.ownerExists).toBeNull();
    });

    it('returns null user and UNKNOWN owner state on fetch error', async () => {
      vi.spyOn(global, 'fetch').mockRejectedValueOnce(new Error('Network error'));

      const { result } = renderHook(() => useAuth());

      const session = await act(async () => {
        return await result.current.getSession();
      });

      expect(session.data.user).toBeNull();
      expect(session.ownerExists).toBeNull();
    });

    it('returns null user when a 200 response has a malformed body', async () => {
      // res.ok but the body is not the expected shape (e.g. proxy/partial response)
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ unexpected: 'shape' }),
      } as Response);

      const { result } = renderHook(() => useAuth());

      const session = await act(async () => {
        return await result.current.getSession();
      });

      expect(session.data.user).toBeNull();
      expect(session.ownerExists).toBeNull();
    });

    it('coerces a malformed user object to null without throwing', async () => {
      vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { user: { id: 123 } }, ownerExists: true }),
      } as Response);

      const { result } = renderHook(() => useAuth());

      const session = await act(async () => {
        return await result.current.getSession();
      });

      expect(session.data.user).toBeNull();
      expect(session.ownerExists).toBe(true);
    });
  });

  describe('signOut', () => {
    it('POSTs to /api/auth/logout', async () => {
      const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: true,
      } as Response);

      const { result } = renderHook(() => useAuth());

      await act(async () => {
        await result.current.signOut();
      });

      expect(fetchSpy).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' });
    });
  });

  describe('hook stability', () => {
    it('returns stable useCallback references', () => {
      const { result, rerender } = renderHook(() => useAuth());

      const firstGetSession = result.current.getSession;
      const firstSignOut = result.current.signOut;

      rerender();

      expect(result.current.getSession).toBe(firstGetSession);
      expect(result.current.signOut).toBe(firstSignOut);
    });
  });
});
