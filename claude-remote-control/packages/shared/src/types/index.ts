// ============================================================================
// Session Status Types (Hook-based attention notifications)
// ============================================================================

export type SessionStatus = 'init' | 'working' | 'needs_attention' | 'idle';
// AttentionReason is now a pass-through from Claude Code's notification_type
// Known values: permission_prompt, input_request, plan_mode, task_complete, input (from Stop hook)
// Using string to allow any future types from Claude Code
export type AttentionReason = string;
export type StatusSource = 'hook' | 'tmux';

export interface AttentionNotification {
  sessionId: string;
  status: SessionStatus;
  attentionReason?: AttentionReason;
  source: StatusSource;
  timestamp: number;
  eventType: string;
}

// ============================================================================
// Machine types
export interface Machine {
  id: string;
  name: string;
  status: 'online' | 'offline';
  lastSeen: Date | null;
  config: MachineConfig | null;
  createdAt: Date;
}

export interface MachineConfig {
  projects: string[];
  agentUrl?: string; // e.g., "localhost:4678" or "mac.tailnet.ts.net:4678"
}

// Session types
export interface Session {
  id: string;
  machineId: string;
  project: string | null;
  tmuxSession: string | null;
  startedAt: Date;
  endedAt: Date | null;
}

// User types
export interface User {
  id: string;
  email: string;
  name: string | null;
  createdAt: Date;
}

// WebSocket message types - Client to Agent (Terminal)
export type WSMessageToAgent =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'start-claude' }
  | { type: 'ping' }
  | { type: 'request-history'; lines?: number };

// WebSocket message types - Agent to Client (Terminal)
export type WSMessageFromAgent =
  | { type: 'output'; data: string }
  | { type: 'connected'; session: string }
  | { type: 'disconnected' }
  | { type: 'pong' }
  | { type: 'history'; data: string; lines: number };

// Session info for WebSocket (simplified)
export interface WSSessionInfo {
  name: string;
  project: string;
  lastEvent?: string;
  createdAt: number;
  lastActivity?: number;
  archivedAt?: number; // Timestamp when session was archived (undefined = active)
  // Status tracking (from hooks)
  status?: SessionStatus;
  statusSource?: StatusSource;
  attentionReason?: AttentionReason;
  lastStatusChange?: number;
  // Bound sub-path (Story 6.5): absolute path to worktree/subfolder, or undefined for project root
  workingDir?: string;
  // Classified git context for the bound path (computed at list-time, never stored)
  gitCwdContext?: GitCwdContext;
  // Human-readable label (v21): shown in place of the technical tmux name, or undefined = no description
  description?: string;
}

// ============================================================================
// Task types (per-project todo list, allocatable to a session)
// ============================================================================

// 'todo' = not started, 'doing' = picked up, 'done' = finished.
export type TaskStatus = 'todo' | 'doing' | 'done';

/**
 * A todo item that belongs to a *project* (not a session). One project can have
 * many open sessions; a task may optionally be allocated to one of them by its
 * tmux session name (`sessionName`). `null` = not yet allocated.
 */
export interface WSTaskInfo {
  id: string;
  project: string;
  title: string;
  status: TaskStatus;
  /** tmux session name this task is allocated to, or null when unallocated. */
  sessionName: string | null;
  /** Manual ordering within a project (ascending). */
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

/** Body for POST /api/tasks (create). */
export interface CreateTaskRequest {
  project: string;
  title: string;
  sessionName?: string | null;
  status?: TaskStatus;
}

/** Body for PATCH /api/tasks/:id (partial update). */
export interface UpdateTaskRequest {
  title?: string;
  status?: TaskStatus;
  sessionName?: string | null;
  sortOrder?: number;
}

// WebSocket message types - Agent to Client (Sessions channel)
export type WSSessionsMessageFromAgent =
  | { type: 'sessions-list'; sessions: WSSessionInfo[] }
  | { type: 'session-removed'; sessionName: string }
  | { type: 'session-archived'; sessionName: string; session: WSSessionInfo }
  | { type: 'status-update'; session: WSSessionInfo }
  | { type: 'version-info'; agentVersion: string }
  | { type: 'update-pending'; targetVersion: string; message: string }
  // Task channel (piggybacks the /sessions socket, scoped per owner)
  | { type: 'tasks-list'; tasks: WSTaskInfo[] }
  | { type: 'task-created'; task: WSTaskInfo }
  | { type: 'task-updated'; task: WSTaskInfo }
  | { type: 'task-removed'; taskId: string }
  // Git status channel (Story 6.2 — pushed after write actions / on-demand refresh)
  | { type: 'git-status'; project: string; repoPath: string; status: GitRepoStatus };

// API types
export interface RegisterMachineRequest {
  id: string;
  name: string;
  config?: MachineConfig;
}

export interface AgentInfo {
  machine: {
    id: string;
    name: string;
  };
  status: 'online' | 'offline';
  projects: string[];
}

// Session archive
export interface ArchiveSessionResponse {
  success: boolean;
  message: string;
  session?: WSSessionInfo;
}

// Session output capture
export interface SessionOutputResponse {
  sessionName: string;
  output: string;
  totalLines: number;
  returnedLines: number;
  isRunning: boolean;
  capturedAt: number;
  source?: 'live' | 'file' | 'database';
}

// Session input
export interface SessionInputRequest {
  text: string;
  sendEnter?: boolean; // Default true
}

export interface SessionInputResponse {
  success: boolean;
  sessionName?: string;
  bytesSent?: number;
  error?: string;
}

// Agent configuration
export interface AgentConfig {
  machine: {
    id: string;
    name: string;
  };
  agent?: {
    port: number;
    url: string; // e.g., "localhost:4678" or "mac.tailnet.ts.net:4678"
  };
  projects: {
    basePath: string;
    whitelist: string[];
  };
  dashboard: {
    apiUrl: string;
    /**
     * **agentAuthToken** — persistent, single-principal bearer secret that
     * authenticates the web dashboard *to* the agent (web → agent direction).
     *
     * `apiKey` is only the storage field name; the concept is **agentAuthToken**.
     *
     * - Provisioned once by `247 init` (URL-safe base64 via `randomBytes(32).toString('base64url')`).
     * - The agent reads it at the WS upgrade handler; the web sends it as a
     *   `Sec-WebSocket-Protocol` value (and as `Authorization: Bearer` for HTTP).
     * - **URL-safe base64** (no `+`, `/`, or `=`) — mandatory because it is
     *   transmitted as a WS subprotocol token.
     *
     * Optional — a config may legitimately lack the token before `247 init`
     * provisions it, or before a pre-existing agent_connection re-pairs during
     * the enforcement-OFF rollout window (Epic 3, G-9).
     *
     * Distinct from:
     * - `pairingToken` — ephemeral HMAC used only during the pairing handshake
     * - `WEB_AUTH_SECRET` — web session-signing env var (Epic 4), never in agent config
     * - `machineId` — cross-system linking key (`machine.id`)
     */
    apiKey?: string;
  };
}

// ============================================================================
// Git Contract Types (Epic 6 — Story 6.1)
// ============================================================================

/**
 * Result from running a git command via the safe executor.
 */
export interface GitExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Status flags for file changes (git porcelain v2 XY codes).
 */
export interface GitFileStatusFlags {
  index: 'A' | 'D' | 'M' | 'R' | 'C' | 'U' | '?' | '!' | ' ';
  worktree: 'A' | 'D' | 'M' | 'R' | 'C' | 'U' | '?' | '!' | ' ';
}

/**
 * A single file's status from git status --porcelain=v2 -z.
 */
export interface GitFileInfo {
  path: string;
  flags: GitFileStatusFlags;
  indexStatus?: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'unmerged' | 'untracked' | 'ignored' | null;
  worktreeStatus?: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'unmerged' | 'untracked' | 'ignored' | null;
  staged?: boolean;
  /** For renames/copies (type='2'), the original path. */
  origPath?: string;
}

/**
 * Branch information from git status --branch.
 */
export interface GitBranchInfo {
  head: string | null;         // current commit SHA (or null if detached/corrupted)
  upstream: string | null;     // upstream branch ref (e.g., refs/remotes/origin/main)
  ahead: number;               // commits ahead of upstream
  behind: number;              // commits behind upstream
  branchName: string | null;   // symbolic name or null
}

/**
 * Full repository status from git status + --branch.
 */
export interface GitRepoStatus {
  branch: GitBranchInfo;
  files: GitFileInfo[];
  conflicted: number;          // count of unmerged paths
  stagedCount: number;         // count of staged (index != worktree) files
  unstagedCount: number;       // count of unstaged changes
  untrackedCount: number;      // count of untracked files
  ignoredCount: number;        // count of ignored files (if requested)
}

/**
 * Single commit info from git log / git show.
 */
export interface GitCommit {
  hash: string;                // full SHA-1
  shortHash: string;           // abbreviated SHA
  author: string;              // author name
  email: string;               // author email
  timestamp: number;           // Unix timestamp (ms)
  parents: string[];           // parent SHAs (empty for root commit)
  subject: string;             // commit subject line
}

/**
 * A single file diff from git show --numstat.
 */
export interface GitDiffFile {
  path: string;
  additions: number;
  deletions: number;
  binary: boolean;
  origPath?: string;           // for renames/copies
}

/**
 * Extended commit info with file diffs (from git show --numstat).
 */
export interface GitCommitWithDiff extends GitCommit {
  files: GitDiffFile[];
}

/**
 * Discovered repository info.
 */
export interface DiscoveredGitRepo {
  path: string;                // absolute path to repo root
  topLevel: boolean;           // true if this is a worktree/root repo, not a submodule
  worktreeInfo?: {
    mainWorktree: string;      // path to main worktree if this is an attached worktree
    detached: boolean;         // true if detatched worktree
  };
}

/**
 * Input options for discoverRepos().
 */
export interface DiscoverReposOptions {
  cwd?: string;                // starting directory (default process.cwd())
  skipDirs?: string[];         // directory names to skip (e.g., ['node_modules', '.git'])
  maxDepth?: number;           // max directory depth (-1 = unlimited)
  maxRepos?: number;           // cap on total repos found
}

/**
 * Output from discoverRepos().
 */
export interface DiscoverReposResult {
  repos: DiscoveredGitRepo[];
  capped: boolean;             // true if maxRepos/maxDepth limit was hit
}

/**
 * Options for runGit() network operations.
 */
export interface GitRunOptions {
  network?: boolean;           // if true, sets GIT_TERMINAL_PROMPT=0 + SSH BatchMode
  env?: Record<string, string | undefined>; // additional env vars (merged with defaults)
}

/**
 * Safe reference name validator input/output.
 */
export type SafeRefInput = string;
export type SafeRefValid = { valid: true; normalized: string };
export type SafeRefInvalid = { valid: false; reason: string };
export type SafeRefResult = SafeRefValid | SafeRefInvalid;

// ============================================================================
// Git Write Action Types (Epic 6 — Story 6.4)
// ============================================================================

export interface GitWriteResult {
  ok: boolean;
  error?: string;
}

export interface GitStageRequest {
  project: string;
  repo: string;
  pathspecs: string[];
  all?: boolean;
}

export interface GitUnstageRequest {
  project: string;
  repo: string;
  pathspecs: string[];
  all?: boolean;
}

export interface GitCommitRequest {
  project: string;
  repo: string;
  message: string;
}

export interface GitPushPullRequest {
  project: string;
  repo: string;
}

export interface GitBranchRequest {
  project: string;
  repo: string;
  name: string;
  create?: boolean;
}

// ============================================================================
// Worktree types (Epic 6 — Story 6.5)
// ============================================================================

/** One entry from `git worktree list --porcelain`. */
export interface GitWorktree {
  path: string;
  /** HEAD commit SHA; empty string for bare worktrees (which have no HEAD). */
  head: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
}

/** Classification of a path's git context, computed at read time (not stored). */
export interface GitCwdContext {
  /** 'root' = main worktree root; 'worktree' = linked worktree; 'subfolder' = inside main tree */
  kind: 'root' | 'worktree' | 'subfolder';
  /** Absolute path that was classified */
  path: string;
  /** For 'worktree': path of the main worktree */
  mainWorktree?: string;
  /** For 'worktree': branch name (undefined if detached) */
  branch?: string;
  /** The session's bound working_dir, relative to the project root, for UI display. Null = project root. */
  boundPath: string | null;
}

