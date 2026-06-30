/**
 * Tests for useGitActions worktree create/remove actions (Story 6.6, AC5).
 *
 * Focuses on: POST shape, 409-dirty, 409-live-session branches.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { toast } from 'sonner';

vi.mock('@/lib/utils', () => ({
  buildApiUrl: (base: string, path: string) => `${base}${path}`,
  cn: (...args: string[]) => args.filter(Boolean).join(' '),
}));

vi.mock('sonner', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('@/contexts/SessionPollingContext', () => ({
  viewerParams: () => new URLSearchParams(),
}));

const fetchMock = vi.fn();
global.fetch = fetchMock;

const MACHINE_ID = 'proj';
const MACHINE_URL = 'http://agent:3000';
const REPO = '/tmp/projects/myrepo';
const WTP = '/tmp/.247-worktrees/myrepo/feat';

const agentConnections = [{ id: MACHINE_ID, url: MACHINE_URL, name: 'M', method: 'localhost' as const, createdAt: 0 }];
const viewer = { ownerId: 'u1', isOwner: true };

async function getHook() {
  const { useGitActions } = await import('@/hooks/useGitActions');
  const { result } = renderHook(() => useGitActions(agentConnections as any, viewer));
  return result.current;
}

describe('useGitActions — createWorktree (AC1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs to /api/git/worktree with correct body shape', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, worktree: { path: WTP, branch: 'feat' } }),
    });

    const actions = await getHook();
    const result = await actions.createWorktree(MACHINE_ID, REPO, 'feat', false);
    expect(fetchMock).toHaveBeenCalledOnce();
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toContain('/api/git/worktree');
    const body = JSON.parse(call[1].body);
    expect(body.branch).toBe('feat');
    expect(body.newBranch).toBe(false);
    expect(result).toEqual({ path: WTP, branch: 'feat' });
  });

  it('returns null when agent not found', async () => {
    const { useGitActions } = await import('@/hooks/useGitActions');
    const { result } = renderHook(() => useGitActions([], viewer));
    const res = await result.current.createWorktree('missing', REPO, 'feat');
    expect(res).toBeNull();
  });
});

describe('useGitActions — removeWorktree (AC4, AC5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns {ok:true} on success', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
    const actions = await getHook();
    const result = await actions.removeWorktree(MACHINE_ID, REPO, WTP);
    expect(result).toEqual({ ok: true });
  });

  it('returns {ok:false, dirty:true} on 409 with dirty flag (AC5)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'worktree has uncommitted changes', dirty: true }),
    });
    const actions = await getHook();
    const result = await actions.removeWorktree(MACHINE_ID, REPO, WTP);
    expect(result).toEqual({ ok: false, dirty: true });
  });

  it('returns {ok:false, liveSession:true} on 409 without dirty flag (AC4)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'a live session is using this worktree' }),
    });
    const actions = await getHook();
    const result = await actions.removeWorktree(MACHINE_ID, REPO, WTP);
    expect(result).toEqual({ ok: false, liveSession: true });
  });

  it('surfaces a toast on the live-session block, not a silent no-op (AC4)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'a live session is using this worktree — end the session first' }),
    });
    const actions = await getHook();
    await actions.removeWorktree(MACHINE_ID, REPO, WTP);
    expect(toast.error).toHaveBeenCalledWith('a live session is using this worktree — end the session first');
  });

  it('does NOT toast on the dirty 409 (inline force-confirm handles it) (AC5)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: 'worktree has uncommitted changes', dirty: true }),
    });
    const actions = await getHook();
    await actions.removeWorktree(MACHINE_ID, REPO, WTP);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('sends force:true when opts.force is set (AC5)', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ ok: true }) });
    const actions = await getHook();
    await actions.removeWorktree(MACHINE_ID, REPO, WTP, { force: true });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.force).toBe(true);
  });
});
