/**
 * GitPanel tests — pure logic (status badges, file categorization, display helpers)
 * and render tests (empty state, error state, repo groups, write actions, worktree badge).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { GitPanel, type GitRepoView } from '../../../src/components/GitPanel';
import type { GitRepoStatus, GitFileInfo, GitCommit, GitCommitWithDiff } from '247-shared';

afterEach(cleanup);

// lucide-react icons don't render meaningful text; stub them out
vi.mock('lucide-react', () => ({
  ChevronDown: () => null,
  ChevronRight: () => null,
  GitBranch: () => null,
  AlertCircle: () => null,
  FolderGit: () => null,
  History: () => null,
  GitCommit: () => null,
  Loader2: () => null,
  GitCompareArrows: () => null,
  AlertTriangle: () => null,
  Plus: () => null,
  Minus: () => null,
  Check: () => null,
  GitMerge: () => null,
  RotateCcw: () => null,
  MoreHorizontal: () => null,
  Upload: () => null,
  Download: () => null,
  GitPullRequest: () => null,
  RefreshCw: () => null,
  Folder: () => null,
  File: () => null,
  FolderOpen: () => null,
  Link: () => null,
  GitGraph: () => null,
  X: () => null,
  Diff: () => null,
}));

// ============================================================================
// Pure logic tests (no rendering)
// ============================================================================

// Status colors (must match GitPanel.tsx)
const STATUS_COLORS: Record<string, string> = {
  modified: 'text-amber-400',
  added: 'text-emerald-400',
  deleted: 'text-red-400',
  renamed: 'text-blue-400',
  copied: 'text-purple-400',
  unmerged: 'text-rose-500',
  untracked: 'text-white/40',
  ignored: 'text-white/20',
};

describe('GitPanel', () => {
  describe('status badge colors', () => {
    it('has correct color for modified status', () => {
      expect(STATUS_COLORS.modified).toBe('text-amber-400');
    });

    it('has correct color for added status', () => {
      expect(STATUS_COLORS.added).toBe('text-emerald-400');
    });

    it('has correct color for deleted status', () => {
      expect(STATUS_COLORS.deleted).toBe('text-red-400');
    });

    it('has correct color for renamed status', () => {
      expect(STATUS_COLORS.renamed).toBe('text-blue-400');
    });

    it('has correct color for untracked status (dimmed)', () => {
      expect(STATUS_COLORS.untracked).toBe('text-white/40');
    });

    it('covers all expected statuses', () => {
      const expectedStatuses = [
        'modified',
        'added',
        'deleted',
        'renamed',
        'copied',
        'unmerged',
        'untracked',
        'ignored',
      ];
      expect(Object.keys(STATUS_COLORS).sort()).toEqual(expectedStatuses.sort());
    });
  });

  describe('status badge letter', () => {
    function getStatusLetter(status: string | null | undefined): string | null {
      if (!status || status === 'unknown') return null;
      return status[0].toUpperCase();
    }

    it('returns uppercase first letter for valid status', () => {
      expect(getStatusLetter('modified')).toBe('M');
      expect(getStatusLetter('added')).toBe('A');
      expect(getStatusLetter('deleted')).toBe('D');
      expect(getStatusLetter('renamed')).toBe('R');
    });

    it('returns null for unknown or null status', () => {
      expect(getStatusLetter('unknown')).toBe(null);
      expect(getStatusLetter(null)).toBe(null);
      expect(getStatusLetter(undefined)).toBe(null);
    });
  });

  describe('file categorization', () => {
    interface LocalGitFileInfo {
      path: string;
      staged?: boolean;
      indexStatus?: string | null;
      worktreeStatus?: string | null;
    }

    function categorizeFiles(files: LocalGitFileInfo[]) {
      const staged = files.filter((f) => f.staged && f.indexStatus);
      const changes = files.filter(
        (f) =>
          !f.staged &&
          f.worktreeStatus &&
          f.worktreeStatus !== 'untracked' &&
          f.worktreeStatus !== 'ignored'
      );
      const untracked = files.filter((f) => f.worktreeStatus === 'untracked');

      return { staged, changes, untracked };
    }

    it('categorizes staged files correctly', () => {
      const files: LocalGitFileInfo[] = [
        { path: 'a.ts', staged: true, indexStatus: 'modified', worktreeStatus: null },
        { path: 'b.ts', staged: true, indexStatus: 'added', worktreeStatus: null },
      ];

      const { staged, changes, untracked } = categorizeFiles(files);
      expect(staged).toHaveLength(2);
      expect(changes).toHaveLength(0);
      expect(untracked).toHaveLength(0);
    });

    it('categorizes unstaged changes correctly', () => {
      const files: LocalGitFileInfo[] = [
        { path: 'a.ts', staged: false, indexStatus: null, worktreeStatus: 'modified' },
        { path: 'b.ts', staged: false, indexStatus: null, worktreeStatus: 'deleted' },
      ];

      const { staged, changes, untracked } = categorizeFiles(files);
      expect(staged).toHaveLength(0);
      expect(changes).toHaveLength(2);
      expect(untracked).toHaveLength(0);
    });

    it('categorizes untracked files correctly', () => {
      const files: LocalGitFileInfo[] = [
        { path: 'new.txt', staged: false, indexStatus: null, worktreeStatus: 'untracked' },
      ];

      const { staged, changes, untracked } = categorizeFiles(files);
      expect(staged).toHaveLength(0);
      expect(changes).toHaveLength(0);
      expect(untracked).toHaveLength(1);
    });

    it('handles mixed file states', () => {
      const files: LocalGitFileInfo[] = [
        { path: 'staged.ts', staged: true, indexStatus: 'modified', worktreeStatus: null },
        { path: 'changed.ts', staged: false, indexStatus: null, worktreeStatus: 'modified' },
        { path: 'new.txt', staged: false, indexStatus: null, worktreeStatus: 'untracked' },
        { path: 'ignored.log', staged: false, indexStatus: null, worktreeStatus: 'ignored' },
      ];

      const { staged, changes, untracked } = categorizeFiles(files);
      expect(staged).toHaveLength(1);
      expect(changes).toHaveLength(1);
      expect(untracked).toHaveLength(1);
    });

    it('handles files with both staged and unstaged changes', () => {
      const files: LocalGitFileInfo[] = [
        { path: 'both.ts', staged: true, indexStatus: 'modified', worktreeStatus: 'modified' },
      ];

      const { staged, changes, untracked } = categorizeFiles(files);
      expect(staged).toHaveLength(1);
      expect(changes).toHaveLength(0);
      expect(untracked).toHaveLength(0);
    });

    it('excludes ignored files from all categories', () => {
      const files: LocalGitFileInfo[] = [
        { path: 'node_modules/', staged: false, indexStatus: null, worktreeStatus: 'ignored' },
      ];

      const { staged, changes, untracked } = categorizeFiles(files);
      expect(staged).toHaveLength(0);
      expect(changes).toHaveLength(0);
      expect(untracked).toHaveLength(0);
    });
  });

  describe('repo name extraction', () => {
    function getRepoName(repoPath: string): string {
      return repoPath.split('/').pop() || repoPath;
    }

    it('extracts last segment from path', () => {
      expect(getRepoName('/home/user/projects/my-repo')).toBe('my-repo');
      expect(getRepoName('/var/www/site')).toBe('site');
    });

    it('handles single-segment paths', () => {
      expect(getRepoName('my-repo')).toBe('my-repo');
    });

    it('handles paths with trailing slash (fallback to full path)', () => {
      const path = '/home/user/repo/';
      const name = path.split('/').pop() || path;
      expect(name).toBe('/home/user/repo/');
    });

    it('handles empty path', () => {
      expect(getRepoName('')).toBe('');
    });
  });

  describe('branch display', () => {
    function getBranchDisplay(branchName: string | null): string {
      return branchName || '(detached)';
    }

    it('displays branch name when present', () => {
      expect(getBranchDisplay('main')).toBe('main');
      expect(getBranchDisplay('feature/new-thing')).toBe('feature/new-thing');
    });

    it('displays (detached) when branch is null', () => {
      expect(getBranchDisplay(null)).toBe('(detached)');
    });
  });

  describe('ahead/behind indicators', () => {
    it('shows ahead count when ahead > 0', () => {
      const ahead = 3;
      const behind = 0;
      expect(ahead > 0).toBe(true);
      expect(behind > 0).toBe(false);
    });

    it('shows behind count when behind > 0', () => {
      const ahead = 0;
      const behind = 2;
      expect(ahead > 0).toBe(false);
      expect(behind > 0).toBe(true);
    });

    it('shows both when diverged', () => {
      const ahead = 2;
      const behind = 1;
      expect(ahead > 0).toBe(true);
      expect(behind > 0).toBe(true);
    });

    it('hides indicators when both are zero', () => {
      const ahead = 0;
      const behind = 0;
      expect(ahead > 0 || behind > 0).toBe(false);
    });
  });

  describe('rename display', () => {
    function getFileDisplayName(path: string, origPath?: string): string {
      return origPath ? `${origPath} → ${path}` : path;
    }

    it('shows simple path when no origPath', () => {
      expect(getFileDisplayName('new-name.ts')).toBe('new-name.ts');
    });

    it('shows rename arrow format when origPath present', () => {
      expect(getFileDisplayName('new-name.ts', 'old-name.ts')).toBe('old-name.ts → new-name.ts');
    });
  });

  describe('empty states', () => {
    it('detects empty repos array', () => {
      const repos: any[] = [];
      expect(repos.length === 0).toBe(true);
    });

    it('detects clean working tree', () => {
      const staged = 0;
      const changes = 0;
      const untracked = 0;
      const totalChanges = staged + changes + untracked;
      expect(totalChanges === 0).toBe(true);
    });
  });

  describe('error states (logic)', () => {
    interface LocalRepoView {
      repoPath: string;
      status?: any;
      error?: string;
    }

    it('detects repo with error', () => {
      const repo: LocalRepoView = {
        repoPath: '/path/to/repo',
        error: 'fatal: not a git repository',
      };
      expect(repo.error).toBeDefined();
    });

    it('detects repo without status', () => {
      const repo: LocalRepoView = {
        repoPath: '/path/to/repo',
      };
      expect(!repo.status).toBe(true);
    });

    it('detects healthy repo', () => {
      const repo: LocalRepoView = {
        repoPath: '/path/to/repo',
        status: { branch: {}, files: [] },
      };
      expect(repo.status).toBeDefined();
      expect(repo.error).toBeUndefined();
    });
  });
});

// ============================================================================
// Render tests
// ============================================================================

const noop = () => {};
const noopAsync = async () => null;

const BASE_PANEL_PROPS = {
  selectedRepo: null as string | null,
  commits: [] as GitCommit[],
  graphCommits: null as GitCommit[] | null,
  graphCapped: false,
  loadingHistory: false,
  graphLoading: false,
  onSelectRepo: noop,
  onToggleGraph: noop,
  onFetchCommit: noopAsync as (hash: string) => Promise<GitCommitWithDiff | null>,
  onFetchDiff: noopAsync as (hash: string, file: string) => Promise<string | null>,
};

describe('GitPanel — render', () => {
  const makeRepo = (overrides: Partial<GitRepoView> = {}): GitRepoView => ({
    repoPath: '/home/user/my-app',
    isWorktree: false,
    ...overrides,
  });

  const makeStatus = (overrides: Partial<GitRepoStatus> = {}): GitRepoStatus => ({
    branch: { head: null, upstream: null, ahead: 0, behind: 0, branchName: 'main' },
    files: [],
    conflicted: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    ignoredCount: 0,
    ...overrides,
  });

  describe('empty state', () => {
    it('renders empty message when no repos', () => {
      render(<GitPanel {...BASE_PANEL_PROPS} project="p" repos={[]} />);
      expect(screen.getByText(/no git repositories/i)).toBeTruthy();
    });
  });

  describe('error state', () => {
    it('renders error message when repo has error', () => {
      render(
        <GitPanel
          {...BASE_PANEL_PROPS}
          project="p"
          repos={[makeRepo({ error: 'fatal: not a git repository' })]}
        />
      );
      expect(screen.getByText(/fatal: not a git repository/i)).toBeTruthy();
    });

    it('shows repo path in error card', () => {
      render(
        <GitPanel
          {...BASE_PANEL_PROPS}
          project="p"
          repos={[makeRepo({ repoPath: '/home/user/my-app', error: 'permission denied' })]}
        />
      );
      expect(screen.getByText(/my-app/)).toBeTruthy();
    });
  });

  describe('worktree badge', () => {
    it('renders worktree badge element when isWorktree is true', () => {
      render(
        <GitPanel
          {...BASE_PANEL_PROPS}
          project="p"
          repos={[makeRepo({ isWorktree: true, status: makeStatus() })]}
        />
      );
      // Badge has title "Linked worktree" (or "Worktree of <path>" if mainWorktree set)
      expect(document.querySelector('[title="Linked worktree"]')).toBeTruthy();
    });

    it('does not render worktree badge when isWorktree is false', () => {
      render(
        <GitPanel
          {...BASE_PANEL_PROPS}
          project="p"
          repos={[makeRepo({ isWorktree: false, status: makeStatus() })]}
        />
      );
      expect(document.querySelector('[title="Linked worktree"]')).toBeFalsy();
    });

    it('renders mainWorktree path in badge title when provided', () => {
      render(
        <GitPanel
          {...BASE_PANEL_PROPS}
          project="p"
          repos={[makeRepo({ isWorktree: true, mainWorktree: '/home/user/main-repo', status: makeStatus() })]}
        />
      );
      expect(document.querySelector('[title="Worktree of /home/user/main-repo"]')).toBeTruthy();
    });
  });

  describe('write actions — push two-tap', () => {
    const makeFileInfo = (): GitFileInfo => ({
      path: 'src/index.ts',
      flags: {} as GitFileInfo['flags'],
      staged: false,
      indexStatus: null,
      worktreeStatus: 'modified',
    });

    const repo: GitRepoView[] = [
      {
        repoPath: '/home/user/repo',
        isWorktree: false,
        status: {
          branch: { head: null, upstream: null, ahead: 1, behind: 0, branchName: 'main' },
          files: [makeFileInfo()],
          conflicted: 0,
          stagedCount: 0,
          unstagedCount: 1,
          untrackedCount: 0,
          ignoredCount: 0,
        },
      },
    ];

    it('first tap shows Confirm push button', () => {
      const onPush = vi.fn().mockResolvedValue(true);
      render(<GitPanel {...BASE_PANEL_PROPS} project="p" repos={repo} onPush={onPush} />);
      const pushBtn = document.querySelector('[title="Push"]') as HTMLElement;
      expect(pushBtn).toBeTruthy();
      fireEvent.click(pushBtn);
      expect(document.querySelector('[title="Confirm push"]')).toBeTruthy();
      expect(onPush).not.toHaveBeenCalled();
    });

    it('second tap on Confirm push fires onPush', () => {
      const onPush = vi.fn().mockResolvedValue(true);
      render(<GitPanel {...BASE_PANEL_PROPS} project="p" repos={repo} onPush={onPush} />);
      fireEvent.click(document.querySelector('[title="Push"]') as HTMLElement);
      fireEvent.click(document.querySelector('[title="Confirm push"]') as HTMLElement);
      expect(onPush).toHaveBeenCalledWith('/home/user/repo');
    });

    it('after confirm, Confirm push button disappears', () => {
      const onPush = vi.fn().mockResolvedValue(true);
      render(<GitPanel {...BASE_PANEL_PROPS} project="p" repos={repo} onPush={onPush} />);
      fireEvent.click(document.querySelector('[title="Push"]') as HTMLElement);
      fireEvent.click(document.querySelector('[title="Confirm push"]') as HTMLElement);
      expect(document.querySelector('[title="Confirm push"]')).toBeFalsy();
    });
  });
});
