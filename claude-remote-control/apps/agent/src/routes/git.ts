/**
 * Git API routes: per-project repository status discovery and history operations.
 * Mirrors the task routes' viewer-isolation pattern (owner/isOwner query params).
 */

import { Router } from 'express';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { discoverRepos, getRepoStatus, getLog, getCommit, getFileDiff, getGraph, stagePaths, unstagePaths, commit, push, pull, branch, listWorktrees, createWorktree, removeWorktree } from '../lib/git.js';
import { broadcastGitStatus, tmuxSessionExists } from '../websocket-handlers.js';
import { getAllSessions } from '../db/sessions.js';
import { config } from '../config.js';

/**
 * Absolute, expanded allowed root for git operations. The `repo` query param is
 * client-controlled and flows into `git -C <repo>`, so every history route must
 * confine it to the configured projects root — otherwise a caller can read any
 * git repo the agent process can reach (the REST surface is not token-gated).
 */
function allowedRoot(): string {
  return resolve(config.projects.basePath.replace('~', process.env.HOME || ''));
}

/**
 * True when `target` is the allowed root or sits underneath it. Uses path
 * relativity (not string prefix) so `~/dev-secret` cannot pass as `~/dev`.
 */
function isContained(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Reject a `repo` that resolves outside the allowed projects root. */
function isRepoAllowed(repo: string): boolean {
  return isContained(allowedRoot(), resolve(repo));
}

/** Reject a per-file pathspec that escapes the repo tree (e.g. `../../etc/passwd`). */
function isFilePathAllowed(repo: string, filePath: string): boolean {
  const repoRoot = resolve(repo);
  return isContained(repoRoot, resolve(repoRoot, filePath));
}

/**
 * Canonicalize a path for comparison: resolve `..`/trailing-slash AND symlinks.
 * `git worktree list` emits realpath'd paths while a session's stored `working_dir`
 * is raw client input, so a symlinked component (e.g. macOS `/tmp`→`/private/tmp`)
 * would defeat a plain `resolve()` string compare. Falls back to `resolve()` when the
 * path no longer exists on disk (realpath throws).
 */
function canonicalPath(p: string): string {
  const resolved = resolve(p);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** True when `child` is `parent` or sits underneath it (both already canonical). */
function isAtOrUnder(parent: string, child: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

/**
 * True when a worktree create/remove error is the caller's fault (→ 400), not a
 * server fault (→ 500). Covers every `validateSafeRef` reason (whitespace, control
 * characters, dash/injection, `..` range syntax) plus the lib's mapped git stderr
 * (already exists / already checked out / invalid reference / uncommitted changes /
 * not a registered worktree).
 */
function isClientGitError(msg: string): boolean {
  return /already exists|already checked out|invalid reference|uncommitted changes|not a registered worktree|whitespace|control characters|injection|dash|range syntax|empty ref/.test(
    msg
  );
}

/**
 * Returns true if any live tmux session is currently bound to worktreePath
 * or to a subfolder within it. Cross-references DB sessions (working_dir)
 * against the tmux probe. Paths are symlink-canonicalized before comparison so
 * the destructive-remove gate cannot be defeated by a symlinked path component
 * or by a session bound to a sub-path of the worktree.
 */
function worktreeHasLiveSession(worktreePath: string): boolean {
  const sessions = getAllSessions();
  const target = canonicalPath(worktreePath);
  return sessions.some(
    (s) => s.working_dir !== null && s.working_dir !== undefined && isAtOrUnder(target, canonicalPath(s.working_dir)) && tmuxSessionExists(s.name)
  );
}

export function createGitRoutes(): Router {
  const router = Router();

  // GET /api/git/status?project=<projectPath>
  // Returns all git repos under the project directory with their status.
  router.get('/status', async (req, res) => {
    const projectRaw = req.query.project;
    const project = typeof projectRaw === 'string' && projectRaw ? projectRaw : undefined;

    if (!project) {
      return res.status(400).json({ error: 'project query parameter is required' });
    }

    try {
      // Discover all git repos under the project directory
      const discovery = await discoverRepos({ cwd: project });

      // Fetch status for each repo
      const repos = await Promise.all(
        discovery.repos.map(async (repo) => {
          try {
            const status = await getRepoStatus(repo.path);
            broadcastGitStatus(project, repo.path, status);
            return {
              repoPath: repo.path,
              isWorktree: !repo.topLevel,
              mainWorktree: repo.worktreeInfo?.mainWorktree,
              status,
            };
          } catch (err) {
            // If a repo's status fails, include it with error info
            return {
              repoPath: repo.path,
              isWorktree: !repo.topLevel,
              mainWorktree: repo.worktreeInfo?.mainWorktree,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        })
      );

      return res.json({
        repos,
        capped: discovery.capped,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return res.status(500).json({ error: message });
    }
  });

  // GET /api/git/worktrees?repo=<repoPath>
  // Returns list of worktrees for a repository (Story 6.5 FR8).
  router.get('/worktrees', async (req, res) => {
    const repoRaw = req.query.repo;
    const repo = typeof repoRaw === 'string' && repoRaw ? repoRaw : undefined;

    if (!repo) {
      return res.status(400).json({ error: 'repo query parameter is required' });
    }

    if (!isRepoAllowed(repo)) {
      return res.status(400).json({ error: 'repo is outside the allowed projects root' });
    }

    try {
      const worktrees = await listWorktrees(repo);
      return res.json({ worktrees });
    } catch (_err) {
      return res.status(500).json({ error: 'git operation failed' });
    }
  });

  // GET /api/git/log?repo=<repoPath>&limit=<n>&skip=<n>
  // Returns paginated commit history.
  router.get('/log', async (req, res) => {
    const repoRaw = req.query.repo;
    const repo = typeof repoRaw === 'string' && repoRaw ? repoRaw : undefined;

    if (!repo) {
      return res.status(400).json({ error: 'repo query parameter is required' });
    }

    if (!isRepoAllowed(repo)) {
      return res.status(400).json({ error: 'repo is outside the allowed projects root' });
    }

    const limitRaw = req.query.limit;
    const limitParsed = typeof limitRaw === 'string' ? parseInt(limitRaw, 10) : NaN;
    if (typeof limitRaw === 'string' && (isNaN(limitParsed) || limitParsed < 0)) {
      return res.status(400).json({ error: 'limit must be a non-negative integer' });
    }
    const limit = isNaN(limitParsed) ? undefined : Math.min(limitParsed, 500);

    const skipRaw = req.query.skip;
    const skipParsed = typeof skipRaw === 'string' ? parseInt(skipRaw, 10) : NaN;
    if (typeof skipRaw === 'string' && (isNaN(skipParsed) || skipParsed < 0)) {
      return res.status(400).json({ error: 'skip must be a non-negative integer' });
    }
    const skip = isNaN(skipParsed) ? undefined : skipParsed;

    try {
      const commits = await getLog(repo, { limit, skip });
      return res.json({ commits });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Invalid hash') || message.includes('Invalid ref')) {
        return res.status(400).json({ error: message });
      }
      return res.status(500).json({ error: 'git operation failed' });
    }
  });

  // GET /api/git/commit?repo=<repoPath>&hash=<hash>
  // Returns detailed commit information with file diffs.
  router.get('/commit', async (req, res) => {
    const repoRaw = req.query.repo;
    const repo = typeof repoRaw === 'string' && repoRaw ? repoRaw : undefined;

    if (!repo) {
      return res.status(400).json({ error: 'repo query parameter is required' });
    }

    if (!isRepoAllowed(repo)) {
      return res.status(400).json({ error: 'repo is outside the allowed projects root' });
    }

    const hashRaw = req.query.hash;
    const hash = typeof hashRaw === 'string' && hashRaw ? hashRaw : undefined;

    if (!hash) {
      return res.status(400).json({ error: 'hash query parameter is required' });
    }

    if (!/^[0-9a-fA-F]{7,40}$/.test(hash)) {
      return res.status(400).json({ error: 'hash must be 7-40 hex characters' });
    }

    try {
      const commitWithDiff = await getCommit(repo, hash);
      return res.json({ commit: commitWithDiff });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Invalid hash') || message.includes('Invalid ref')) {
        return res.status(400).json({ error: message });
      }
      return res.status(500).json({ error: 'git operation failed' });
    }
  });

  // GET /api/git/diff?repo=<repoPath>&hash=<hash>&path=<filePath>
  // Returns unified diff for a specific file in a commit.
  router.get('/diff', async (req, res) => {
    const repoRaw = req.query.repo;
    const repo = typeof repoRaw === 'string' && repoRaw ? repoRaw : undefined;

    if (!repo) {
      return res.status(400).json({ error: 'repo query parameter is required' });
    }

    if (!isRepoAllowed(repo)) {
      return res.status(400).json({ error: 'repo is outside the allowed projects root' });
    }

    const hashRaw = req.query.hash;
    const hash = typeof hashRaw === 'string' && hashRaw ? hashRaw : undefined;

    if (!hash) {
      return res.status(400).json({ error: 'hash query parameter is required' });
    }

    if (!/^[0-9a-fA-F]{7,40}$/.test(hash)) {
      return res.status(400).json({ error: 'hash must be 7-40 hex characters' });
    }

    // Support both 'path' (spec) and 'file' (legacy) for backwards compatibility
    const pathRaw = req.query.path ?? req.query.file;
    const filePath = typeof pathRaw === 'string' && pathRaw ? pathRaw : undefined;

    if (!filePath) {
      return res.status(400).json({ error: 'path query parameter is required' });
    }

    if (!isFilePathAllowed(repo, filePath)) {
      return res.status(400).json({ error: 'path is outside the repository tree' });
    }

    try {
      const diff = await getFileDiff(repo, hash, filePath);
      return res.json({ diff });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Invalid hash') || message.includes('Invalid ref')) {
        return res.status(400).json({ error: message });
      }
      return res.status(500).json({ error: 'git operation failed' });
    }
  });

  // GET /api/git/graph?repo=<repoPath>&maxCommits=<n>
  // Returns graph data for all branches (using --all).
  router.get('/graph', async (req, res) => {
    const repoRaw = req.query.repo;
    const repo = typeof repoRaw === 'string' && repoRaw ? repoRaw : undefined;

    if (!repo) {
      return res.status(400).json({ error: 'repo query parameter is required' });
    }

    if (!isRepoAllowed(repo)) {
      return res.status(400).json({ error: 'repo is outside the allowed projects root' });
    }

    const maxCommitsRaw = req.query.maxCommits;
    const maxCommitsParsed = typeof maxCommitsRaw === 'string' ? parseInt(maxCommitsRaw, 10) : NaN;
    if (typeof maxCommitsRaw === 'string' && (isNaN(maxCommitsParsed) || maxCommitsParsed < 1)) {
      return res.status(400).json({ error: 'maxCommits must be a positive integer' });
    }
    const maxCommits = isNaN(maxCommitsParsed) ? undefined : Math.min(maxCommitsParsed, 2000);

    try {
      const result = await getGraph(repo, { maxCommits });
      return res.json(result);
    } catch (_err) {
      return res.status(500).json({ error: 'git operation failed' });
    }
  });

  // POST /api/git/stage
  router.post('/stage', async (req, res) => {
    const { project, repo, pathspecs, all } = req.body;
    if (!project || !repo) {
      return res.status(400).json({ error: 'project and repo are required' });
    }
    if (!isRepoAllowed(repo)) {
      return res.status(400).json({ error: 'repo is outside the allowed projects root' });
    }

    const specs = all ? ['.'] : (Array.isArray(pathspecs) ? pathspecs : []);
    if (specs.length === 0) {
      return res.status(400).json({ error: 'pathspecs are required or all must be true' });
    }

    for (const p of specs) {
      if (typeof p !== 'string' || !isFilePathAllowed(repo, p)) {
        return res.status(400).json({ error: 'pathspec is outside the repository tree' });
      }
    }

    try {
      await stagePaths(repo, specs);
    } catch (_err) {
      return res.status(500).json({ error: 'git operation failed' });
    }
    try {
      const status = await getRepoStatus(repo);
      broadcastGitStatus(project, repo, status);
    } catch (_err) { /* status refresh best-effort */ }
    return res.json({ ok: true });
  });

  // POST /api/git/unstage
  router.post('/unstage', async (req, res) => {
    const { project, repo, pathspecs, all } = req.body;
    if (!project || !repo) {
      return res.status(400).json({ error: 'project and repo are required' });
    }
    if (!isRepoAllowed(repo)) {
      return res.status(400).json({ error: 'repo is outside the allowed projects root' });
    }

    const specs = all ? ['.'] : (Array.isArray(pathspecs) ? pathspecs : []);
    if (specs.length === 0) {
      return res.status(400).json({ error: 'pathspecs are required or all must be true' });
    }

    for (const p of specs) {
      if (typeof p !== 'string' || !isFilePathAllowed(repo, p)) {
        return res.status(400).json({ error: 'pathspec is outside the repository tree' });
      }
    }

    try {
      await unstagePaths(repo, specs);
    } catch (_err) {
      return res.status(500).json({ error: 'git operation failed' });
    }
    try {
      const status = await getRepoStatus(repo);
      broadcastGitStatus(project, repo, status);
    } catch (_err) { /* status refresh best-effort */ }
    return res.json({ ok: true });
  });

  // POST /api/git/commit
  router.post('/commit', async (req, res) => {
    const { project, repo, message: commitMsg } = req.body;
    if (!project || !repo) {
      return res.status(400).json({ error: 'project and repo are required' });
    }
    if (!isRepoAllowed(repo)) {
      return res.status(400).json({ error: 'repo is outside the allowed projects root' });
    }
    if (!commitMsg || typeof commitMsg !== 'string' || !commitMsg.trim()) {
      return res.status(400).json({ error: 'commit message is required' });
    }

    try {
      await commit(repo, commitMsg.trim());
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('no staged changes') || errMsg.includes('set git user.name')) {
        return res.status(400).json({ error: errMsg });
      }
      return res.status(500).json({ error: 'git operation failed' });
    }
    try {
      const status = await getRepoStatus(repo);
      broadcastGitStatus(project, repo, status);
    } catch (_err) { /* status refresh best-effort */ }
    return res.json({ ok: true });
  });

  // POST /api/git/push
  router.post('/push', async (req, res) => {
    const { project, repo } = req.body;
    if (!project || !repo) {
      return res.status(400).json({ error: 'project and repo are required' });
    }
    if (!isRepoAllowed(repo)) {
      return res.status(400).json({ error: 'repo is outside the allowed projects root' });
    }

    try {
      await push(repo);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('no upstream') || errMsg.includes('authentication') || errMsg.includes('non-fast-forward')) {
        return res.status(400).json({ error: errMsg });
      }
      return res.status(500).json({ error: 'git operation failed' });
    }
    try {
      const status = await getRepoStatus(repo);
      broadcastGitStatus(project, repo, status);
    } catch (_err) { /* status refresh best-effort */ }
    return res.json({ ok: true });
  });

  // POST /api/git/pull
  router.post('/pull', async (req, res) => {
    const { project, repo } = req.body;
    if (!project || !repo) {
      return res.status(400).json({ error: 'project and repo are required' });
    }
    if (!isRepoAllowed(repo)) {
      return res.status(400).json({ error: 'repo is outside the allowed projects root' });
    }

    try {
      await pull(repo);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('no upstream') || errMsg.includes('authentication') || errMsg.includes('conflicts')) {
        return res.status(400).json({ error: errMsg });
      }
      return res.status(500).json({ error: 'git operation failed' });
    }
    try {
      const status = await getRepoStatus(repo);
      broadcastGitStatus(project, repo, status);
    } catch (_err) { /* status refresh best-effort */ }
    return res.json({ ok: true });
  });

  // POST /api/git/worktree (create)
  router.post('/worktree', async (req, res) => {
    const { project, repo, branch: branchName, newBranch } = req.body;
    if (!project || !repo) {
      return res.status(400).json({ error: 'project and repo are required' });
    }
    if (!isRepoAllowed(repo)) {
      return res.status(400).json({ error: 'repo is outside the allowed projects root' });
    }
    if (!branchName || typeof branchName !== 'string') {
      return res.status(400).json({ error: 'branch name is required' });
    }

    let result: { path: string; branch: string };
    try {
      result = await createWorktree(repo, branchName, { newBranch: Boolean(newBranch) });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isClientGitError(errMsg)) {
        return res.status(400).json({ error: errMsg });
      }
      return res.status(500).json({ error: 'git operation failed' });
    }
    try {
      const status = await getRepoStatus(repo);
      broadcastGitStatus(project, repo, status);
    } catch (_err) { /* status refresh best-effort */ }
    return res.json({ ok: true, worktree: result });
  });

  // POST /api/git/worktree/remove
  router.post('/worktree/remove', async (req, res) => {
    const { project, repo, path, force } = req.body;
    if (!project || !repo || !path) {
      return res.status(400).json({ error: 'project, repo, and path are required' });
    }
    if (!isRepoAllowed(repo)) {
      return res.status(400).json({ error: 'repo is outside the allowed projects root' });
    }

    // Validate path is a registered worktree of this repo (git vouches; no isRepoAllowed check —
    // sibling worktrees live outside allowedRoot by design, FR8)
    let worktrees: Awaited<ReturnType<typeof listWorktrees>>;
    try {
      worktrees = await listWorktrees(repo);
    } catch (_err) {
      return res.status(500).json({ error: 'git operation failed' });
    }
    const target = canonicalPath(path);
    if (!worktrees.some(wt => canonicalPath(wt.path) === target)) {
      return res.status(400).json({ error: 'path is not a registered worktree of this repo' });
    }

    // AC4: live-session gate — BEFORE any git mutation
    const hasLive = worktreeHasLiveSession(path);
    if (hasLive) {
      return res.status(409).json({ error: 'a live session is using this worktree — end the session first' });
    }

    // AC5: dirty gate
    let repoStatus: Awaited<ReturnType<typeof getRepoStatus>>;
    try {
      repoStatus = await getRepoStatus(path);
    } catch (_err) {
      return res.status(500).json({ error: 'git operation failed' });
    }
    const dirty = repoStatus.stagedCount + repoStatus.unstagedCount + repoStatus.untrackedCount + repoStatus.conflicted > 0;
    if (dirty && !force) {
      return res.status(409).json({ error: 'worktree has uncommitted changes — confirm to remove', dirty: true });
    }

    try {
      await removeWorktree(repo, path, { force: Boolean(force) });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isClientGitError(errMsg)) {
        return res.status(400).json({ error: errMsg });
      }
      return res.status(500).json({ error: 'git operation failed' });
    }
    try {
      const status = await getRepoStatus(repo);
      broadcastGitStatus(project, repo, status);
    } catch (_err) { /* status refresh best-effort */ }
    return res.json({ ok: true });
  });

  // POST /api/git/branch
  router.post('/branch', async (req, res) => {
    const { project, repo, name, create } = req.body;
    if (!project || !repo) {
      return res.status(400).json({ error: 'project and repo are required' });
    }
    if (!isRepoAllowed(repo)) {
      return res.status(400).json({ error: 'repo is outside the allowed projects root' });
    }
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'branch name is required' });
    }

    try {
      await branch(repo, name, Boolean(create));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('uncommitted changes') || errMsg.includes('already exists') || errMsg.includes('injection') || errMsg.includes('whitespace')) {
        return res.status(400).json({ error: errMsg });
      }
      return res.status(500).json({ error: 'git operation failed' });
    }
    try {
      const status = await getRepoStatus(repo);
      broadcastGitStatus(project, repo, status);
    } catch (_err) { /* status refresh best-effort */ }
    return res.json({ ok: true });
  });

  return router;
}
