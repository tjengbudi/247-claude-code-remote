'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, GitBranch, AlertCircle, FolderGit, History } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { GitRepoStatus, GitFileInfo, GitCommit, GitCommitWithDiff } from '247-shared';
import { GitHistory } from './GitHistory';

// View type matching API response shape from /api/git/status
export interface GitRepoView {
  repoPath: string;
  isWorktree: boolean;
  mainWorktree?: string;
  status?: GitRepoStatus;
  error?: string;
}

interface GitPanelProps {
  project: string;
  repos: GitRepoView[];
  selectedRepo: string | null;
  commits: GitCommit[];
  graphCommits: GitCommit[] | null;
  graphCapped: boolean;
  loadingHistory: boolean;
  graphLoading: boolean;
  onSelectRepo: (repo: string) => void;
  onLoadMore?: () => void;
  onToggleGraph: () => void;
  onFetchCommit: (hash: string) => Promise<GitCommitWithDiff | null>;
  onFetchDiff: (hash: string, file: string) => Promise<string | null>;
}

type TabView = 'status' | 'history';

// Status badge colors
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

function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status || status === 'unknown') return null;
  const letter = status[0].toUpperCase();
  const color = STATUS_COLORS[status] || 'text-white/50';
  return (
    <span className={cn('text-xs font-mono font-bold', color)}>
      {letter}
    </span>
  );
}

function FileRow({ file }: { file: GitFileInfo }) {
  const displayName = file.origPath ? `${file.origPath} → ${file.path}` : file.path;

  return (
    <div className="flex items-center gap-2 rounded px-2 py-1 hover:bg-white/[0.02]">
      <StatusBadge status={file.staged ? file.indexStatus : file.worktreeStatus} />
      <span className="flex-1 truncate text-sm text-white/70" title={displayName}>
        {displayName}
      </span>
      {file.staged && file.worktreeStatus && file.worktreeStatus !== 'untracked' && (
        <StatusBadge status={file.worktreeStatus} />
      )}
    </div>
  );
}

function RepoGroup({ repo }: { repo: GitRepoView }) {
  const [expanded, setExpanded] = useState(true);

  if (repo.error) {
    return (
      <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
        <div className="flex items-center gap-2 text-sm text-red-400">
          <AlertCircle className="h-4 w-4" />
          <span className="font-medium">{repo.repoPath}</span>
        </div>
        <p className="mt-1 text-xs text-red-400/70">{repo.error}</p>
      </div>
    );
  }

  if (!repo.status) return null;

  const { branch, files } = repo.status;
  const branchName = branch.branchName || '(detached)';

  const staged = files.filter(f => f.staged && f.indexStatus);
  const changes = files.filter(f => !f.staged && f.worktreeStatus && f.worktreeStatus !== 'untracked' && f.worktreeStatus !== 'ignored');
  const untracked = files.filter(f => f.worktreeStatus === 'untracked');

  const totalChanges = staged.length + changes.length + untracked.length;
  const repoName = repo.repoPath.split('/').pop() || repo.repoPath;

  return (
    <div className="rounded-lg border border-white/5 bg-white/[0.02]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-white/[0.02]"
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-white/40" />
        ) : (
          <ChevronRight className="h-4 w-4 text-white/40" />
        )}
        <FolderGit className="h-4 w-4 text-white/60" />
        <span className="flex-1 truncate text-sm font-medium text-white/90">
          {repoName}
        </span>
        {repo.isWorktree && (
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/50">
            worktree
          </span>
        )}
        {totalChanges > 0 && (
          <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-white/70">
            {totalChanges}
          </span>
        )}
      </button>

      {expanded && (
        <div className="border-t border-white/5 px-3 py-2">
          <div className="mb-3 flex items-center gap-2 text-xs text-white/50">
            <GitBranch className="h-3 w-3" />
            <span className="font-medium text-white/70">{branchName}</span>
            {branch.ahead > 0 && <span className="text-emerald-400">↑{branch.ahead}</span>}
            {branch.behind > 0 && <span className="text-amber-400">↓{branch.behind}</span>}
          </div>

          {staged.length > 0 && (
            <div className="mb-3">
              <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-white/40">
                Staged ({staged.length})
              </h4>
              <div className="space-y-0.5">
                {staged.map(f => <FileRow key={f.path} file={f} />)}
              </div>
            </div>
          )}

          {changes.length > 0 && (
            <div className="mb-3">
              <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-white/40">
                Changes ({changes.length})
              </h4>
              <div className="space-y-0.5">
                {changes.map(f => <FileRow key={f.path} file={f} />)}
              </div>
            </div>
          )}

          {untracked.length > 0 && (
            <div>
              <h4 className="mb-1 text-xs font-medium uppercase tracking-wide text-white/40">
                Untracked ({untracked.length})
              </h4>
              <div className="space-y-0.5">
                {untracked.map(f => <FileRow key={f.path} file={f} />)}
              </div>
            </div>
          )}

          {totalChanges === 0 && (
            <p className="text-sm text-white/30">Working tree clean</p>
          )}
        </div>
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
        active
          ? 'bg-white/10 text-white'
          : 'bg-white/5 text-white/60 hover:bg-white/10 hover:text-white/80'
      )}
    >
      {icon}
      {label}
    </button>
  );
}

export function GitPanel({
  project,
  repos,
  selectedRepo,
  commits,
  graphCommits,
  graphCapped,
  loadingHistory,
  graphLoading,
  onSelectRepo,
  onLoadMore,
  onToggleGraph,
  onFetchCommit,
  onFetchDiff,
}: GitPanelProps) {
  const [activeTab, setActiveTab] = useState<TabView>('status');

  if (repos.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
        <FolderGit className="h-12 w-12 text-white/20" />
        <div className="text-center">
          <p className="text-sm font-medium text-white/50">No git repositories found</p>
          <p className="mt-1 text-xs text-white/30">
            No .git directories detected in {project}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Tab bar */}
      <div className="flex items-center gap-2 border-b border-white/5 px-4 py-2">
        <TabButton
          active={activeTab === 'status'}
          onClick={() => setActiveTab('status')}
          icon={<FolderGit className="h-3.5 w-3.5" />}
          label="Status"
        />
        <TabButton
          active={activeTab === 'history'}
          onClick={() => setActiveTab('history')}
          icon={<History className="h-3.5 w-3.5" />}
          label="History"
        />

        {/* Repo selector when viewing history */}
        {activeTab === 'history' && repos.length > 1 && (
          <select
            value={selectedRepo || ''}
            onChange={(e) => onSelectRepo(e.target.value)}
            className="ml-auto rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-xs text-white/70 outline-none hover:bg-white/10"
          >
            {repos.map((repo) => {
              const name = repo.repoPath.split('/').pop() || repo.repoPath;
              return (
                <option key={repo.repoPath} value={repo.repoPath} className="bg-[#0d0d14]">
                  {name}
                </option>
              );
            })}
          </select>
        )}
      </div>

      {/* Tab content */}
      {activeTab === 'status' ? (
        <div className="flex flex-1 flex-col gap-3 overflow-auto p-4">
          {repos.map(repo => (
            <RepoGroup key={repo.repoPath} repo={repo} />
          ))}
        </div>
      ) : (
        <GitHistory
          commits={commits}
          graphCommits={graphCommits}
          graphCapped={graphCapped}
          loading={loadingHistory}
          graphLoading={graphLoading}
          onLoadMore={onLoadMore}
          onToggleGraph={onToggleGraph}
          onFetchCommit={onFetchCommit}
          onFetchDiff={onFetchDiff}
        />
      )}
    </div>
  );
}
