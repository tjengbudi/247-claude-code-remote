'use client';

import { useCallback } from 'react';
import { toast } from 'sonner';
import { buildApiUrl } from '@/lib/utils';
import { viewerParams } from '@/contexts/SessionPollingContext';
import type { AgentConnection } from './useAgentConnections';
import type { GitCommit, GitCommitWithDiff } from '247-shared';

export interface GitViewer {
  ownerId: string | null;
  isOwner: boolean;
}

interface UseGitActionsReturn {
  fetchLog: (
    machineId: string,
    repo: string,
    limit?: number,
    skip?: number
  ) => Promise<GitCommit[] | null>;
  fetchCommit: (
    machineId: string,
    repo: string,
    hash: string
  ) => Promise<GitCommitWithDiff | null>;
  fetchDiff: (
    machineId: string,
    repo: string,
    hash: string,
    filePath: string,
    signal?: AbortSignal
  ) => Promise<string | null>;
  fetchGraph: (
    machineId: string,
    repo: string,
    maxCommits?: number
  ) => Promise<{ commits: GitCommit[]; capped: boolean } | null>;
  stageFiles: (
    machineId: string,
    repo: string,
    pathspecs: string[],
    all?: boolean
  ) => Promise<boolean>;
  unstageFiles: (
    machineId: string,
    repo: string,
    pathspecs: string[],
    all?: boolean
  ) => Promise<boolean>;
  commitChanges: (
    machineId: string,
    repo: string,
    message: string
  ) => Promise<boolean>;
  pushChanges: (
    machineId: string,
    repo: string
  ) => Promise<boolean>;
  pullChanges: (
    machineId: string,
    repo: string
  ) => Promise<boolean>;
  switchBranch: (
    machineId: string,
    repo: string,
    name: string,
    create?: boolean
  ) => Promise<boolean>;
}

/**
 * Hook for git history actions (log, commit detail, diff, graph).
 * Follows the same pattern as useTaskActions: buildApiUrl + withViewer + toast on error.
 */
export function useGitActions(
  agentConnections: AgentConnection[],
  viewer: GitViewer
): UseGitActionsReturn {
  const findMachine = useCallback(
    (machineId: string) => {
      return agentConnections.find((c) => c.id === machineId);
    },
    [agentConnections]
  );

  const withViewer = useCallback(
    (path: string) => {
      const qs = viewerParams(viewer);
      return `${path}${qs ? `?${qs}` : ''}`;
    },
    [viewer]
  );

  const fetchLog = useCallback(
    async (
      machineId: string,
      repo: string,
      limit = 50,
      skip = 0
    ): Promise<GitCommit[] | null> => {
      const machine = findMachine(machineId);
      if (!machine) {
        toast.error('Agent not found');
        return null;
      }

      try {
        const base = withViewer(`/api/git/log`);
        const sep = base.includes('?') ? '&' : '?';
        const url = buildApiUrl(
          machine.url,
          `${base}${sep}repo=${encodeURIComponent(repo)}&limit=${limit}&skip=${skip}`
        );
        const response = await fetch(url);
        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'Failed to fetch log' }));
          toast.error(err.error || 'Failed to fetch log');
          return null;
        }
        const data = await response.json();
        return data.commits || [];
      } catch (err) {
        console.error('Failed to fetch git log:', err);
        toast.error('Could not connect to agent');
        return null;
      }
    },
    [findMachine, withViewer]
  );

  const fetchCommit = useCallback(
    async (
      machineId: string,
      repo: string,
      hash: string
    ): Promise<GitCommitWithDiff | null> => {
      const machine = findMachine(machineId);
      if (!machine) {
        toast.error('Agent not found');
        return null;
      }

      try {
        const base = withViewer(`/api/git/commit`);
        const sep = base.includes('?') ? '&' : '?';
        const url = buildApiUrl(
          machine.url,
          `${base}${sep}repo=${encodeURIComponent(repo)}&hash=${encodeURIComponent(hash)}`
        );
        const response = await fetch(url);
        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'Failed to fetch commit' }));
          toast.error(err.error || 'Failed to fetch commit');
          return null;
        }
        const data = await response.json();
        return data.commit || null;
      } catch (err) {
        console.error('Failed to fetch git commit:', err);
        toast.error('Could not connect to agent');
        return null;
      }
    },
    [findMachine, withViewer]
  );

  const fetchDiff = useCallback(
    async (
      machineId: string,
      repo: string,
      hash: string,
      filePath: string,
      signal?: AbortSignal
    ): Promise<string | null> => {
      const machine = findMachine(machineId);
      if (!machine) {
        toast.error('Agent not found');
        return null;
      }

      try {
        const base = withViewer(`/api/git/diff`);
        const sep = base.includes('?') ? '&' : '?';
        const url = buildApiUrl(
          machine.url,
          `${base}${sep}repo=${encodeURIComponent(repo)}&hash=${encodeURIComponent(hash)}&path=${encodeURIComponent(filePath)}`
        );
        const response = await fetch(url, { signal });
        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'Failed to fetch diff' }));
          toast.error(err.error || 'Failed to fetch diff');
          return null;
        }
        const data = await response.json();
        return data.diff || null;
      } catch (err) {
        // Aborted fetches are intentional (commit/repo switch) — stay silent.
        if (err instanceof DOMException && err.name === 'AbortError') return null;
        console.error('Failed to fetch git diff:', err);
        toast.error('Could not connect to agent');
        return null;
      }
    },
    [findMachine, withViewer]
  );

  const fetchGraph = useCallback(
    async (
      machineId: string,
      repo: string,
      maxCommits = 500
    ): Promise<{ commits: GitCommit[]; capped: boolean } | null> => {
      const machine = findMachine(machineId);
      if (!machine) {
        toast.error('Agent not found');
        return null;
      }

      try {
        const base = withViewer(`/api/git/graph`);
        const sep = base.includes('?') ? '&' : '?';
        const url = buildApiUrl(
          machine.url,
          `${base}${sep}repo=${encodeURIComponent(repo)}&maxCommits=${maxCommits}`
        );
        const response = await fetch(url);
        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'Failed to fetch graph' }));
          toast.error(err.error || 'Failed to fetch graph');
          return null;
        }
        const data = await response.json();
        return { commits: data.commits || [], capped: data.capped || false };
      } catch (err) {
        console.error('Failed to fetch git graph:', err);
        toast.error('Could not connect to agent');
        return null;
      }
    },
    [findMachine, withViewer]
  );

  const stageFiles = useCallback(
    async (
      machineId: string,
      repo: string,
      pathspecs: string[],
      all = false
    ): Promise<boolean> => {
      const machine = findMachine(machineId);
      if (!machine) {
        toast.error('Agent not found');
        return false;
      }

      try {
        const url = buildApiUrl(machine.url, '/api/git/stage');
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: machine.id, repo, pathspecs, all }),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'Failed to stage files' }));
          toast.error(err.error || 'Failed to stage files');
          return false;
        }
        return true;
      } catch (err) {
        console.error('Failed to stage files:', err);
        toast.error('Could not connect to agent');
        return false;
      }
    },
    [findMachine]
  );

  const unstageFiles = useCallback(
    async (
      machineId: string,
      repo: string,
      pathspecs: string[],
      all = false
    ): Promise<boolean> => {
      const machine = findMachine(machineId);
      if (!machine) {
        toast.error('Agent not found');
        return false;
      }

      try {
        const url = buildApiUrl(machine.url, '/api/git/unstage');
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: machine.id, repo, pathspecs, all }),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'Failed to unstage files' }));
          toast.error(err.error || 'Failed to unstage files');
          return false;
        }
        return true;
      } catch (err) {
        console.error('Failed to unstage files:', err);
        toast.error('Could not connect to agent');
        return false;
      }
    },
    [findMachine]
  );

  const commitChanges = useCallback(
    async (
      machineId: string,
      repo: string,
      message: string
    ): Promise<boolean> => {
      const machine = findMachine(machineId);
      if (!machine) {
        toast.error('Agent not found');
        return false;
      }

      try {
        const url = buildApiUrl(machine.url, '/api/git/commit');
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: machine.id, repo, message }),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'Failed to commit' }));
          toast.error(err.error || 'Failed to commit');
          return false;
        }
        return true;
      } catch (err) {
        console.error('Failed to commit:', err);
        toast.error('Could not connect to agent');
        return false;
      }
    },
    [findMachine]
  );

  const pushChanges = useCallback(
    async (machineId: string, repo: string): Promise<boolean> => {
      const machine = findMachine(machineId);
      if (!machine) {
        toast.error('Agent not found');
        return false;
      }

      try {
        const url = buildApiUrl(machine.url, '/api/git/push');
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: machine.id, repo }),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'Failed to push' }));
          toast.error(err.error || 'Failed to push');
          return false;
        }
        return true;
      } catch (err) {
        console.error('Failed to push:', err);
        toast.error('Could not connect to agent');
        return false;
      }
    },
    [findMachine]
  );

  const pullChanges = useCallback(
    async (machineId: string, repo: string): Promise<boolean> => {
      const machine = findMachine(machineId);
      if (!machine) {
        toast.error('Agent not found');
        return false;
      }

      try {
        const url = buildApiUrl(machine.url, '/api/git/pull');
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: machine.id, repo }),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'Failed to pull' }));
          toast.error(err.error || 'Failed to pull');
          return false;
        }
        return true;
      } catch (err) {
        console.error('Failed to pull:', err);
        toast.error('Could not connect to agent');
        return false;
      }
    },
    [findMachine]
  );

  const switchBranch = useCallback(
    async (
      machineId: string,
      repo: string,
      name: string,
      create = false
    ): Promise<boolean> => {
      const machine = findMachine(machineId);
      if (!machine) {
        toast.error('Agent not found');
        return false;
      }

      try {
        const url = buildApiUrl(machine.url, '/api/git/branch');
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: machine.id, repo, name, create }),
        });

        if (!response.ok) {
          const err = await response.json().catch(() => ({ error: 'Failed to switch branch' }));
          toast.error(err.error || 'Failed to switch branch');
          return false;
        }
        return true;
      } catch (err) {
        console.error('Failed to switch branch:', err);
        toast.error('Could not connect to agent');
        return false;
      }
    },
    [findMachine]
  );

  return {
    fetchLog,
    fetchCommit,
    fetchDiff,
    fetchGraph,
    stageFiles,
    unstageFiles,
    commitChanges,
    pushChanges,
    pullChanges,
    switchBranch,
  };
}
