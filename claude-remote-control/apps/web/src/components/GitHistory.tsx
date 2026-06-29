'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { ChevronDown, ChevronRight, GitCommit as GitCommitIcon, Loader2, GitBranch, GitCompareArrows, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { GitCommit, GitCommitWithDiff, GitDiffFile } from '247-shared';

interface GitHistoryProps {
  commits: GitCommit[];
  graphCommits: GitCommit[] | null;
  graphCapped: boolean;
  loading: boolean;
  graphLoading: boolean;
  onLoadMore?: () => void;
  onToggleGraph: () => void;
  onFetchCommit: (hash: string) => Promise<GitCommitWithDiff | null>;
  onFetchDiff: (hash: string, file: string) => Promise<string | null>;
}

type ViewMode = 'list' | 'graph';

// ── DAG layout helpers ────────────────────────────────────────────────────────

interface CommitNode {
  commit: GitCommit;
  col: number;
  parentCols: Array<{ hash: string; col: number }>;
  maxCol: number;
}

function buildDagLayout(commits: GitCommit[]): CommitNode[] {
  // Map hash → column index. Columns are lanes in the graph.
  const colByHash = new Map<string, number>();
  const nodes: CommitNode[] = [];
  // Track which columns are "active" (have a pending child waiting for this commit)
  const activeLanes: (string | null)[] = [];

  for (const commit of commits) {
    const { hash, parents } = commit;

    // Find or assign a column for this commit
    let col = colByHash.get(hash);
    if (col === undefined) {
      // Find a free lane or open a new one
      const free = activeLanes.indexOf(null);
      col = free !== -1 ? free : activeLanes.length;
      colByHash.set(hash, col);
    }

    // Claim the lane for this commit
    if (col < activeLanes.length) activeLanes[col] = hash;
    else activeLanes.push(hash);

    // Assign columns to parents
    const parentCols: Array<{ hash: string; col: number }> = [];
    for (let i = 0; i < parents.length; i++) {
      const p = parents[i];
      if (!colByHash.has(p)) {
        if (i === 0) {
          // First parent inherits this commit's lane
          colByHash.set(p, col);
          activeLanes[col] = p;
        } else {
          // Additional parents (merge commits) get a new lane
          const newLane = activeLanes.indexOf(null);
          const pCol = newLane !== -1 ? newLane : activeLanes.length;
          colByHash.set(p, pCol);
          if (pCol < activeLanes.length) activeLanes[pCol] = p;
          else activeLanes.push(p);
        }
      }
      const pCol = colByHash.get(p)!;
      parentCols.push({ hash: p, col: pCol });
    }

    // If no parents (root commit), free the lane
    if (parents.length === 0) {
      activeLanes[col] = null;
    }

    const maxCol = Math.max(col, ...parentCols.map((p) => p.col), 0);
    nodes.push({ commit, col, parentCols, maxCol });
  }

  return nodes;
}

const LANE_COLORS = [
  '#f97316', // orange
  '#3b82f6', // blue
  '#22c55e', // green
  '#a855f7', // purple
  '#ec4899', // pink
  '#14b8a6', // teal
  '#eab308', // yellow
  '#ef4444', // red
];

function laneColor(col: number): string {
  return LANE_COLORS[col % LANE_COLORS.length];
}

// SVG column width and circle radius constants
const COL_W = 16;
const R = 4;

function DagRow({ node }: { node: CommitNode }) {
  const { commit, col, parentCols, maxCol } = node;
  const totalCols = maxCol + 1;
  const svgW = totalCols * COL_W + 4;

  return (
    <svg width={svgW} height={20} className="flex-shrink-0 overflow-visible" aria-hidden>
      {/* Connector lines to parents */}
      {parentCols.map(({ col: pCol }, i) => {
        const x1 = col * COL_W + COL_W / 2;
        const x2 = pCol * COL_W + COL_W / 2;
        const y1 = 10;
        const y2 = 20;
        const color = laneColor(i === 0 ? col : pCol);
        if (x1 === x2) {
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={color} strokeWidth={1.5} />;
        }
        return (
          <path
            key={i}
            d={`M ${x1} ${y1} C ${x1} ${y2} ${x2} ${y1} ${x2} ${y2}`}
            stroke={color}
            strokeWidth={1.5}
            fill="none"
          />
        );
      })}
      {/* Commit dot */}
      <circle cx={col * COL_W + COL_W / 2} cy={10} r={R} fill={laneColor(col)} />
    </svg>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function GitHistory({
  commits,
  graphCommits,
  graphCapped,
  loading,
  graphLoading,
  onLoadMore,
  onToggleGraph,
  onFetchCommit,
  onFetchDiff,
}: GitHistoryProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [commitDetail, setCommitDetail] = useState<GitCommitWithDiff | null>(null);
  const [loadingCommit, setLoadingCommit] = useState(false);
  const [commitError, setCommitError] = useState(false);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());
  const [fileDiffs, setFileDiffs] = useState<Map<string, string>>(new Map());
  const [loadingDiffs, setLoadingDiffs] = useState<Set<string>>(new Set());

  // Abort controller ref for in-flight commit fetches — prevents stale overwrites
  const commitFetchSeq = useRef(0);
  // Abort controllers keyed by fileKey for in-flight diff fetches
  const diffAborts = useRef<Map<string, AbortController>>(new Map());

  // Memoised DAG nodes — only recompute when graphCommits changes
  const dagNodes = useRef<CommitNode[]>([]);
  useEffect(() => {
    if (graphCommits) dagNodes.current = buildDagLayout(graphCommits);
  }, [graphCommits]);

  const handleSelectCommit = useCallback(async (hash: string) => {
    if (selectedCommit === hash) {
      setSelectedCommit(null);
      setCommitDetail(null);
      setExpandedFiles(new Set());
      return;
    }

    // Cancel any in-flight diff fetches from the previous commit
    for (const ctrl of diffAborts.current.values()) ctrl.abort();
    diffAborts.current.clear();

    setSelectedCommit(hash);
    setLoadingCommit(true);
    setCommitDetail(null);
    setCommitError(false);
    setExpandedFiles(new Set());
    setFileDiffs(new Map());
    setLoadingDiffs(new Set());

    const seq = ++commitFetchSeq.current;
    try {
      const detail = await onFetchCommit(hash);
      // Discard if a newer selection has already been made
      if (seq !== commitFetchSeq.current) return;
      if (detail) {
        setCommitDetail(detail);
      } else {
        setCommitError(true);
      }
    } catch {
      if (seq !== commitFetchSeq.current) return;
      setCommitError(true);
    } finally {
      if (seq === commitFetchSeq.current) setLoadingCommit(false);
    }
  }, [selectedCommit, onFetchCommit]);

  const handleToggleFile = useCallback(async (file: GitDiffFile, commitHash: string) => {
    const fileKey = `${commitHash}:${file.path}`;
    const newExpanded = new Set(expandedFiles);

    if (newExpanded.has(fileKey)) {
      newExpanded.delete(fileKey);
      setExpandedFiles(newExpanded);
      return;
    }

    newExpanded.add(fileKey);
    setExpandedFiles(newExpanded);

    if (!fileDiffs.has(fileKey)) {
      // Cancel any previous in-flight fetch for this key
      diffAborts.current.get(fileKey)?.abort();
      const ctrl = new AbortController();
      diffAborts.current.set(fileKey, ctrl);

      setLoadingDiffs((prev) => new Set(prev).add(fileKey));
      try {
        const diff = await onFetchDiff(commitHash, file.path);
        if (ctrl.signal.aborted) return;
        if (diff !== null) {
          setFileDiffs((prev) => new Map(prev).set(fileKey, diff));
        }
      } catch {
        // Fetch aborted or failed — leave diff entry absent so user can retry by collapsing + expanding
      } finally {
        if (!ctrl.signal.aborted) {
          setLoadingDiffs((prev) => {
            const next = new Set(prev);
            next.delete(fileKey);
            return next;
          });
        }
        diffAborts.current.delete(fileKey);
      }
    }
  }, [expandedFiles, fileDiffs, onFetchDiff]);

  const handleViewToggle = useCallback(() => {
    const next: ViewMode = viewMode === 'list' ? 'graph' : 'list';
    setViewMode(next);
    onToggleGraph();
  }, [viewMode, onToggleGraph]);

  const formatRelativeTime = useCallback((timestamp: number) => {
    const now = Date.now();
    const diff = now - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    if (minutes > 0) return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
    return 'just now';
  }, []);

  const displayCommits = viewMode === 'graph' && graphCommits ? graphCommits : commits;
  const isLoading = viewMode === 'graph' ? graphLoading : loading;
  const currentDagNodes = viewMode === 'graph' ? dagNodes.current : [];

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-auto">
      {/* View mode toggle */}
      <div className="flex items-center gap-2 px-4 pt-2">
        <button
          onClick={handleViewToggle}
          className={cn(
            'flex items-center gap-2 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors',
            viewMode === 'list'
              ? 'bg-white/10 text-white'
              : 'bg-white/5 text-white/60 hover:bg-white/10'
          )}
          title={viewMode === 'list' ? 'Switch to graph view' : 'Switch to list view'}
        >
          {viewMode === 'list' ? (
            <>
              <GitCompareArrows className="h-3.5 w-3.5" />
              <span>List view</span>
            </>
          ) : (
            <>
              <GitBranch className="h-3.5 w-3.5" />
              <span>Graph view</span>
            </>
          )}
        </button>

        {viewMode === 'graph' && graphCapped && (
          <div className="flex items-center gap-1.5 rounded-lg bg-amber-500/10 px-2.5 py-1 text-xs text-amber-400">
            <AlertTriangle className="h-3 w-3" />
            <span>Showing {graphCommits?.length ?? 0} most recent commits (capped)</span>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center gap-2 p-8 text-sm text-white/50">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Loading {viewMode === 'graph' ? 'graph' : 'history'}...</span>
        </div>
      ) : displayCommits.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 p-8">
          <GitCommitIcon className="h-12 w-12 text-white/20" />
          <div className="text-center">
            <p className="text-sm font-medium text-white/50">No commits found</p>
            <p className="mt-1 text-xs text-white/30">
              This repository has no commit history
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1 px-4 pb-4">
          {displayCommits.map((commit, idx) => {
            const isSelected = selectedCommit === commit.hash;
            const dagNode = currentDagNodes[idx];

            return (
              <div key={commit.hash} className="flex flex-col">
                <button
                  onClick={() => handleSelectCommit(commit.hash)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors',
                    isSelected
                      ? 'bg-orange-500/15 text-white'
                      : 'text-white/80 hover:bg-white/5'
                  )}
                >
                  {/* DAG rail column (graph mode only) */}
                  {viewMode === 'graph' && dagNode && (
                    <DagRow node={dagNode} />
                  )}

                  {isSelected ? (
                    <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-white/50" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-white/30" />
                  )}

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{commit.subject}</p>
                    <div className="flex items-center gap-2 text-xs text-white/40">
                      <span>{commit.author}</span>
                      <span>·</span>
                      <span>{formatRelativeTime(commit.timestamp)}</span>
                      <span>·</span>
                      <span className="font-mono">{commit.shortHash}</span>
                    </div>
                  </div>
                </button>

                {/* Commit detail */}
                {isSelected && (
                  <div className="ml-6 mt-1 rounded-lg border border-white/10 bg-white/5 p-3">
                    {loadingCommit ? (
                      <div className="flex items-center gap-2 text-sm text-white/50">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        <span>Loading commit details…</span>
                      </div>
                    ) : commitError ? (
                      <p className="text-sm text-white/50">Failed to load commit details</p>
                    ) : commitDetail ? (
                      <div className="flex flex-col gap-2">
                        <p className="text-xs text-white/40">
                          {commitDetail.files.length} file{commitDetail.files.length !== 1 ? 's' : ''} changed
                        </p>
                        {commitDetail.files.map((file) => {
                          const fileKey = `${commit.hash}:${file.path}`;
                          const isExpanded = expandedFiles.has(fileKey);
                          const isLoadingDiff = loadingDiffs.has(fileKey);
                          const diffContent = fileDiffs.get(fileKey);

                          return (
                            <div key={file.path} className="flex flex-col gap-1">
                              <button
                                onClick={() => handleToggleFile(file, commit.hash)}
                                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-white/5"
                              >
                                {isExpanded ? (
                                  <ChevronDown className="h-3 w-3 flex-shrink-0 text-white/40" />
                                ) : (
                                  <ChevronRight className="h-3 w-3 flex-shrink-0 text-white/30" />
                                )}
                                <span className="min-w-0 flex-1 truncate font-mono text-white/70">
                                  {file.path}
                                </span>
                                {!file.binary && (
                                  <span className="flex-shrink-0 text-white/30">
                                    <span className="text-emerald-400">+{file.additions}</span>
                                    {' '}
                                    <span className="text-red-400">-{file.deletions}</span>
                                  </span>
                                )}
                                {file.binary && (
                                  <span className="flex-shrink-0 text-white/30">binary</span>
                                )}
                              </button>

                              {isExpanded && (
                                <div className="ml-5 overflow-x-auto rounded border border-white/10 bg-black/30 p-2">
                                  {isLoadingDiff ? (
                                    <div className="flex items-center gap-2 text-xs text-white/40">
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                      <span>Loading diff…</span>
                                    </div>
                                  ) : diffContent !== undefined ? (
                                    <pre className="whitespace-pre text-xs leading-relaxed text-white/70">
                                      {diffContent}
                                    </pre>
                                  ) : (
                                    <p className="text-xs text-white/30">No diff available</p>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            );
          })}

          {viewMode === 'list' && onLoadMore && (
            <button
              onClick={onLoadMore}
              className="mt-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-white/80 transition-colors hover:bg-white/10"
            >
              Load more commits
            </button>
          )}
        </div>
      )}
    </div>
  );
}
