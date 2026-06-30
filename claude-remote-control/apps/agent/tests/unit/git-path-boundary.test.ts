/**
 * Story 6.7 — Git path-boundary hardening tests.
 *
 * Coverage:
 *   AC1 — symlink-escape rejection in isContained (routes) AND validateWorkingDir (lib)
 *   AC2 — GET /worktrees returns paths relative to allowedRoot (no absolute-path leak)
 *   AC3 — oversized workingDir rejected before path resolution (lib)
 *   AC4 — GET /status carries no absolute path (top-level 500 AND per-repo error)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mkdtemp, mkdir, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ============================================================================
// Hoist realpathSyncMock so it's available inside vi.mock factory
// ============================================================================

const realpathSyncMock = vi.hoisted(() => vi.fn((p: string) => String(p)));

// ============================================================================
// node:fs mock — override realpathSync used by routes/git.ts::canonicalPath
// ============================================================================

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, realpathSync: realpathSyncMock };
});

// ============================================================================
// Shared constants
// ============================================================================

const ALLOWED_ROOT = '/tmp/projects';
const REPO = `${ALLOWED_ROOT}/myrepo`;

// ============================================================================
// Config mock
// ============================================================================

vi.mock('../../src/config.js', () => {
  const mockConfig = {
    machine: { id: 'm', name: 'M' },
    projects: { basePath: ALLOWED_ROOT, whitelist: [] },
  };
  return { config: mockConfig, loadConfig: () => mockConfig, default: mockConfig };
});

// ============================================================================
// Git lib mock (routes tests only — AC3 uses vi.importActual)
// ============================================================================

const listWorktreesMock = vi.fn().mockResolvedValue([]);
const discoverReposMock = vi.fn();
const getRepoStatusMock = vi.fn();
const removeWorktreeMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/lib/git.js', () => ({
  discoverRepos: discoverReposMock,
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
  createWorktree: vi.fn().mockResolvedValue(undefined),
  removeWorktree: removeWorktreeMock,
  MAX_WORKING_DIR_LENGTH: 4096,
}));

vi.mock('../../src/websocket-handlers.js', () => ({
  broadcastGitStatus: vi.fn(),
  tmuxSessionExists: vi.fn().mockReturnValue(false),
}));

vi.mock('../../src/db/sessions.js', () => ({
  getAllSessions: vi.fn().mockReturnValue([]),
}));

// ============================================================================
// App factory — re-import after mocks are set up
// ============================================================================

async function makeApp() {
  const { createGitRoutes } = await import('../../src/routes/git.js');
  const app = express();
  app.use(express.json());
  app.use('/api/git', createGitRoutes());
  return app;
}

// ============================================================================
// AC1 — Symlink-escape rejection in route guards (isRepoAllowed)
// ============================================================================

describe('AC1 — symlink-safe containment in route guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: realpathSync is identity (no symlinks)
    realpathSyncMock.mockImplementation((p: string) => p);
    listWorktreesMock.mockResolvedValue([]);
    discoverReposMock.mockResolvedValue({ repos: [], capped: false });
  });

  it('GET /log rejects a symlink inside allowedRoot pointing outside', async () => {
    // /tmp/projects/escape-link is a symlink that resolves to /etc
    const symlinkPath = `${ALLOWED_ROOT}/escape-link`;
    realpathSyncMock.mockImplementation((p: string) => {
      if (p === symlinkPath) return '/etc';
      if (p.startsWith(symlinkPath)) return '/etc' + p.slice(symlinkPath.length);
      return p;
    });

    const app = await makeApp();
    const res = await request(app).get(`/api/git/log?repo=${encodeURIComponent(symlinkPath)}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/outside the allowed/);
  });

  it('GET /log allows a repo genuinely inside allowedRoot (no symlink)', async () => {
    realpathSyncMock.mockImplementation((p: string) => p);

    const app = await makeApp();
    const res = await request(app).get(`/api/git/log?repo=${encodeURIComponent(REPO)}`);
    // Guard passes — may 200 or 500 from git lib, but NOT 400 path rejection
    expect(res.status).not.toBe(400);
  });
});

// ============================================================================
// AC1 — symlink-escape rejection in validateWorkingDir (lib, real filesystem)
// ============================================================================

describe('AC1 — validateWorkingDir follows symlinks before containment', () => {
  it('rejects a symlink inside the root that points outside the root', async () => {
    const { validateWorkingDir } =
      await vi.importActual<typeof import('../../src/lib/git.js')>('../../src/lib/git.js');

    // root/  and  outside/  are siblings; root/escape -> outside
    const base = await realpath(await mkdtemp(join(tmpdir(), 'wt-ac1-')));
    const root = join(base, 'root');
    const outside = join(base, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, 'escape'));

    try {
      // A symlinked path inside root that realpath-resolves outside root must be denied.
      const result = await validateWorkingDir(join(root, 'escape'), root);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/outside the project root/i);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it('accepts a genuine subfolder inside the root (no symlink)', async () => {
    const { validateWorkingDir } =
      await vi.importActual<typeof import('../../src/lib/git.js')>('../../src/lib/git.js');

    const root = await realpath(await mkdtemp(join(tmpdir(), 'wt-ac1ok-')));
    const sub = join(root, 'sub');
    await mkdir(sub);

    try {
      const result = await validateWorkingDir(sub, root);
      expect(result.valid).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// AC2 — GET /worktrees returns paths relative to allowedRoot (no absolute-path leak)
// ============================================================================

describe('AC2 — GET /worktrees redacts absolute host paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    realpathSyncMock.mockImplementation((p: string) => p);
  });

  it('worktree paths are returned relative to allowedRoot — no absolute path leaked', async () => {
    const inside = { path: `${ALLOWED_ROOT}/myrepo/.worktrees/feat`, branch: 'feat', head: 'abc', detached: false, bare: false };
    listWorktreesMock.mockResolvedValue([inside]);

    const app = await makeApp();
    const res = await request(app).get(`/api/git/worktrees?repo=${encodeURIComponent(REPO)}`);
    expect(res.status).toBe(200);
    const paths: string[] = res.body.worktrees.map((wt: { path: string }) => wt.path);
    // relative to ALLOWED_ROOT, not the absolute host path
    expect(paths).toContain('myrepo/.worktrees/feat');
    expect(paths.every((p) => !p.startsWith(ALLOWED_ROOT))).toBe(true);
  });

  it('a sibling worktree outside allowedRoot is still returned, but as a ../-relative path', async () => {
    // worktreeSiblingPath places worktrees in gitRoot's parent, so a repo at allowedRoot
    // produces siblings outside it. They must NOT be hidden — just redacted to relative.
    const outside = { path: '/tmp/.247-worktrees/projects/feat', branch: 'feat', head: 'abc', detached: false, bare: false };
    listWorktreesMock.mockResolvedValue([outside]);

    const app = await makeApp();
    const res = await request(app).get(`/api/git/worktrees?repo=${encodeURIComponent(REPO)}`);
    expect(res.status).toBe(200);
    const paths: string[] = res.body.worktrees.map((wt: { path: string }) => wt.path);
    expect(res.body.worktrees).toHaveLength(1);
    expect(paths[0]).toBe('../.247-worktrees/projects/feat');
    expect(paths[0].startsWith(ALLOWED_ROOT)).toBe(false);
  });

  it('returns all worktrees (none hidden) when all are inside allowedRoot', async () => {
    const wt1 = { path: `${ALLOWED_ROOT}/myrepo`, branch: 'main', head: 'abc', detached: false, bare: false };
    const wt2 = { path: `${ALLOWED_ROOT}/myrepo/.worktrees/feat`, branch: 'feat', head: 'def', detached: false, bare: false };
    listWorktreesMock.mockResolvedValue([wt1, wt2]);

    const app = await makeApp();
    const res = await request(app).get(`/api/git/worktrees?repo=${encodeURIComponent(REPO)}`);
    expect(res.status).toBe(200);
    expect(res.body.worktrees).toHaveLength(2);
    const paths: string[] = res.body.worktrees.map((wt: { path: string }) => wt.path);
    expect(paths).toContain('myrepo');
    expect(paths).toContain('myrepo/.worktrees/feat');
  });

  it('round-trip: a relative path from GET /worktrees removes the correct absolute worktree', async () => {
    // Out-of-root sibling (the worktreeSiblingPath case): GET returns it as ../-relative.
    const absWt = '/tmp/.247-worktrees/projects/feat';
    listWorktreesMock.mockResolvedValue([
      { path: absWt, branch: 'feat', head: 'abc', detached: false, bare: false },
    ]);
    getRepoStatusMock.mockResolvedValue({ stagedCount: 0, unstagedCount: 0, untrackedCount: 0, conflicted: 0 });

    const app = await makeApp();
    // 1. GET → relative path
    const listRes = await request(app).get(`/api/git/worktrees?repo=${encodeURIComponent(REPO)}`);
    const relPath: string = listRes.body.worktrees[0].path;
    expect(relPath).toBe('../.247-worktrees/projects/feat');

    // 2. POST that exact relative path back to remove
    const rmRes = await request(app)
      .post('/api/git/worktree/remove')
      .send({ project: REPO, repo: REPO, path: relPath, force: true });
    expect(rmRes.status).toBe(200);
    // removeWorktree must receive the canonical ABSOLUTE path, not the raw relative string
    // (raw relative would resolve against process.cwd and remove the wrong / a nonexistent tree).
    expect(removeWorktreeMock).toHaveBeenCalledWith(REPO, absWt, { force: true });
  });
});

// ============================================================================
// AC3 — validateWorkingDir length guard (real lib via importActual)
// ============================================================================

describe('AC3 — validateWorkingDir rejects oversized input', () => {
  it('returns invalid when workingDir exceeds MAX_WORKING_DIR_LENGTH', async () => {
    const { validateWorkingDir, MAX_WORKING_DIR_LENGTH } =
      await vi.importActual<typeof import('../../src/lib/git.js')>('../../src/lib/git.js');
    const oversized = 'a'.repeat(MAX_WORKING_DIR_LENGTH + 1);
    const result = await validateWorkingDir(oversized, '/tmp/projects/myrepo');
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/maximum/i);
  });

  it('length guard does not trigger at exactly MAX_WORKING_DIR_LENGTH', async () => {
    const { validateWorkingDir, MAX_WORKING_DIR_LENGTH } =
      await vi.importActual<typeof import('../../src/lib/git.js')>('../../src/lib/git.js');
    // At exactly the limit: length guard must not fire (may still fail for path-existence)
    const prefix = '/tmp/projects/myrepo/';
    const atLimit = prefix + 'a'.repeat(MAX_WORKING_DIR_LENGTH - prefix.length);
    const result = await validateWorkingDir(atLimit, '/tmp/projects/myrepo');
    // Should NOT fail with "maximum" message (might fail for path-not-found, that's OK)
    expect(result.reason ?? '').not.toMatch(/maximum/i);
  });
});

// ============================================================================
// AC4 — GET /status 500 body does not leak raw err.message
// ============================================================================

describe('AC4 — GET /status redacts raw err.message on 500', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    realpathSyncMock.mockImplementation((p: string) => p);
  });

  it('500 body is generic — no absolute path leaked — when discoverRepos throws', async () => {
    const internalPath = '/home/user/.247/secrets/db.sqlite';
    discoverReposMock.mockRejectedValueOnce(new Error(`disk error at ${internalPath}`));

    const app = await makeApp();
    const res = await request(app).get(`/api/git/status?project=${encodeURIComponent(REPO)}`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('git operation failed');
    expect(JSON.stringify(res.body)).not.toContain(internalPath);
  });

  it('per-repo error is redacted — no raw err.message leaked in the 200 body', async () => {
    // discoverRepos succeeds, but a single repo's getRepoStatus throws an internal path.
    const internalPath = '/home/user/dev/projects/myrepo/.git/index.lock';
    discoverReposMock.mockResolvedValueOnce({ repos: [{ path: REPO, topLevel: true }], capped: false });
    getRepoStatusMock.mockRejectedValueOnce(new Error(`fatal: ${internalPath}`));

    const app = await makeApp();
    const res = await request(app).get(`/api/git/status?project=${encodeURIComponent(REPO)}`);
    expect(res.status).toBe(200);
    expect(res.body.repos[0].error).toBe('git operation failed');
    expect(JSON.stringify(res.body)).not.toContain(internalPath);
  });
});
