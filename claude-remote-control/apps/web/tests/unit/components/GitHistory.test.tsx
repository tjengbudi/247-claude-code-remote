/**
 * GitHistory render + interaction tests (Story 6.3).
 * Covers: list render, list↔graph toggle, commit-detail expansion,
 * lazy diff fetch (fires only on expand), capped banner, empty/error states.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { GitHistory } from '@/components/GitHistory';
import type { GitCommit, GitCommitWithDiff } from '247-shared';

afterEach(cleanup);

// Lucide icons don't render meaningful text; stub them
vi.mock('lucide-react', () => ({
  ChevronDown: () => null,
  ChevronRight: () => null,
  GitCommit: () => null,
  Loader2: () => null,
  GitBranch: () => null,
  GitCompareArrows: () => null,
  AlertTriangle: () => null,
}));

function makeCommit(overrides: Partial<GitCommit> = {}): GitCommit {
  return {
    hash: 'a'.repeat(40),
    shortHash: 'abc1234',
    author: 'Test Author',
    email: 'test@example.com',
    timestamp: Date.now() - 60_000,
    parents: [],
    subject: 'Fix something',
    ...overrides,
  };
}

const noop = () => Promise.resolve(null);

describe('GitHistory', () => {
  describe('empty state', () => {
    it('shows empty message when no commits', () => {
      render(
        <GitHistory
          commits={[]}
          graphCommits={null}
          graphCapped={false}
          loading={false}
          graphLoading={false}
          onToggleGraph={vi.fn()}
          onFetchCommit={noop}
          onFetchDiff={noop}
        />
      );
      expect(screen.getByText(/no commits found/i)).toBeTruthy();
    });

    it('shows loading spinner when loading', () => {
      render(
        <GitHistory
          commits={[]}
          graphCommits={null}
          graphCapped={false}
          loading={true}
          graphLoading={false}
          onToggleGraph={vi.fn()}
          onFetchCommit={noop}
          onFetchDiff={noop}
        />
      );
      expect(screen.getByText(/loading history/i)).toBeTruthy();
    });
  });

  describe('list render', () => {
    it('renders commit subject and short hash', () => {
      const commit = makeCommit({ subject: 'Add feature X', shortHash: 'def4567' });
      render(
        <GitHistory
          commits={[commit]}
          graphCommits={null}
          graphCapped={false}
          loading={false}
          graphLoading={false}
          onToggleGraph={vi.fn()}
          onFetchCommit={noop}
          onFetchDiff={noop}
        />
      );
      expect(screen.getByText('Add feature X')).toBeTruthy();
      expect(screen.getByText('def4567')).toBeTruthy();
    });

    it('shows author name', () => {
      const commit = makeCommit({ author: 'Jane Doe' });
      render(
        <GitHistory
          commits={[commit]}
          graphCommits={null}
          graphCapped={false}
          loading={false}
          graphLoading={false}
          onToggleGraph={vi.fn()}
          onFetchCommit={noop}
          onFetchDiff={noop}
        />
      );
      expect(screen.getByText('Jane Doe')).toBeTruthy();
    });
  });

  describe('list↔graph toggle', () => {
    it('calls onToggleGraph when switching to graph', () => {
      const onToggleGraph = vi.fn();
      render(
        <GitHistory
          commits={[makeCommit()]}
          graphCommits={null}
          graphCapped={false}
          loading={false}
          graphLoading={false}
          onToggleGraph={onToggleGraph}
          onFetchCommit={noop}
          onFetchDiff={noop}
        />
      );
      const btn = screen.getByTitle(/switch to graph view/i);
      fireEvent.click(btn);
      expect(onToggleGraph).toHaveBeenCalledOnce();
    });

    it('shows graph loading state when graphLoading=true after toggle', async () => {
      const { rerender } = render(
        <GitHistory
          commits={[makeCommit()]}
          graphCommits={null}
          graphCapped={false}
          loading={false}
          graphLoading={false}
          onToggleGraph={vi.fn()}
          onFetchCommit={noop}
          onFetchDiff={noop}
        />
      );
      // Toggle to graph
      fireEvent.click(screen.getByTitle(/switch to graph view/i));
      // Rerender with loading=true
      rerender(
        <GitHistory
          commits={[makeCommit()]}
          graphCommits={null}
          graphCapped={false}
          loading={false}
          graphLoading={true}
          onToggleGraph={vi.fn()}
          onFetchCommit={noop}
          onFetchDiff={noop}
        />
      );
      expect(screen.getByText(/loading graph/i)).toBeTruthy();
    });

    it('shows capped banner when graphCapped=true in graph mode', async () => {
      const graphCommits = [makeCommit()];
      render(
        <GitHistory
          commits={[makeCommit()]}
          graphCommits={graphCommits}
          graphCapped={true}
          loading={false}
          graphLoading={false}
          onToggleGraph={vi.fn()}
          onFetchCommit={noop}
          onFetchDiff={noop}
        />
      );
      // Toggle to graph view first
      fireEvent.click(screen.getByTitle(/switch to graph view/i));
      expect(screen.getByText(/capped/i)).toBeTruthy();
    });

    it('does not show capped banner in list mode even when graphCapped=true', () => {
      render(
        <GitHistory
          commits={[makeCommit()]}
          graphCommits={[makeCommit()]}
          graphCapped={true}
          loading={false}
          graphLoading={false}
          onToggleGraph={vi.fn()}
          onFetchCommit={noop}
          onFetchDiff={noop}
        />
      );
      // Default is list mode — banner should not appear
      expect(screen.queryByText(/capped/i)).toBeNull();
    });
  });

  describe('commit detail expansion', () => {
    it('calls onFetchCommit when a commit row is clicked', async () => {
      const onFetchCommit = vi.fn().mockResolvedValue(null);
      const commit = makeCommit({ subject: 'Click me' });
      render(
        <GitHistory
          commits={[commit]}
          graphCommits={null}
          graphCapped={false}
          loading={false}
          graphLoading={false}
          onToggleGraph={vi.fn()}
          onFetchCommit={onFetchCommit}
          onFetchDiff={noop}
        />
      );
      fireEvent.click(screen.getByText('Click me'));
      await waitFor(() => expect(onFetchCommit).toHaveBeenCalledWith(commit.hash));
    });

    it('renders file list from commit detail after fetch', async () => {
      const detail: GitCommitWithDiff = {
        hash: 'a'.repeat(40),
        shortHash: 'abc1234',
        author: 'Test',
        email: 'test@example.com',
        timestamp: Date.now(),
        parents: [],
        subject: 'Commit with files',
        files: [
          { path: 'src/index.ts', additions: 5, deletions: 2, binary: false },
        ],
      };
      const onFetchCommit = vi.fn().mockResolvedValue(detail);
      const commit = makeCommit({ subject: 'Commit with files', hash: 'a'.repeat(40) });
      render(
        <GitHistory
          commits={[commit]}
          graphCommits={null}
          graphCapped={false}
          loading={false}
          graphLoading={false}
          onToggleGraph={vi.fn()}
          onFetchCommit={onFetchCommit}
          onFetchDiff={noop}
        />
      );
      fireEvent.click(screen.getByText('Commit with files'));
      await waitFor(() => expect(screen.getByText('src/index.ts')).toBeTruthy());
    });
  });

  describe('lazy diff fetch', () => {
    it('does NOT call onFetchDiff before a file is expanded', async () => {
      const detail: GitCommitWithDiff = {
        hash: 'a'.repeat(40),
        shortHash: 'abc1234',
        author: 'Test',
        email: 'test@example.com',
        timestamp: Date.now(),
        parents: [],
        subject: 'Has files',
        files: [{ path: 'lib/foo.ts', additions: 1, deletions: 0, binary: false }],
      };
      const onFetchCommit = vi.fn().mockResolvedValue(detail);
      const onFetchDiff = vi.fn().mockResolvedValue(null);
      const commit = makeCommit({ subject: 'Has files', hash: 'a'.repeat(40) });

      render(
        <GitHistory
          commits={[commit]}
          graphCommits={null}
          graphCapped={false}
          loading={false}
          graphLoading={false}
          onToggleGraph={vi.fn()}
          onFetchCommit={onFetchCommit}
          onFetchDiff={onFetchDiff}
        />
      );

      // Click commit to expand detail
      fireEvent.click(screen.getByText('Has files'));
      await waitFor(() => expect(screen.getByText('lib/foo.ts')).toBeTruthy());

      // Diff should NOT have been fetched yet
      expect(onFetchDiff).not.toHaveBeenCalled();
    });

    it('calls onFetchDiff only when a file is expanded', async () => {
      const detail: GitCommitWithDiff = {
        hash: 'a'.repeat(40),
        shortHash: 'abc1234',
        author: 'Test',
        email: 'test@example.com',
        timestamp: Date.now(),
        parents: [],
        subject: 'Has files',
        files: [{ path: 'lib/foo.ts', additions: 1, deletions: 0, binary: false }],
      };
      const onFetchCommit = vi.fn().mockResolvedValue(detail);
      const onFetchDiff = vi.fn().mockResolvedValue('+added line');
      const commit = makeCommit({ subject: 'Has files', hash: 'a'.repeat(40) });

      render(
        <GitHistory
          commits={[commit]}
          graphCommits={null}
          graphCapped={false}
          loading={false}
          graphLoading={false}
          onToggleGraph={vi.fn()}
          onFetchCommit={onFetchCommit}
          onFetchDiff={onFetchDiff}
        />
      );

      fireEvent.click(screen.getByText('Has files'));
      await waitFor(() => expect(screen.getByText('lib/foo.ts')).toBeTruthy());

      // Now expand the file
      fireEvent.click(screen.getByText('lib/foo.ts'));
      await waitFor(() =>
        expect(onFetchDiff).toHaveBeenCalledWith(
          'a'.repeat(40),
          'lib/foo.ts',
          expect.any(AbortSignal)
        )
      );
    });
  });

  describe('load more', () => {
    it('shows Load more button when onLoadMore is provided', () => {
      render(
        <GitHistory
          commits={[makeCommit()]}
          graphCommits={null}
          graphCapped={false}
          loading={false}
          graphLoading={false}
          onLoadMore={vi.fn()}
          onToggleGraph={vi.fn()}
          onFetchCommit={noop}
          onFetchDiff={noop}
        />
      );
      expect(screen.getByText(/load more commits/i)).toBeTruthy();
    });

    it('hides Load more button when onLoadMore is undefined', () => {
      render(
        <GitHistory
          commits={[makeCommit()]}
          graphCommits={null}
          graphCapped={false}
          loading={false}
          graphLoading={false}
          onToggleGraph={vi.fn()}
          onFetchCommit={noop}
          onFetchDiff={noop}
        />
      );
      expect(screen.queryByText(/load more commits/i)).toBeNull();
    });
  });

  describe('error state', () => {
    it('shows error message when onFetchCommit returns null', async () => {
      const onFetchCommit = vi.fn().mockResolvedValue(null);
      const commit = makeCommit({ subject: 'Bad commit' });
      render(
        <GitHistory
          commits={[commit]}
          graphCommits={null}
          graphCapped={false}
          loading={false}
          graphLoading={false}
          onToggleGraph={vi.fn()}
          onFetchCommit={onFetchCommit}
          onFetchDiff={noop}
        />
      );
      fireEvent.click(screen.getByText('Bad commit'));
      await waitFor(() =>
        expect(screen.getByText(/failed to load commit details/i)).toBeTruthy()
      );
    });
  });
});
