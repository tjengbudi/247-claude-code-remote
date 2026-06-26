/**
 * Per-project tasks DB module (v19).
 *
 * Drives the REAL db modules via the test-only in-memory database, so schema
 * drift is caught. Covers CRUD, default ordering, allocation (incl. explicit
 * unallocate), owner-scoped listing, and visibility.
 */
import { describe, it, expect, afterEach } from 'vitest';

afterEach(async () => {
  try {
    const { closeDatabase } = await import('../../src/db/index.js');
    closeDatabase();
  } catch {
    // ignore
  }
});

const OWNER = { ownerId: 'u1', isOwner: false };

async function freshDb() {
  const { initTestDatabase } = await import('../../src/db/index.js');
  initTestDatabase();
  return import('../../src/db/tasks.js');
}

describe('createTask', () => {
  it('creates a task with defaults (todo, unallocated)', async () => {
    const tasks = await freshDb();
    const t = tasks.createTask({ id: 'a', project: 'proj', title: 'First', ownerId: 'u1' });
    expect(t.id).toBe('a');
    expect(t.project).toBe('proj');
    expect(t.title).toBe('First');
    expect(t.status).toBe('todo');
    expect(t.session_name).toBeNull();
    expect(t.owner_id).toBe('u1');
    expect(t.created_at).toBe(t.updated_at);
  });

  it('auto-increments sort_order within a project', async () => {
    const tasks = await freshDb();
    const a = tasks.createTask({ id: 'a', project: 'p', title: 'A' });
    const b = tasks.createTask({ id: 'b', project: 'p', title: 'B' });
    const c = tasks.createTask({ id: 'c', project: 'other', title: 'C' });
    expect(a.sort_order).toBe(0);
    expect(b.sort_order).toBe(1);
    // Separate project starts its own ordering.
    expect(c.sort_order).toBe(0);
  });
});

describe('listTasks', () => {
  it('filters by project and orders by sort_order', async () => {
    const tasks = await freshDb();
    tasks.createTask({ id: 'a', project: 'p', title: 'A', ownerId: 'u1' });
    tasks.createTask({ id: 'b', project: 'p', title: 'B', ownerId: 'u1' });
    tasks.createTask({ id: 'c', project: 'q', title: 'C', ownerId: 'u1' });

    const p = tasks.listTasks(OWNER, 'p');
    expect(p.map((t) => t.id)).toEqual(['a', 'b']);

    const all = tasks.listTasks(OWNER);
    expect(all).toHaveLength(3);
  });

  it('applies owner visibility (own vs other vs untagged)', async () => {
    const tasks = await freshDb();
    tasks.createTask({ id: 'mine', project: 'p', title: 'Mine', ownerId: 'u1' });
    tasks.createTask({ id: 'theirs', project: 'p', title: 'Theirs', ownerId: 'u2' });
    tasks.createTask({ id: 'untagged', project: 'p', title: 'Legacy', ownerId: null });

    // u1 (not owner account) sees only its own task.
    expect(tasks.listTasks({ ownerId: 'u1', isOwner: false }).map((t) => t.id)).toEqual(['mine']);

    // The owner account sees its own + untagged, but not another user's.
    const ownerView = tasks.listTasks({ ownerId: 'u1', isOwner: true }).map((t) => t.id);
    expect(ownerView).toContain('mine');
    expect(ownerView).toContain('untagged');
    expect(ownerView).not.toContain('theirs');
  });
});

describe('updateTask', () => {
  it('updates status and bumps updated_at', async () => {
    const tasks = await freshDb();
    const created = tasks.createTask({ id: 'a', project: 'p', title: 'A' });
    await new Promise((r) => setTimeout(r, 5));
    const updated = tasks.updateTask('a', { status: 'done' });
    expect(updated?.status).toBe('done');
    expect(updated?.updated_at).toBeGreaterThan(created.updated_at);
    // created_at is immutable.
    expect(updated?.created_at).toBe(created.created_at);
  });

  it('allocates and explicitly unallocates a session', async () => {
    const tasks = await freshDb();
    tasks.createTask({ id: 'a', project: 'p', title: 'A' });

    const allocated = tasks.updateTask('a', { sessionName: 'p--sess1' });
    expect(allocated?.session_name).toBe('p--sess1');

    // undefined leaves it unchanged…
    const unchanged = tasks.updateTask('a', { title: 'A2' });
    expect(unchanged?.session_name).toBe('p--sess1');

    // …null clears it.
    const cleared = tasks.updateTask('a', { sessionName: null });
    expect(cleared?.session_name).toBeNull();
  });

  it('returns null for a missing task', async () => {
    const tasks = await freshDb();
    expect(tasks.updateTask('nope', { status: 'done' })).toBeNull();
  });
});

describe('deleteTask', () => {
  it('removes a task and reports success', async () => {
    const tasks = await freshDb();
    tasks.createTask({ id: 'a', project: 'p', title: 'A' });
    expect(tasks.deleteTask('a')).toBe(true);
    expect(tasks.getTask('a')).toBeNull();
    // Deleting again is a no-op.
    expect(tasks.deleteTask('a')).toBe(false);
  });
});

describe('taskToWire', () => {
  it('maps a DB row to the wire shape', async () => {
    const tasks = await freshDb();
    const row = tasks.createTask({
      id: 'a',
      project: 'p',
      title: 'A',
      sessionName: 'p--s1',
      ownerId: 'u1',
    });
    const wire = tasks.taskToWire(row);
    expect(wire).toEqual({
      id: 'a',
      project: 'p',
      title: 'A',
      status: 'todo',
      sessionName: 'p--s1',
      sortOrder: row.sort_order,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    // owner_id is intentionally NOT on the wire shape.
    expect('owner_id' in wire).toBe(false);
  });
});
