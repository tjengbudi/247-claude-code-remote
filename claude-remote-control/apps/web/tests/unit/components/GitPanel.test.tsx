/**
 * GitPanel render tests — empty state, error state, repo groups, write actions.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { GitPanel, type GitRepoView } from '@/components/GitPanel';
import type { GitRepoStatus, GitFileInfo } from '247-shared';

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
  Upload: () => null,
  Download: () => null,
  Check: () => null,
}));

vi.mock('@/components/GitHistory', () => ({ GitHistory: () => null }));

function makeStatus(overrides: Partial<GitRepoStatus> = {}): GitRepoStatus {
  return {
    branch: { head: 'abc123', upstream: null, ahead: 0, behind: 0, branchName: 'main' },
    files: [],
    conflicted: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    ignoredCount: 0,
    ...overrides,
  };
}

function makeFile(overrides: Partial<GitFileInfo> = {}): GitFileInfo {
  return {
    path: 'src/foo.ts',
    flags: { index: ' ', worktree: 'M' },
    indexStatus: null,
    worktreeStatus: 'modified',
    staged: false,
    ...overrides,
  };
}

describe('GitPanel', () => {
  describe('empty state', () => {
    it('renders empty state when repos is empty', () => {
      render(<GitPanel project="my-project" repos={[]} />);
      expect(screen.getByText('No git repositories found')).toBeTruthy();
    });

    it('includes the project name in empty state message', () => {
      render(<GitPanel project="my-project" repos={[]} />);
      expect(screen.getByText(/my-project/)).toBeTruthy();
    });
  });

  describe('error state', () => {
    it('renders error message when repo has error', () => {
      const repos: GitRepoView[] = [
        { repoPath: '/home/user/my-app', isWorktree: false, error: 'fatal: not a git repository' },
      ];
      render(<GitPanel project="my-project" repos={repos} />);
      expect(screen.getByText('fatal: not a git repository')).toBeTruthy();
    });

    it('shows repo path in error card', () => {
      const repos: GitRepoView[] = [
        { repoPath: '/home/user/my-app', isWorktree: false, error: 'permission denied' },
      ];
      render(<GitPanel project="p" repos={repos} />);
      expect(screen.getByText('/home/user/my-app')).toBeTruthy();
    });
  });

  describe('repo groups', () => {
    it('renders each repo as a separate group', () => {
      const repos: GitRepoView[] = [
        { repoPath: '/home/user/repo-a', isWorktree: false, status: makeStatus() },
        { repoPath: '/home/user/repo-b', isWorktree: false, status: makeStatus() },
      ];
      render(<GitPanel project="p" repos={repos} />);
      expect(screen.getByText('repo-a')).toBeTruthy();
      expect(screen.getByText('repo-b')).toBeTruthy();
    });

    it('shows staged files under Staged section', () => {
      const repos: GitRepoView[] = [
        {
          repoPath: '/home/user/repo',
          isWorktree: false,
          status: makeStatus({
            files: [makeFile({ path: 'src/new.ts', staged: true, indexStatus: 'added', worktreeStatus: null })],
            stagedCount: 1,
          }),
        },
      ];
      render(<GitPanel project="p" repos={repos} />);
      expect(screen.getByText(/staged/i)).toBeTruthy();
      expect(screen.getByText('src/new.ts')).toBeTruthy();
    });

    it('shows modified files under Changes section', () => {
      const repos: GitRepoView[] = [
        {
          repoPath: '/home/user/repo',
          isWorktree: false,
          status: makeStatus({
            files: [makeFile({ path: 'src/bar.ts', staged: false, worktreeStatus: 'modified' })],
            unstagedCount: 1,
          }),
        },
      ];
      render(<GitPanel project="p" repos={repos} />);
      expect(screen.getByText(/changes/i)).toBeTruthy();
      expect(screen.getByText('src/bar.ts')).toBeTruthy();
    });

    it('shows untracked files under Untracked section', () => {
      const repos: GitRepoView[] = [
        {
          repoPath: '/home/user/repo',
          isWorktree: false,
          status: makeStatus({
            files: [makeFile({ path: 'new-file.ts', staged: false, indexStatus: 'untracked', worktreeStatus: 'untracked' })],
            untrackedCount: 1,
          }),
        },
      ];
      render(<GitPanel project="p" repos={repos} />);
      expect(screen.getByText(/untracked/i)).toBeTruthy();
      expect(screen.getByText('new-file.ts')).toBeTruthy();
    });

    it('shows "Working tree clean" when repo has no changes', () => {
      const repos: GitRepoView[] = [
        { repoPath: '/home/user/clean', isWorktree: false, status: makeStatus({ files: [] }) },
      ];
      render(<GitPanel project="p" repos={repos} />);
      expect(screen.getByText('Working tree clean')).toBeTruthy();
    });
  });

  describe('write actions — commit confirm flow', () => {
    const stagedRepo: GitRepoView[] = [
      {
        repoPath: '/home/user/repo',
        isWorktree: false,
        status: makeStatus({
          files: [makeFile({ path: 'src/foo.ts', staged: true, indexStatus: 'modified', worktreeStatus: null })],
          stagedCount: 1,
        }),
      },
    ];

    it('shows commit form when staged files exist and onCommit provided', () => {
      render(<GitPanel project="p" repos={stagedRepo} onCommit={vi.fn()} />);
      expect(screen.getByPlaceholderText('Commit message')).toBeTruthy();
    });

    it('commit button disabled when message is empty', () => {
      render(<GitPanel project="p" repos={stagedRepo} onCommit={vi.fn()} />);
      const btn = screen.getByText(/Commit 1 staged file/);
      expect(btn).toBeTruthy();
      expect((btn as HTMLButtonElement).disabled).toBe(true);
    });

    it('first click shows confirm dialog with message preview', () => {
      render(<GitPanel project="p" repos={stagedRepo} onCommit={vi.fn()} />);
      const input = screen.getByPlaceholderText('Commit message');
      fireEvent.change(input, { target: { value: 'fix: my bug' } });
      fireEvent.click(screen.getByText(/Commit 1 staged file/));
      expect(screen.getByText(/fix: my bug/)).toBeTruthy();
      expect(screen.getByText('Confirm')).toBeTruthy();
      expect(screen.getByText('Cancel')).toBeTruthy();
    });

    it('confirm fires onCommit with trimmed message', () => {
      const onCommit = vi.fn().mockResolvedValue(true);
      render(<GitPanel project="p" repos={stagedRepo} onCommit={onCommit} />);
      const input = screen.getByPlaceholderText('Commit message');
      fireEvent.change(input, { target: { value: '  fix: trim me  ' } });
      fireEvent.click(screen.getByText(/Commit 1 staged file/));
      fireEvent.click(screen.getByText('Confirm'));
      expect(onCommit).toHaveBeenCalledWith('/home/user/repo', 'fix: trim me');
    });

    it('cancel hides confirm dialog without calling onCommit', () => {
      const onCommit = vi.fn();
      render(<GitPanel project="p" repos={stagedRepo} onCommit={onCommit} />);
      const input = screen.getByPlaceholderText('Commit message');
      fireEvent.change(input, { target: { value: 'msg' } });
      fireEvent.click(screen.getByText(/Commit 1 staged file/));
      fireEvent.click(screen.getByText('Cancel'));
      expect(onCommit).not.toHaveBeenCalled();
      expect(screen.queryByText('Confirm')).toBeFalsy();
    });

    it('no force-push control present', () => {
      render(<GitPanel project="p" repos={stagedRepo} onPush={vi.fn()} />);
      const html = document.body.innerHTML;
      expect(html).not.toContain('force');
      expect(html).not.toContain('--force');
    });
  });

  describe('write actions — push two-tap confirm (AC7-g)', () => {
    const repo: GitRepoView[] = [
      {
        repoPath: '/home/user/repo',
        isWorktree: false,
        status: makeStatus(),
      },
    ];

    it('first Push tap shows Confirm push button, does not fire onPush', () => {
      const onPush = vi.fn();
      render(<GitPanel project="p" repos={repo} onPush={onPush} />);
      const pushBtn = document.querySelector('[title="Push"]') as HTMLElement;
      expect(pushBtn).toBeTruthy();
      fireEvent.click(pushBtn);
      expect(document.querySelector('[title="Confirm push"]')).toBeTruthy();
      expect(onPush).not.toHaveBeenCalled();
    });

    it('second tap on Confirm push fires onPush', () => {
      const onPush = vi.fn().mockResolvedValue(true);
      render(<GitPanel project="p" repos={repo} onPush={onPush} />);
      fireEvent.click(document.querySelector('[title="Push"]') as HTMLElement);
      fireEvent.click(document.querySelector('[title="Confirm push"]') as HTMLElement);
      expect(onPush).toHaveBeenCalledWith('/home/user/repo');
    });

    it('after confirm, Confirm push button disappears', () => {
      const onPush = vi.fn().mockResolvedValue(true);
      render(<GitPanel project="p" repos={repo} onPush={onPush} />);
      fireEvent.click(document.querySelector('[title="Push"]') as HTMLElement);
      fireEvent.click(document.querySelector('[title="Confirm push"]') as HTMLElement);
      expect(document.querySelector('[title="Confirm push"]')).toBeFalsy();
    });
  });
});
