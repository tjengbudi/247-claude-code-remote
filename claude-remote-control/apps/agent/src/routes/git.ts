/**
 * Git API routes: per-project repository status discovery.
 * Mirrors the task routes' viewer-isolation pattern (owner/isOwner query params).
 */

import { Router } from 'express';
import { discoverRepos, getRepoStatus } from '../lib/git.js';
import { broadcastGitStatus } from '../websocket-handlers.js';

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

  return router;
}
