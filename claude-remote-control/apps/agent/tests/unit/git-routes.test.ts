/**
 * Git route guard tests (Story 6.3 code-review hardening).
 *
 * Focus: the `repo` and `path` query params are client-controlled and flow into
 * `git -C <repo> … -- <path>`. The REST surface is not token-gated, so every
 * history route must confine `repo` to the configured projects root and confine
 * the per-file `path` to the repo tree. These tests assert the 400 guards fire
 * before any git lib call is made.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';

const ALLOWED_ROOT = '/tmp/projects';

vi.mock('../../src/config.js', () => {
  const mockConfig = {
    machine: { id: 'm', name: 'M' },
    projects: { basePath: ALLOWED_ROOT, whitelist: [] },
  };
  return { config: mockConfig, loadConfig: () => mockConfig, default: mockConfig };
});

// Stub the git lib so a passing guard would resolve, letting us distinguish
// "blocked by guard" (lib never called) from "reached lib".
const getLog = vi.fn().mockResolvedValue([]);
const getCommit = vi.fn().mockResolvedValue({ files: [] });
const getFileDiff = vi.fn().mockResolvedValue('');
const getGraph = vi.fn().mockResolvedValue({ commits: [], capped: false });
const stagePaths = vi.fn().mockResolvedValue(undefined);
const unstagePaths = vi.fn().mockResolvedValue(undefined);
const commitFn = vi.fn().mockResolvedValue(undefined);
const pushFn = vi.fn().mockResolvedValue(undefined);
const pullFn = vi.fn().mockResolvedValue(undefined);
const branchFn = vi.fn().mockResolvedValue(undefined);
vi.mock('../../src/lib/git.js', () => ({
  discoverRepos: vi.fn().mockResolvedValue({ repos: [], capped: false }),
  getRepoStatus: vi.fn().mockResolvedValue({ branch: { branchName: 'main', ahead: 0, behind: 0 }, files: [], stagedCount: 0, unstagedCount: 0, untrackedCount: 0, ignoredCount: 0 }),
  getLog,
  getCommit,
  getFileDiff,
  getGraph,
  stagePaths,
  unstagePaths,
  commit: commitFn,
  push: pushFn,
  pull: pullFn,
  branch: branchFn,
}));
const broadcastGitStatus = vi.fn();
vi.mock('../../src/websocket-handlers.js', () => ({ broadcastGitStatus }));

async function makeApp() {
  const { createGitRoutes } = await import('../../src/routes/git.js');
  const app = express();
  app.use(express.json());
  app.use('/api/git', createGitRoutes());
  return app;
}

const HASH = 'a'.repeat(40);

describe('git routes — repo containment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a repo outside the allowed root on /log', async () => {
    const app = await makeApp();
    const res = await request(app).get('/api/git/log').query({ repo: '/etc' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/outside the allowed/);
    expect(getLog).not.toHaveBeenCalled();
  });

  it('rejects a traversal escape from the allowed root', async () => {
    const app = await makeApp();
    const res = await request(app)
      .get('/api/git/log')
      .query({ repo: `${ALLOWED_ROOT}/../../etc` });
    expect(res.status).toBe(400);
    expect(getLog).not.toHaveBeenCalled();
  });

  it('rejects a sibling that only string-prefixes the root', async () => {
    const app = await makeApp();
    const res = await request(app)
      .get('/api/git/log')
      .query({ repo: `${ALLOWED_ROOT}-secret` });
    expect(res.status).toBe(400);
    expect(getLog).not.toHaveBeenCalled();
  });

  it('allows a repo inside the allowed root', async () => {
    const app = await makeApp();
    const res = await request(app)
      .get('/api/git/log')
      .query({ repo: `${ALLOWED_ROOT}/myrepo` });
    expect(res.status).toBe(200);
    expect(getLog).toHaveBeenCalledTimes(1);
  });

  it('guards /commit and /graph the same way', async () => {
    const app = await makeApp();
    const c = await request(app).get('/api/git/commit').query({ repo: '/etc', hash: HASH });
    expect(c.status).toBe(400);
    expect(getCommit).not.toHaveBeenCalled();

    const g = await request(app).get('/api/git/graph').query({ repo: '/etc' });
    expect(g.status).toBe(400);
    expect(getGraph).not.toHaveBeenCalled();
  });
});

describe('git routes — per-file path containment (/diff)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects a path that escapes the repo tree', async () => {
    const app = await makeApp();
    const res = await request(app)
      .get('/api/git/diff')
      .query({ repo: `${ALLOWED_ROOT}/myrepo`, hash: HASH, path: '../../../etc/passwd' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/outside the repository tree/);
    expect(getFileDiff).not.toHaveBeenCalled();
  });

  it('allows a path inside the repo tree', async () => {
    const app = await makeApp();
    const res = await request(app)
      .get('/api/git/diff')
      .query({ repo: `${ALLOWED_ROOT}/myrepo`, hash: HASH, path: 'src/index.ts' });
    expect(res.status).toBe(200);
    expect(getFileDiff).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// Story 6.4 — write action route guards + argv + broadcast
// ============================================================================

const REPO = `${ALLOWED_ROOT}/myrepo`;

describe('git write routes — repo containment', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('POST /stage rejects repo outside allowed root', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/git/stage')
      .send({ project: 'p', repo: '/etc/passwd', pathspecs: ['file.ts'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/outside the allowed/);
    expect(stagePaths).not.toHaveBeenCalled();
  });

  it('POST /stage rejects pathspec escaping repo tree', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/git/stage')
      .send({ project: 'p', repo: REPO, pathspecs: ['../../etc/passwd'] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/outside the repository tree/);
    expect(stagePaths).not.toHaveBeenCalled();
  });

  it('POST /stage rejects non-string pathspec element', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/git/stage')
      .send({ project: 'p', repo: REPO, pathspecs: [null] });
    expect(res.status).toBe(400);
    expect(stagePaths).not.toHaveBeenCalled();
  });

  it('POST /stage rejects empty pathspecs without all flag', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/git/stage')
      .send({ project: 'p', repo: REPO, pathspecs: [] });
    expect(res.status).toBe(400);
    expect(stagePaths).not.toHaveBeenCalled();
  });

  it('POST /commit rejects repo outside allowed root', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/git/commit')
      .send({ project: 'p', repo: '/etc', message: 'msg' });
    expect(res.status).toBe(400);
    expect(commitFn).not.toHaveBeenCalled();
  });

  it('POST /commit rejects empty commit message', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/git/commit')
      .send({ project: 'p', repo: REPO, message: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/commit message is required/);
    expect(commitFn).not.toHaveBeenCalled();
  });

  it('POST /branch rejects repo outside allowed root', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/git/branch')
      .send({ project: 'p', repo: '/etc', name: 'feat' });
    expect(res.status).toBe(400);
    expect(branchFn).not.toHaveBeenCalled();
  });
});

describe('git write routes — success path + broadcast', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('POST /stage success calls stagePaths and broadcastGitStatus', async () => {
    const app = await makeApp();
    const res = await request(app).post('/api/git/stage')
      .send({ project: 'p', repo: REPO, pathspecs: ['src/index.ts'] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(stagePaths).toHaveBeenCalledWith(REPO, ['src/index.ts']);
    expect(broadcastGitStatus).toHaveBeenCalledTimes(1);
  });

  it('POST /stage all=true stages with ["."]', async () => {
    const app = await makeApp();
    await request(app).post('/api/git/stage')
      .send({ project: 'p', repo: REPO, all: true });
    expect(stagePaths).toHaveBeenCalledWith(REPO, ['.']);
  });

  it('POST /commit trims message before passing to lib', async () => {
    const app = await makeApp();
    await request(app).post('/api/git/commit')
      .send({ project: 'p', repo: REPO, message: '  fix bug  ' });
    expect(commitFn).toHaveBeenCalledWith(REPO, 'fix bug');
  });

  it('POST /commit surfaces actionable lib error as 400', async () => {
    commitFn.mockRejectedValueOnce(new Error('no staged changes to commit'));
    const app = await makeApp();
    const res = await request(app).post('/api/git/commit')
      .send({ project: 'p', repo: REPO, message: 'fix' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no staged changes/);
  });

  it('POST /commit surfaces generic lib error as 500', async () => {
    commitFn.mockRejectedValueOnce(new Error('commit failed'));
    const app = await makeApp();
    const res = await request(app).post('/api/git/commit')
      .send({ project: 'p', repo: REPO, message: 'fix' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('git operation failed');
  });

  it('POST /push sets no --force args (force-push has no code path)', async () => {
    const app = await makeApp();
    await request(app).post('/api/git/push').send({ project: 'p', repo: REPO });
    expect(pushFn).toHaveBeenCalledWith(REPO);
    const call = pushFn.mock.calls[0];
    const callStr = JSON.stringify(call);
    expect(callStr).not.toContain('--force');
    expect(callStr).not.toContain('--force-with-lease');
  });

  it('POST /pull surfaces conflict error as 400', async () => {
    pullFn.mockRejectedValueOnce(new Error('pull produced conflicts — resolve on the host'));
    const app = await makeApp();
    const res = await request(app).post('/api/git/pull').send({ project: 'p', repo: REPO });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/conflicts/);
  });

  it('POST /stage still returns ok:true when broadcastGitStatus throws', async () => {
    const { getRepoStatus } = await import('../../src/lib/git.js');
    vi.mocked(getRepoStatus).mockRejectedValueOnce(new Error('disk full'));
    const app = await makeApp();
    const res = await request(app).post('/api/git/stage')
      .send({ project: 'p', repo: REPO, pathspecs: ['file.ts'] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
