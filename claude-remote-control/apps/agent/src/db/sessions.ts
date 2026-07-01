import { getDatabase } from './index.js';
import type { DbSession, UpsertSessionInput } from './schema.js';

/**
 * Identity of the dashboard viewer requesting sessions, threaded from the web
 * client (browser→agent) via WS/HTTP query params. Soft / view-isolation:
 * the agent trusts the claimed `ownerId` (the shared agent token carries no
 * per-user identity), filtering its session list by it.
 */
export interface ViewerContext {
  /** Web user id of the viewer, or null when none was supplied (legacy client). */
  ownerId: string | null;
  /** True when the viewer is the dashboard owner (first/bootstrap account). */
  isOwner: boolean;
}

/**
 * Whether a session is visible to a given viewer.
 * - You always see sessions you own (owner_id === your id).
 * - Untagged sessions (owner_id NULL — legacy/CLI/hook-created) are visible
 *   ONLY to the owner account.
 *
 * A null viewer ownerId (no identity supplied) only ever matches untagged rows
 * when the viewer is the owner — it never collides with a real user's id.
 */
export function isSessionVisible(
  session: Pick<DbSession, 'owner_id'>,
  viewer: ViewerContext
): boolean {
  if (session.owner_id == null) {
    return viewer.isOwner;
  }
  return session.owner_id === viewer.ownerId;
}

/**
 * Get a session by name
 */
export function getSession(name: string): DbSession | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM sessions WHERE name = ?').get(name) as
    | DbSession
    | undefined;
  return row ?? null;
}

/**
 * Get all active (non-archived) sessions
 */
export function getAllSessions(): DbSession[] {
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM sessions WHERE archived_at IS NULL ORDER BY last_activity DESC')
    .all() as DbSession[];
}

/**
 * Get all archived sessions
 */
export function getArchivedSessions(): DbSession[] {
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM sessions WHERE archived_at IS NOT NULL ORDER BY archived_at DESC')
    .all() as DbSession[];
}

/**
 * Upsert a session (insert or update)
 */
export function upsertSession(name: string, input: UpsertSessionInput): DbSession {
  const db = getDatabase();
  const now = Date.now();

  const existing = getSession(name);

  // Determine if status is changing
  const statusChanging = input.status !== undefined && input.status !== existing?.status;
  const lastStatusChange = statusChanging ? now : (existing?.last_status_change ?? null);

  const stmt = db.prepare(`
    INSERT INTO sessions (
      name, project, last_event,
      last_activity, created_at, updated_at,
      status, status_source, attention_reason, last_status_change,
      owner_id, working_dir, description
    )
    VALUES (
      @name, @project, @lastEvent,
      @lastActivity, @createdAt, @updatedAt,
      @status, @statusSource, @attentionReason, @lastStatusChange,
      @ownerId, @workingDir, @description
    )
    ON CONFLICT(name) DO UPDATE SET
      last_event = COALESCE(@lastEvent, last_event),
      last_activity = COALESCE(@lastActivity, last_activity),
      updated_at = @updatedAt,
      status = COALESCE(@status, status),
      status_source = COALESCE(@statusSource, status_source),
      attention_reason = CASE WHEN @status IS NOT NULL THEN @attentionReason ELSE attention_reason END,
      last_status_change = COALESCE(@lastStatusChange, last_status_change),
      -- First writer wins: a later viewer must never steal ownership.
      owner_id = COALESCE(owner_id, @ownerId),
      -- working_dir: COALESCE preserves stored binding when caller omits workingDir.
      -- Use clearSessionWorkingDir() to explicitly reset to NULL.
      working_dir = COALESCE(@workingDir, working_dir),
      -- description: COALESCE preserves stored label when caller omits description.
      -- The description route passes null explicitly to clear it.
      description = COALESCE(@description, description)
  `);

  stmt.run({
    name,
    project: input.project ?? existing?.project ?? 'unknown',
    lastEvent: input.lastEvent ?? null,
    lastActivity: input.lastActivity ?? now,
    createdAt: existing?.created_at ?? now,
    updatedAt: now,
    status: input.status ?? null,
    statusSource: input.statusSource ?? null,
    attentionReason: input.attentionReason ?? null,
    lastStatusChange,
    ownerId: input.ownerId ?? null,
    workingDir: input.workingDir ?? null,
    description: input.description ?? null,
  });

  return getSession(name)!;
}

/**
 * Delete a session
 */
export function deleteSession(name: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM sessions WHERE name = ?').run(name);
  return result.changes > 0;
}

/**
 * Archive a session (mark as done and keep in history)
 * Returns the archived session or null if not found
 */
export function archiveSession(name: string): DbSession | null {
  const db = getDatabase();
  const now = Date.now();

  const existing = getSession(name);
  if (!existing) {
    return null;
  }

  // Already archived
  if (existing.archived_at) {
    return existing;
  }

  db.prepare(
    `
    UPDATE sessions SET
      archived_at = ?,
      updated_at = ?
    WHERE name = ?
  `
  ).run(now, now, name);

  console.log(`[DB] Archived session: ${name}`);
  return getSession(name);
}

/**
 * Reconcile sessions with active tmux sessions
 * - Sessions in DB but not in tmux: delete if old
 * - Sessions in tmux but not in DB: will be created when they connect
 * - Archived sessions are skipped (they don't have tmux sessions)
 */
export function reconcileWithTmux(activeTmuxSessions: Set<string>): void {
  const dbSessions = getAllSessions(); // Only gets non-archived sessions
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000; // 24 hours

  console.log(
    `[DB] Reconciling ${dbSessions.length} DB sessions with ${activeTmuxSessions.size} tmux sessions`
  );

  // Handle sessions in DB but not in tmux (skip archived - they're already handled)
  for (const session of dbSessions) {
    if (!activeTmuxSessions.has(session.name)) {
      const age = now - session.last_activity;

      if (age > maxAge) {
        // Delete old sessions
        deleteSession(session.name);
        console.log(`[DB] Deleted stale session: ${session.name}`);
      }
    }
  }

  // Handle sessions in tmux but not in DB
  // These will be created when they receive their first connection
  // We don't create them here because we don't have project info
}

export function clearSessionWorkingDir(name: string): void {
  const db = getDatabase();
  db.prepare('UPDATE sessions SET working_dir = NULL WHERE name = @name').run({ name });
}

/**
 * Set (or clear) a session's human-readable description.
 * Pass null to clear. Unlike upsertSession (which COALESCEs description to
 * preserve on omission), this always writes the given value, so it can reset
 * the label to NULL. Returns the updated session, or null if it doesn't exist.
 */
export function setSessionDescription(name: string, description: string | null): DbSession | null {
  const db = getDatabase();
  const existing = getSession(name);
  if (!existing) {
    return null;
  }
  db.prepare(
    'UPDATE sessions SET description = @description, updated_at = @updatedAt WHERE name = @name'
  ).run({ name, description, updatedAt: Date.now() });
  return getSession(name);
}
