'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, GitBranch, AlertCircle, FolderGit, History, Plus, Minus, Upload, Download, Check, FolderOpen, Trash2, GitFork, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { GitRepoStatus, GitFileInfo, GitCommit, GitCommitWithDiff, GitWorktree } from '247-shared';
import { GitHistory } from './GitHistory';

// View type matching API response shape from /api/git/status
export interface GitRepoView {
  repoPath: string;
  isWorktree: boolean;
  mainWorktree?: string;
  status?: GitRepoStatus;
  error?: string;
  worktrees?: GitWorktree[];
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
  onFetchDiff: (hash: string, file: string, signal?: AbortSignal) => Promise<string | null>;
  // Write actions (Story 6.4)
  onStage?: (repo: string, pathspecs: string[], all?: boolean) => Promise<boolean>;
  onUnstage?: (repo: string, pathspecs: string[], all?: boolean) => Promise<boolean>;
  onCommit?: (repo: string, message: string) => Promise<boolean>;
  onPush?: (repo: string) => Promise<boolean>;
  onPull?: (repo: string) => Promise<boolean>;
  onSwitchBranch?: (repo: string, name: string, create?: boolean) => Promise<boolean>;
  // Worktree actions (Story 6.6)
  onCreateWorktree?: (repo: string, branch: string, newBranch?: boolean) => Promise<{ path: string; branch: string } | null>;
  onRemoveWorktree?: (repo: string, path: string, opts?: { force?: boolean }) => Promise<{ ok: boolean; dirty?: boolean; liveSession?: boolean }>;
  /** When false and repos is empty, show "Connecting…" instead of "No repos found" */
  wsConnected?: boolean;
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

function RepoGroup({
  repo,
  onStage,
  onUnstage,
  onCommit,
  onPush,
  onPull,
  onSwitchBranch,
  onCreateWorktree,
  onRemoveWorktree,
}: {
  repo: GitRepoView;
  onStage?: (repo: string, pathspecs: string[], all?: boolean) => Promise<boolean>;
  onUnstage?: (repo: string, pathspecs: string[], all?: boolean) => Promise<boolean>;
  onCommit?: (repo: string, message: string) => Promise<boolean>;
  onPush?: (repo: string) => Promise<boolean>;
  onPull?: (repo: string) => Promise<boolean>;
  onSwitchBranch?: (repo: string, name: string, create?: boolean) => Promise<boolean>;
  onCreateWorktree?: (repo: string, branch: string, newBranch?: boolean) => Promise<{ path: string; branch: string } | null>;
  onRemoveWorktree?: (repo: string, path: string, opts?: { force?: boolean }) => Promise<{ ok: boolean; dirty?: boolean; liveSession?: boolean }>;
}) {
  const [expanded, setExpanded] = useState(true);
  const [commitMessage, setCommitMessage] = useState('');
  const [showCommitConfirm, setShowCommitConfirm] = useState(false);
  const [showPushConfirm, setShowPushConfirm] = useState(false);
  const [showPullConfirm, setShowPullConfirm] = useState(false);
  const [branchInput, setBranchInput] = useState('');
  const [showBranchInput, setShowBranchInput] = useState(false);
  // Worktree create state
  const [showWorktreeInput, setShowWorktreeInput] = useState(false);
  const [worktreeBranch, setWorktreeBranch] = useState('');
  const [worktreeNew, setWorktreeNew] = useState(true);
  // Worktree remove confirm state: path being confirmed, or null
  const [removingWorktree, setRemovingWorktree] = useState<string | null>(null);
  // Dirty-worktree force confirm: path pending force removal
  const [dirtyWorktree, setDirtyWorktree] = useState<string | null>(null);

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
  const branchName = branch.branchName || branch.head || '(detached)';

  const staged = files.filter(f => f.staged);
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
          <span
            className="flex items-center gap-1 rounded bg-purple-500/20 px-1.5 py-0.5 text-[10px] text-purple-300"
            title={repo.mainWorktree ? `Worktree of ${repo.mainWorktree}` : 'Linked worktree'}
          >
            <FolderOpen className="h-3 w-3" />
            <span className="max-w-[80px] truncate">{branchName}</span>
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
            {/* Push/Pull buttons */}
            <div className="ml-auto flex gap-1">
              {onPull && (
                <>
                  <button
                    onClick={() => setShowPullConfirm(true)}
                    className="rounded p-1 text-white/40 hover:bg-white/10 hover:text-white/70"
                    title="Pull"
                  >
                    <Download className="h-3.5 w-3.5" />
                  </button>
                  {showPullConfirm && (
                    <button
                      onClick={() => {
                        setShowPullConfirm(false);
                        void onPull(repo.repoPath);
                      }}
                      className="rounded bg-amber-500/20 p-1 text-amber-400 hover:bg-amber-500/30"
                      title="Confirm pull"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                  )}
                </>
              )}
              {onPush && (
                <>
                  <button
                    onClick={() => setShowPushConfirm(true)}
                    className="rounded p-1 text-white/40 hover:bg-white/10 hover:text-white/70"
                    title="Push"
                  >
                    <Upload className="h-3.5 w-3.5" />
                  </button>
                  {showPushConfirm && (
                    <button
                      onClick={() => {
                        setShowPushConfirm(false);
                        void onPush(repo.repoPath);
                      }}
                      className="rounded bg-emerald-500/20 p-1 text-emerald-400 hover:bg-emerald-500/30"
                      title="Confirm push"
                    >
                      <Check className="h-3.5 w-3.5" />
                    </button>
                  )}
                </>
              )}
              {onSwitchBranch && (
                <button
                  onClick={() => setShowBranchInput(v => !v)}
                  className="rounded p-1 text-white/40 hover:bg-white/10 hover:text-white/70"
                  title="Switch / create branch"
                >
                  <GitBranch className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          {staged.length > 0 && (
            <div className="mb-3">
              <div className="mb-1 flex items-center">
                <h4 className="text-xs font-medium uppercase tracking-wide text-white/40">
                  Staged ({staged.length})
                </h4>
                {onUnstage && (
                  <button
                    onClick={() => onUnstage(repo.repoPath, staged.map(f => f.path), true)}
                    className="ml-auto rounded p-0.5 text-white/30 hover:bg-white/10 hover:text-white/60"
                    title="Unstage all"
                  >
                    <Minus className="h-3 w-3" />
                  </button>
                )}
              </div>
              <div className="space-y-0.5">
                {staged.map(f => <FileRow key={f.path} file={f} />)}
              </div>
            </div>
          )}

          {changes.length > 0 && (
            <div className="mb-3">
              <div className="mb-1 flex items-center">
                <h4 className="text-xs font-medium uppercase tracking-wide text-white/40">
                  Changes ({changes.length})
                </h4>
                {onStage && (
                  <button
                    onClick={() => onStage(repo.repoPath, changes.map(f => f.path), false)}
                    className="ml-auto rounded p-0.5 text-white/30 hover:bg-white/10 hover:text-white/60"
                    title="Stage all changes"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                )}
              </div>
              <div className="space-y-0.5">
                {changes.map(f => <FileRow key={f.path} file={f} />)}
              </div>
            </div>
          )}

          {untracked.length > 0 && (
            <div className="mb-3">
              <div className="mb-1 flex items-center">
                <h4 className="text-xs font-medium uppercase tracking-wide text-white/40">
                  Untracked ({untracked.length})
                </h4>
                {onStage && (
                  <button
                    onClick={() => onStage(repo.repoPath, untracked.map(f => f.path), false)}
                    className="ml-auto rounded p-0.5 text-white/30 hover:bg-white/10 hover:text-white/60"
                    title="Stage all untracked"
                  >
                    <Plus className="h-3 w-3" />
                  </button>
                )}
              </div>
              <div className="space-y-0.5">
                {untracked.map(f => <FileRow key={f.path} file={f} />)}
              </div>
            </div>
          )}

          {totalChanges === 0 && (
            <p className="text-sm text-white/30">Working tree clean</p>
          )}

          {/* Commit form */}
          {onCommit && staged.length > 0 && (
            <div className="mt-2 border-t border-white/5 pt-2">
              <input
                type="text"
                value={commitMessage}
                onChange={(e) => setCommitMessage(e.target.value)}
                placeholder="Commit message"
                className="mb-1 w-full rounded border border-white/10 bg-white/5 px-2 py-1 text-xs text-white/90 placeholder:text-white/30 outline-none focus:border-white/20"
              />
              {!showCommitConfirm ? (
                <button
                  onClick={() => commitMessage.trim() && setShowCommitConfirm(true)}
                  disabled={!commitMessage.trim()}
                  className="w-full rounded bg-white/10 px-2 py-1 text-xs text-white/70 hover:bg-white/20 disabled:opacity-30 disabled:hover:bg-white/10"
                >
                  Commit {staged.length} staged file{staged.length !== 1 ? 's' : ''}
                </button>
              ) : (
                <div>
                  <p className="mb-1 truncate text-xs text-white/50" title={commitMessage}>
                    &ldquo;{commitMessage.trim()}&rdquo;
                  </p>
                  <div className="flex gap-1">
                    <button
                      onClick={async () => {
                        setShowCommitConfirm(false);
                        const ok = await onCommit(repo.repoPath, commitMessage.trim());
                        if (ok) setCommitMessage('');
                      }}
                      className="flex-1 rounded bg-emerald-500/20 px-2 py-1 text-xs text-emerald-400 hover:bg-emerald-500/30"
                    >
                      Confirm
                    </button>
                    <button
                      onClick={() => setShowCommitConfirm(false)}
                      className="flex-1 rounded bg-white/10 px-2 py-1 text-xs text-white/50 hover:bg-white/20"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Branch switch / create */}
          {onSwitchBranch && showBranchInput && (
            <div className="mt-2 border-t border-white/5 pt-2">
              <input
                type="text"
                value={branchInput}
                onChange={(e) => setBranchInput(e.target.value)}
                placeholder="Branch name"
                className="mb-1 w-full rounded border border-white/10 bg-white/5 px-2 py-1 text-xs text-white/90 placeholder:text-white/30 outline-none focus:border-white/20"
              />
              <div className="flex gap-1">
                <button
                  onClick={async () => {
                    if (!branchInput.trim()) return;
                    const ok = await onSwitchBranch(repo.repoPath, branchInput.trim(), false);
                    if (ok) { setBranchInput(''); setShowBranchInput(false); }
                  }}
                  disabled={!branchInput.trim()}
                  className="flex-1 rounded bg-white/10 px-2 py-1 text-xs text-white/70 hover:bg-white/20 disabled:opacity-30"
                >
                  Switch
                </button>
                <button
                  onClick={async () => {
                    if (!branchInput.trim()) return;
                    const ok = await onSwitchBranch(repo.repoPath, branchInput.trim(), true);
                    if (ok) { setBranchInput(''); setShowBranchInput(false); }
                  }}
                  disabled={!branchInput.trim()}
                  className="flex-1 rounded bg-white/10 px-2 py-1 text-xs text-white/70 hover:bg-white/20 disabled:opacity-30"
                >
                  Create
                </button>
              </div>
            </div>
          )}

          {/* Worktree section — only shown on non-worktree repos with create/remove actions */}
          {!repo.isWorktree && (onCreateWorktree || onRemoveWorktree) && (
            <div className="mt-2 border-t border-white/5 pt-2">
              {/* Worktrees list from repo.worktrees */}
              {repo.worktrees && repo.worktrees.length > 0 ? (
                <div className="mb-2">
                  <p className="mb-1 text-xs text-white/40">Linked worktrees</p>
                  {repo.worktrees.map((wt) => {
                    const wtName = wt.path.split('/').pop() || wt.path;
                    const isRemovingThis = removingWorktree === wt.path;
                    const isDirtyThis = dirtyWorktree === wt.path;
                    return (
                      <div key={wt.path} className="mb-1 rounded border border-white/5 bg-white/[0.02] px-2 py-1">
                        <div className="flex items-center gap-2">
                          <FolderOpen className="h-3 w-3 shrink-0 text-purple-400" />
                          <span className="flex-1 truncate text-xs text-white/70" title={wt.path}>{wtName}</span>
                          {wt.branch && (
                            <span className="shrink-0 text-[10px] text-purple-300">{wt.branch}</span>
                          )}
                          {onRemoveWorktree && !isRemovingThis && !isDirtyThis && (
                            <button
                              title="Remove worktree"
                              onClick={() => setRemovingWorktree(wt.path)}
                              className="shrink-0 rounded p-0.5 text-white/30 hover:bg-red-500/20 hover:text-red-400"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                        {isRemovingThis && (
                          <div className="mt-1 rounded border border-red-500/20 bg-red-500/5 p-1.5">
                            <p className="mb-1 truncate text-[10px] text-red-400/80" title={wt.path}>
                              Remove <span className="font-mono">{wtName}</span> ({wt.branch || 'detached'})?
                            </p>
                            <div className="flex gap-1">
                              <button
                                onClick={async () => {
                                  if (!onRemoveWorktree) return;
                                  const result = await onRemoveWorktree(repo.repoPath, wt.path);
                                  if (result.liveSession) {
                                    setRemovingWorktree(null);
                                  } else if (result.dirty) {
                                    setRemovingWorktree(null);
                                    setDirtyWorktree(wt.path);
                                  } else {
                                    setRemovingWorktree(null);
                                  }
                                }}
                                className="flex-1 rounded bg-red-500/20 px-2 py-0.5 text-[10px] text-red-400 hover:bg-red-500/30"
                              >
                                Confirm remove
                              </button>
                              <button
                                onClick={() => setRemovingWorktree(null)}
                                className="flex-1 rounded bg-white/10 px-2 py-0.5 text-[10px] text-white/50 hover:bg-white/20"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                        {isDirtyThis && (
                          <div className="mt-1 rounded border border-amber-500/20 bg-amber-500/5 p-1.5">
                            <p className="mb-1 text-[10px] text-amber-400/80">
                              Has uncommitted changes. Remove anyway?
                            </p>
                            <div className="flex gap-1">
                              <button
                                onClick={async () => {
                                  if (!onRemoveWorktree) return;
                                  const result = await onRemoveWorktree(repo.repoPath, wt.path, { force: true });
                                  // Only dismiss on success; on failure the hook
                                  // toasts and we keep the confirm open to retry.
                                  if (result.ok) setDirtyWorktree(null);
                                }}
                                className="flex-1 rounded bg-amber-500/20 px-2 py-0.5 text-[10px] text-amber-400 hover:bg-amber-500/30"
                              >
                                Force remove
                              </button>
                              <button
                                onClick={() => setDirtyWorktree(null)}
                                className="flex-1 rounded bg-white/10 px-2 py-0.5 text-[10px] text-white/50 hover:bg-white/20"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="mb-2 text-xs text-white/30">No linked worktrees</p>
              )}

              {/* New worktree control */}
              {onCreateWorktree && !showWorktreeInput && (
                <button
                  onClick={() => setShowWorktreeInput(true)}
                  title="New worktree"
                  className="flex items-center gap-1 rounded bg-white/5 px-2 py-1 text-xs text-white/50 hover:bg-white/10 hover:text-white/70"
                >
                  <GitFork className="h-3 w-3" />
                  New worktree
                </button>
              )}
              {onCreateWorktree && showWorktreeInput && (
                <div>
                  <input
                    type="text"
                    value={worktreeBranch}
                    onChange={(e) => setWorktreeBranch(e.target.value)}
                    placeholder="Branch name"
                    className="mb-1 w-full rounded border border-white/10 bg-white/5 px-2 py-1 text-xs text-white/90 placeholder:text-white/30 outline-none focus:border-white/20"
                  />
                  <label className="mb-1 flex items-center gap-1.5 text-xs text-white/50 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={worktreeNew}
                      onChange={(e) => setWorktreeNew(e.target.checked)}
                      className="accent-purple-400"
                    />
                    Create new branch
                  </label>
                  <div className="flex gap-1">
                    <button
                      onClick={async () => {
                        if (!worktreeBranch.trim()) return;
                        const result = await onCreateWorktree(repo.repoPath, worktreeBranch.trim(), worktreeNew);
                        if (result) { setWorktreeBranch(''); setShowWorktreeInput(false); setWorktreeNew(true); }
                      }}
                      disabled={!worktreeBranch.trim()}
                      className="flex-1 rounded bg-purple-500/20 px-2 py-1 text-xs text-purple-400 hover:bg-purple-500/30 disabled:opacity-30"
                    >
                      Create
                    </button>
                    <button
                      onClick={() => { setShowWorktreeInput(false); setWorktreeBranch(''); setWorktreeNew(true); }}
                      className="flex-1 rounded bg-white/10 px-2 py-1 text-xs text-white/50 hover:bg-white/20"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
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
  onStage,
  onUnstage,
  onCommit,
  onPush,
  onPull,
  onSwitchBranch,
  onCreateWorktree,
  onRemoveWorktree,
  wsConnected = true,
}: GitPanelProps) {
  const [activeTab, setActiveTab] = useState<TabView>('status');

  if (repos.length === 0) {
    if (!wsConnected) {
      return (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8">
          <Loader2 className="h-8 w-8 animate-spin text-white/20" />
          <p className="text-sm text-white/40">Connecting to agent…</p>
        </div>
      );
    }
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
            <RepoGroup
              key={repo.repoPath}
              repo={repo}
              onStage={onStage}
              onUnstage={onUnstage}
              onCommit={onCommit}
              onPush={onPush}
              onPull={onPull}
              onSwitchBranch={onSwitchBranch}
              onCreateWorktree={onCreateWorktree}
              onRemoveWorktree={onRemoveWorktree}
            />
          ))}
        </div>
      ) : (
        <GitHistory
          // Remount on repo switch so selectedCommit / commitDetail / fileDiffs
          // caches (keyed by hash:path) can never leak across repositories.
          key={selectedRepo ?? '__none__'}
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
