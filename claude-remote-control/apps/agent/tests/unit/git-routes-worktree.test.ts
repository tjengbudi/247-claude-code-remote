/**
 * Tests for POST /api/git/worktree and /api/git/worktree/remove (Story 6.6, AC4, AC5, AC6).
 *
 * Mocks: lib/git.js (createWorktree, removeWorktree, listWorktrees, getRepoStatus),
 *        websocket-handlers.js (broadcastGitStatus, tmuxSessionExists),
 *        db/sessions.js (getAllSessions).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const ALLOWED_ROOT = '/tmp/projects';
const REPO = `${ALLOWED_ROOT}/myrepo`;
const WORKTREE_PATH = `/tmp/.247-worktrees/myrepo/feat`;

vi.mock('../../src/config.js', () => {
  const mockConfig = {
    machine: { id: 'm', name: 'M' },
    projects: { basePath: ALLOWED_ROOT, whitelist: [] },
  };
  return { config: mockConfig, loadConfig: () => mockConfig, default: mockConfig };
});

const createWorktreeMock = vi.fn().mockResolvedValue({ path: WORKTREE_PATH, branch: 'feat' });
const removeWorktreeMock = vi.fn().mockResolvedValue(undefined);
const listWorktreesMock = vi.fn().mockResolvedValue([{ path: WORKTREE_PATH, branch: 'feat', head: 'abc', detached: false, bare: false }]);
const getRepoStatusMock = vi.fn().mockResolvedValue({
  branch: { branchName: 'main', ahead: 0, behind: 0 },
  files: [],
  stagedCount: 0,
  unstagedCount: 0,
  untrackedCount: 0,
  ignoredCount: 0,
  conflicted: 0,
});

vi.mock('../../src/lib/git.js', () => ({
  discoverRepos: vi.fn().mockResolvedValue({ repos: [], capped: false }),
  getRepoStatus: getRepoStatusMock,
  getLog: vi.fn().mockResolvedValue([]),
  getCommit: vi.fn().mockResolvedValue({ files: [] }),
  getFileDiff: vi.fn().mockResolvedValue(''),
  getGraph: vi.fn().mockResolvedValue({ commits: [], capped: false }),
  stagePaths: vi.fn().mockResolvedValue(undefined),
  unstagePaths: vi.fn().mockResolvedValue(undefined),
  commit: vi.fn().mockResolvedValue(undefined),
  push: vi.fn().mockResolvedValue(undefined),
  pull: vi.fn().mockResolvedValue(undefined),
  branch: vi.fn().mockResolvedValue(undefined),
  listWorktrees: listWorktreesMock,
  createWorktree: createWorktreeMock,
  removeWorktree: removeWorktreeMock,
}));

const broadcastGitStatus = vi.fn();
const tmuxSessionExists = vi.fn().mockReturnValue(false);
vi.mock('../../src/websocket-handlers.js', () => ({ broadcastGitStatus, tmuxSessionExists }));

const getAllSessions = vi.fn().mockReturnValue([]);
vi.mock('../../src/db/sessions.js', () => ({ getAllSessions }));

async function makeApp() {
  const { createGitRoutes } = await import('../../src/routes/git.js');
  const app = express();
  app.use(express.json());
  app.use('/api/git', createGitRoutes());
  return app;
}

describe('POST /api/git/worktree — create (AC1, AC2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createWorktreeMock.mockResolvedValue({ path: WORKTREE_PATH, branch: 'feat' });
    getRepoStatusMock.mockResolvedValue({ branch: { branchName: 'main', ahead: 0, behind: 0 }, files: [], stagedCount: 0, unstagedCount: 0, untrackedCount: 0, ignoredCount: 0, conflicted: 0 });
  });

  it('400 on missing project', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/git/worktree').send({ repo: REPO, branch: 'feat' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/project and repo are required/);
    expect(createWorktreeMock).not.toHaveBeenCalled();
  });

  it('400 on missing repo', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/git/worktree').send({ project: 'p', branch: 'feat' });
    expect(res.status).toBe(400);
    expect(createWorktreeMock).not.toHaveBeenCalled();
  });

  it('400 on missing branch', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/git/worktree').send({ project: 'p', repo: REPO });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/branch name is required/);
    expect(createWorktreeMock).not.toHaveBeenCalled();
  });

  it('400 on repo outside allowed root', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/git/worktree').send({ project: 'p', repo: '/etc', branch: 'feat' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/outside the allowed/);
    expect(createWorktreeMock).not.toHaveBeenCalled();
  });

  it('200 {ok, worktree} on success', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/git/worktree').send({ project: 'p', repo: REPO, branch: 'feat' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.worktree).toEqual({ path: WORKTREE_PATH, branch: 'feat' });
    expect(createWorktreeMock).toHaveBeenCalledWith(REPO, 'feat', { newBranch: false });
  });

  it('400 on "already exists" error from lib (AC1)', async () => {
    createWorktreeMock.mockRejectedValueOnce(new Error('branch already exists or is already checked out'));
    const app = await makeApp();
    const res = await request(app).post('/api/git/worktree').send({ project: 'p', repo: REPO, branch: 'dup' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already exists/);
  });

  it('400 on invalid reference error from lib', async () => {
    createWorktreeMock.mockRejectedValueOnce(new Error('invalid reference — branch does not exist'));
    const app = await makeApp();
    const res = await request(app).post('/api/git/worktree').send({ project: 'p', repo: REPO, branch: 'ghost' });
    expect(res.status).toBe(400);
  });

  it('400 (not 500) on validateSafeRef range-syntax / control-char reasons', async () => {
    for (const reason of ["ref contains '..' (range syntax)", 'ref contains control characters', 'ref starts with dash (injection risk)']) {
      createWorktreeMock.mockRejectedValueOnce(new Error(reason));
      const app = await makeApp();
      const res = await request(app).post('/api/git/worktree').send({ project: 'p', repo: REPO, branch: 'bad' });
      expect(res.status, reason).toBe(400);
      expect(res.body.error).toBe(reason);
    }
  });

  it('200 even when status broadcast throws (P9 isolation)', async () => {
    getRepoStatusMock.mockRejectedValueOnce(new Error('disk full'));
    const app = await makeApp();
    const res = await request(app).post('/api/git/worktree').send({ project: 'p', repo: REPO, branch: 'feat' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('POST /api/git/worktree/remove — gates (AC4, AC5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listWorktreesMock.mockResolvedValue([{ path: WORKTREE_PATH, branch: 'feat', head: 'abc', detached: false, bare: false }]);
    getRepoStatusMock.mockResolvedValue({ branch: { branchName: 'main', ahead: 0, behind: 0 }, files: [], stagedCount: 0, unstagedCount: 0, untrackedCount: 0, ignoredCount: 0, conflicted: 0 });
    getAllSessions.mockReturnValue([]);
    tmuxSessionExists.mockReturnValue(false);
    removeWorktreeMock.mockResolvedValue(undefined);
  });

  it('400 on missing path', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/git/worktree/remove').send({ project: 'p', repo: REPO });
    expect(res.status).toBe(400);
    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });

  it('400 on repo outside allowed root', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/git/worktree/remove').send({ project: 'p', repo: '/etc', path: WORKTREE_PATH });
    expect(res.status).toBe(400);
    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });

  it('400 when path is not a registered worktree', async () => {
    listWorktreesMock.mockResolvedValue([{ path: '/other/wt', branch: 'main', head: 'abc', detached: false, bare: false }]);
    const app = await makeApp();
    const res = await request(app).post('/api/git/worktree/remove').send({ project: 'p', repo: REPO, path: WORKTREE_PATH });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a registered worktree/);
    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });

  it('409 when a live tmux session is using the worktree — git NOT called (AC4)', async () => {
    getAllSessions.mockReturnValue([{ name: 'sess1', working_dir: WORKTREE_PATH, owner_id: null, archived_at: null, last_activity: 0 }]);
    tmuxSessionExists.mockReturnValue(true);
    const app = await makeApp();
    const res = await request(app).post('/api/git/worktree/remove').send({ project: 'p', repo: REPO, path: WORKTREE_PATH });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/live session/);
    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });

  it('409 when a live session is bound to a SUBFOLDER of the worktree (AC4)', async () => {
    getAllSessions.mockReturnValue([
      { name: 'sess1', working_dir: `${WORKTREE_PATH}/src`, owner_id: null, archived_at: null, last_activity: 0 },
    ]);
    tmuxSessionExists.mockReturnValue(true);
    const app = await makeApp();
    const res = await request(app).post('/api/git/worktree/remove').send({ project: 'p', repo: REPO, path: WORKTREE_PATH });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/live session/);
    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });

  it('does NOT match a session in an unrelated sibling path (no false positive)', async () => {
    getAllSessions.mockReturnValue([
      { name: 'sess1', working_dir: `${WORKTREE_PATH}-other`, owner_id: null, archived_at: null, last_activity: 0 },
    ]);
    tmuxSessionExists.mockReturnValue(true);
    const app = await makeApp();
    const res = await request(app).post('/api/git/worktree/remove').send({ project: 'p', repo: REPO, path: WORKTREE_PATH });
    expect(res.status).toBe(200);
    expect(removeWorktreeMock).toHaveBeenCalled();
  });

  it('409 with dirty:true when worktree has uncommitted changes and no force (AC5)', async () => {
    getRepoStatusMock.mockResolvedValue({ branch: { branchName: 'feat', ahead: 0, behind: 0 }, files: [], stagedCount: 1, unstagedCount: 0, untrackedCount: 0, ignoredCount: 0, conflicted: 0 });
    const app = await makeApp();
    const res = await request(app).post('/api/git/worktree/remove').send({ project: 'p', repo: REPO, path: WORKTREE_PATH });
    expect(res.status).toBe(409);
    expect(res.body.dirty).toBe(true);
    expect(removeWorktreeMock).not.toHaveBeenCalled();
  });

  it('calls removeWorktree with force:true when dirty + force (AC5)', async () => {
    getRepoStatusMock.mockResolvedValue({ branch: { branchName: 'feat', ahead: 0, behind: 0 }, files: [], stagedCount: 1, unstagedCount: 0, untrackedCount: 0, ignoredCount: 0, conflicted: 0 });
    const app = await makeApp();
    const res = await request(app).post('/api/git/worktree/remove').send({ project: 'p', repo: REPO, path: WORKTREE_PATH, force: true });
    expect(res.status).toBe(200);
    expect(removeWorktreeMock).toHaveBeenCalledWith(REPO, WORKTREE_PATH, { force: true });
  });

  it('200 on clean + no live session (happy path)', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/git/worktree/remove').send({ project: 'p', repo: REPO, path: WORKTREE_PATH });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(removeWorktreeMock).toHaveBeenCalledWith(REPO, WORKTREE_PATH, { force: false });
  });

  it('200 even when status broadcast throws after removal (P9)', async () => {
    getRepoStatusMock
      .mockResolvedValueOnce({ branch: { branchName: 'feat', ahead: 0, behind: 0 }, files: [], stagedCount: 0, unstagedCount: 0, untrackedCount: 0, ignoredCount: 0, conflicted: 0 }) // dirty check
      .mockRejectedValueOnce(new Error('disk full')); // broadcast
    const app = await makeApp();
    const res = await request(app).post('/api/git/worktree/remove').send({ project: 'p', repo: REPO, path: WORKTREE_PATH });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
