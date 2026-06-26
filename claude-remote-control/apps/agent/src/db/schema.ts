// ============================================================================
// Database Row Types
// ============================================================================

export type DbSessionStatus = 'init' | 'working' | 'needs_attention' | 'idle';
// AttentionReason is now a pass-through from Claude Code's notification_type (string)
export type DbAttentionReason = string;
export type DbStatusSource = 'hook' | 'tmux';

export interface DbSession {
  id: number;
  name: string;
  project: string;
  last_event: string | null;
  last_activity: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
  // Status tracking (v17)
  status: DbSessionStatus | null;
  status_source: DbStatusSource | null;
  attention_reason: DbAttentionReason | null;
  last_status_change: number | null;
  // Per-user view isolation (v18). NULL = untagged (legacy/CLI/hook-created);
  // such rows are visible only to the dashboard owner account.
  owner_id: string | null;
}

export interface DbSchemaVersion {
  version: number;
  applied_at: number;
}

// Task status persisted in the tasks table (v19).
export type DbTaskStatus = 'todo' | 'doing' | 'done';

export interface DbTask {
  id: string;
  project: string;
  title: string;
  status: DbTaskStatus;
  // tmux session name this task is allocated to, or NULL when unallocated.
  session_name: string | null;
  sort_order: number;
  // Per-user view isolation, mirrors sessions.owner_id (v18). NULL = owner-only.
  owner_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface CreateTaskInput {
  id: string;
  project: string;
  title: string;
  status?: DbTaskStatus;
  sessionName?: string | null;
  sortOrder?: number;
  ownerId?: string | null;
}

export interface UpdateTaskInput {
  title?: string;
  status?: DbTaskStatus;
  sessionName?: string | null;
  sortOrder?: number;
}

// ============================================================================
// Input Types for Operations
// ============================================================================

export interface UpsertSessionInput {
  project?: string;
  lastEvent?: string | null;
  lastActivity?: number;
  // Status tracking (v17)
  status?: DbSessionStatus | null;
  statusSource?: DbStatusSource | null;
  attentionReason?: DbAttentionReason | null;
  // Per-user view isolation (v18). Set on first creation; never overwritten
  // (upsert uses COALESCE so the original creator keeps ownership).
  ownerId?: string | null;
}

// ============================================================================
// SQL Schema Definitions (v19 - Per-project tasks)
// ============================================================================

export const SCHEMA_VERSION = 19;

export const CREATE_TABLES_SQL = `
-- Sessions: current state of terminal sessions with status tracking
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  project TEXT NOT NULL,
  last_event TEXT,
  last_activity INTEGER NOT NULL,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- Status tracking (v17)
  status TEXT,
  status_source TEXT,
  attention_reason TEXT,
  last_status_change INTEGER,
  -- Per-user view isolation (v18); NULL = untagged (owner-only visibility)
  owner_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id);

-- Tasks: per-project todo items, optionally allocated to a session (v19).
-- project is the same denormalized folder-name key used by sessions.project;
-- session_name mirrors sessions.name (the unique key used everywhere). NULL
-- session_name = task not yet allocated to any open session.
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  session_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_name);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
`;

// ============================================================================
// Migration for v19 (Add per-project tasks table)
// ============================================================================

// Additive: a brand-new table + its indexes. Safe to run repeatedly via IF NOT EXISTS.
export const MIGRATION_19 = `
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo',
  session_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  owner_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project);
CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id);
CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_name);
`;

// ============================================================================
// Migration for v16 (Remove status tracking)
// ============================================================================

export const MIGRATION_16 = `
-- Migration v16: Remove status tracking columns
CREATE TABLE IF NOT EXISTS sessions_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  project TEXT NOT NULL,
  last_event TEXT,
  last_activity INTEGER NOT NULL,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO sessions_new (id, name, project, last_event, last_activity, archived_at, created_at, updated_at)
SELECT id, name, project, last_event, last_activity, archived_at, created_at, updated_at
FROM sessions;

DROP TABLE IF EXISTS sessions;
ALTER TABLE sessions_new RENAME TO sessions;

CREATE INDEX IF NOT EXISTS idx_sessions_name ON sessions(name);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);
CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity);
`;

// ============================================================================
// Retention Configuration
// ============================================================================

export const RETENTION_CONFIG = {
  /** Max age for sessions before cleanup (24 hours) */
  sessionMaxAge: 24 * 60 * 60 * 1000,
  /** Max age for archived sessions before cleanup (30 days) */
  archivedMaxAge: 30 * 24 * 60 * 60 * 1000,
  /** Cleanup interval (1 hour) */
  cleanupInterval: 60 * 60 * 1000,
};
