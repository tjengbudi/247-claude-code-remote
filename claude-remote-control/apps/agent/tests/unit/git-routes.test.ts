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
vi.mock('../../src/lib/git.js', () => ({
  discoverRepos: vi.fn().mockResolvedValue({ repos: [], capped: false }),
  getRepoStatus: vi.fn(),
  getLog,
  getCommit,
  getFileDiff,
  getGraph,
}));
vi.mock('../../src/websocket-handlers.js', () => ({ broadcastGitStatus: vi.fn() }));

async function makeApp() {
  const { createGitRoutes } = await import('../../src/routes/git.js');
  const app = express();
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
