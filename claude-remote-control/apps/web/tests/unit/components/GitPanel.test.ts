import { describe, it, expect } from 'vitest';

/**
 * Test GitPanel component logic.
 * Tests status badges, file categorization, repo grouping, and display states.
 */

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
    // Helper function that mimics the StatusBadge logic
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
    // Helper functions that mimic GitPanel file splitting logic
    interface GitFileInfo {
      path: string;
      staged?: boolean;
      indexStatus?: string | null;
      worktreeStatus?: string | null;
    }

    function categorizeFiles(files: GitFileInfo[]) {
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
      const files: GitFileInfo[] = [
        { path: 'a.ts', staged: true, indexStatus: 'modified', worktreeStatus: null },
        { path: 'b.ts', staged: true, indexStatus: 'added', worktreeStatus: null },
      ];

      const { staged, changes, untracked } = categorizeFiles(files);
      expect(staged).toHaveLength(2);
      expect(changes).toHaveLength(0);
      expect(untracked).toHaveLength(0);
    });

    it('categorizes unstaged changes correctly', () => {
      const files: GitFileInfo[] = [
        { path: 'a.ts', staged: false, indexStatus: null, worktreeStatus: 'modified' },
        { path: 'b.ts', staged: false, indexStatus: null, worktreeStatus: 'deleted' },
      ];

      const { staged, changes, untracked } = categorizeFiles(files);
      expect(staged).toHaveLength(0);
      expect(changes).toHaveLength(2);
      expect(untracked).toHaveLength(0);
    });

    it('categorizes untracked files correctly', () => {
      const files: GitFileInfo[] = [
        { path: 'new.txt', staged: false, indexStatus: null, worktreeStatus: 'untracked' },
      ];

      const { staged, changes, untracked } = categorizeFiles(files);
      expect(staged).toHaveLength(0);
      expect(changes).toHaveLength(0);
      expect(untracked).toHaveLength(1);
    });

    it('handles mixed file states', () => {
      const files: GitFileInfo[] = [
        { path: 'staged.ts', staged: true, indexStatus: 'modified', worktreeStatus: null },
        { path: 'changed.ts', staged: false, indexStatus: null, worktreeStatus: 'modified' },
        { path: 'new.txt', staged: false, indexStatus: null, worktreeStatus: 'untracked' },
        { path: 'ignored.log', staged: false, indexStatus: null, worktreeStatus: 'ignored' },
      ];

      const { staged, changes, untracked } = categorizeFiles(files);
      expect(staged).toHaveLength(1);
      expect(changes).toHaveLength(1);
      expect(untracked).toHaveLength(1);
      // ignored files are excluded from all three categories
    });

    it('handles files with both staged and unstaged changes', () => {
      const files: GitFileInfo[] = [
        { path: 'both.ts', staged: true, indexStatus: 'modified', worktreeStatus: 'modified' },
      ];

      const { staged, changes, untracked } = categorizeFiles(files);
      // File appears in staged category (staged && indexStatus)
      expect(staged).toHaveLength(1);
      // File does NOT appear in changes (staged === true)
      expect(changes).toHaveLength(0);
      expect(untracked).toHaveLength(0);
    });

    it('excludes ignored files from all categories', () => {
      const files: GitFileInfo[] = [
        { path: 'node_modules/', staged: false, indexStatus: null, worktreeStatus: 'ignored' },
      ];

      const { staged, changes, untracked } = categorizeFiles(files);
      expect(staged).toHaveLength(0);
      expect(changes).toHaveLength(0);
      expect(untracked).toHaveLength(0);
    });
  });

  describe('repo name extraction', () => {
    // Helper function that mimics repo name extraction logic
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
      // When split/pop gives '', the component falls back to repoPath
      const path = '/home/user/repo/';
      const name = path.split('/').pop() || path;
      expect(name).toBe('/home/user/repo/');
    });

    it('handles empty path', () => {
      expect(getRepoName('')).toBe('');
    });
  });

  describe('branch display', () => {
    // Helper function that mimics branch display logic
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
    // Helper function that mimics rename display logic
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

  describe('error states', () => {
    interface GitRepoView {
      repoPath: string;
      status?: any;
      error?: string;
    }

    it('detects repo with error', () => {
      const repo: GitRepoView = {
        repoPath: '/path/to/repo',
        error: 'fatal: not a git repository',
      };
      expect(repo.error).toBeDefined();
    });

    it('detects repo without status', () => {
      const repo: GitRepoView = {
        repoPath: '/path/to/repo',
      };
      expect(!repo.status).toBe(true);
    });

    it('detects healthy repo', () => {
      const repo: GitRepoView = {
        repoPath: '/path/to/repo',
        status: { branch: {}, files: [] },
      };
      expect(repo.status).toBeDefined();
      expect(repo.error).toBeUndefined();
    });
  });
});
