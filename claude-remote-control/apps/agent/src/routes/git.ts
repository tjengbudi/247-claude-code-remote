/**
 * Git API routes: per-project repository status discovery and history operations.
 * Mirrors the task routes' viewer-isolation pattern (owner/isOwner query params).
 */

import { Router } from 'express';
import { resolve, relative, isAbsolute } from 'node:path';
import { discoverRepos, getRepoStatus, getLog, getCommit, getFileDiff, getGraph } from '../lib/git.js';
import { broadcastGitStatus } from '../websocket-handlers.js';
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

  return router;
}
