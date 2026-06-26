import { getDatabase } from './index.js';
import type { DbTask, CreateTaskInput, UpdateTaskInput } from './schema.js';
import { isSessionVisible, type ViewerContext } from './sessions.js';
import type { WSTaskInfo } from '247-shared';

/**
 * Task visibility reuses the exact same owner-isolation rule as sessions:
 * - You always see tasks you own (owner_id === your id).
 * - Untagged tasks (owner_id NULL — legacy/CLI-created) are visible ONLY to the
 *   owner account.
 *
 * Kept as a thin wrapper over isSessionVisible so the two surfaces never drift.
 */
export function isTaskVisible(
  task: Pick<DbTask, 'owner_id'>,
  viewer: ViewerContext
): boolean {
  return isSessionVisible({ owner_id: task.owner_id }, viewer);
}

/** Map a DB row to the wire shape sent to web clients. */
export function taskToWire(task: DbTask): WSTaskInfo {
  return {
    id: task.id,
    project: task.project,
    title: task.title,
    status: task.status,
    sessionName: task.session_name,
    sortOrder: task.sort_order,
    createdAt: task.created_at,
    updatedAt: task.updated_at,
  };
}

/** Get a single task by id (no visibility filtering — caller checks). */
export function getTask(id: string): DbTask | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as DbTask | undefined;
  return row ?? null;
}

/**
 * List tasks visible to a viewer, optionally filtered to one project.
 * Ordered by sort_order then creation time for stable display.
 */
export function listTasks(viewer: ViewerContext, project?: string): DbTask[] {
  const db = getDatabase();
  const rows = (
    project
      ? db
          .prepare(
            'SELECT * FROM tasks WHERE project = ? ORDER BY sort_order ASC, created_at ASC'
          )
          .all(project)
      : db.prepare('SELECT * FROM tasks ORDER BY sort_order ASC, created_at ASC').all()
  ) as DbTask[];

  return rows.filter((t) => isTaskVisible(t, viewer));
}

/** Create a task. The caller supplies the id (uuid). Returns the stored row. */
export function createTask(input: CreateTaskInput): DbTask {
  const db = getDatabase();
  const now = Date.now();

  // New tasks land at the bottom of their project by default.
  let sortOrder = input.sortOrder;
  if (sortOrder === undefined) {
    const max = db
      .prepare('SELECT MAX(sort_order) as maxOrder FROM tasks WHERE project = ?')
      .get(input.project) as { maxOrder: number | null };
    sortOrder = (max.maxOrder ?? -1) + 1;
  }

  db.prepare(
    `
    INSERT INTO tasks (
      id, project, title, status, session_name, sort_order, owner_id, created_at, updated_at
    )
    VALUES (
      @id, @project, @title, @status, @sessionName, @sortOrder, @ownerId, @createdAt, @updatedAt
    )
  `
  ).run({
    id: input.id,
    project: input.project,
    title: input.title,
    status: input.status ?? 'todo',
    sessionName: input.sessionName ?? null,
    sortOrder,
    ownerId: input.ownerId ?? null,
    createdAt: now,
    updatedAt: now,
  });

  return getTask(input.id)!;
}

/**
 * Partially update a task. Only provided fields change. Returns the updated row,
 * or null if the task does not exist.
 */
export function updateTask(id: string, input: UpdateTaskInput): DbTask | null {
  const db = getDatabase();
  const existing = getTask(id);
  if (!existing) {
    return null;
  }

  const now = Date.now();
  db.prepare(
    `
    UPDATE tasks SET
      title = @title,
      status = @status,
      session_name = @sessionName,
      sort_order = @sortOrder,
      updated_at = @updatedAt
    WHERE id = @id
  `
  ).run({
    id,
    title: input.title ?? existing.title,
    status: input.status ?? existing.status,
    // sessionName is explicitly nullable: undefined = keep, null = unallocate.
    sessionName: input.sessionName === undefined ? existing.session_name : input.sessionName,
    sortOrder: input.sortOrder ?? existing.sort_order,
    updatedAt: now,
  });

  return getTask(id);
}

/** Delete a task. Returns true if a row was removed. */
export function deleteTask(id: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  return result.changes > 0;
}
