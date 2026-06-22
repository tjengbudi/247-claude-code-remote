/**
 * Per-user session view isolation (v18).
 *
 * Covers the three pieces the feature rests on:
 *  1. isSessionVisible — the pure visibility predicate (own / other / untagged).
 *  2. upsertSession owner_id — persisted on create, COALESCE-protected on update.
 *  3. v17→v18 migration — owner_id column is ALTERed onto an existing DB.
 *
 * Tests drive the REAL db modules (not an inline re-implementation) via the
 * test-only in-memory database, so schema drift is caught.
 */
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

afterEach(async () => {
  // Each test re-imports fresh modules; close any open singleton DB.
  try {
    const { closeDatabase } = await import('../../src/db/index.js');
    closeDatabase();
  } catch {
    // ignore
  }
});

describe('isSessionVisible', () => {
  it('is true when the viewer owns the session', async () => {
    const { isSessionVisible } = await import('../../src/db/sessions.js');
    expect(isSessionVisible({ owner_id: 'u1' }, { ownerId: 'u1', isOwner: false })).toBe(true);
  });

  it('is false when another user owns the session', async () => {
    const { isSessionVisible } = await import('../../src/db/sessions.js');
    expect(isSessionVisible({ owner_id: 'u2' }, { ownerId: 'u1', isOwner: false })).toBe(false);
    // even the owner account does not see another user's tagged session
    expect(isSessionVisible({ owner_id: 'u2' }, { ownerId: 'u1', isOwner: true })).toBe(false);
  });

  it('shows untagged (null) sessions only to the owner account', async () => {
    const { isSessionVisible } = await import('../../src/db/sessions.js');
    expect(isSessionVisible({ owner_id: null }, { ownerId: 'u1', isOwner: true })).toBe(true);
    expect(isSessionVisible({ owner_id: null }, { ownerId: 'u1', isOwner: false })).toBe(false);
    // a null-owner viewer that is the owner still sees untagged rows
    expect(isSessionVisible({ owner_id: null }, { ownerId: null, isOwner: true })).toBe(true);
  });
});

describe('upsertSession owner_id (v18)', () => {
  it('persists owner_id on creation', async () => {
    const { initTestDatabase } = await import('../../src/db/index.js');
    initTestDatabase();
    const { upsertSession, getSession } = await import('../../src/db/sessions.js');

    upsertSession('proj--a', { project: 'proj', ownerId: 'alice', lastActivity: Date.now() });

    expect(getSession('proj--a')?.owner_id).toBe('alice');
  });

  it('defaults owner_id to null when not provided (hook/CLI path)', async () => {
    const { initTestDatabase } = await import('../../src/db/index.js');
    initTestDatabase();
    const { upsertSession, getSession } = await import('../../src/db/sessions.js');

    upsertSession('proj--b', { project: 'proj', lastActivity: Date.now() });

    expect(getSession('proj--b')?.owner_id).toBeNull();
  });

  it('keeps the original owner on later upserts (COALESCE, first writer wins)', async () => {
    const { initTestDatabase } = await import('../../src/db/index.js');
    initTestDatabase();
    const { upsertSession, getSession } = await import('../../src/db/sessions.js');

    upsertSession('proj--c', { project: 'proj', ownerId: 'alice', lastActivity: Date.now() });
    // A later status update from any path must NOT change ownership.
    upsertSession('proj--c', { project: 'proj', status: 'working', ownerId: 'bob' });

    expect(getSession('proj--c')?.owner_id).toBe('alice');
  });

  it('does not clobber an existing owner when a later upsert omits ownerId', async () => {
    const { initTestDatabase } = await import('../../src/db/index.js');
    initTestDatabase();
    const { upsertSession, getSession } = await import('../../src/db/sessions.js');

    upsertSession('proj--d', { project: 'proj', ownerId: 'alice', lastActivity: Date.now() });
    upsertSession('proj--d', { project: 'proj', status: 'idle' });

    expect(getSession('proj--d')?.owner_id).toBe('alice');
  });
});

describe('v17 → v18 migration', () => {
  it('the real migration ALTERs owner_id onto an existing v17 DB and preserves rows', async () => {
    // Seed a v17-shaped DB file, then let the REAL initDatabase run migrations.
    const dir = mkdtempSync(join(tmpdir(), 'agent-v18-'));
    const dbPath = join(dir, 'agent.db');
    try {
      const seed = new Database(dbPath);
      seed.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
        CREATE TABLE sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          project TEXT NOT NULL,
          last_event TEXT,
          last_activity INTEGER NOT NULL,
          archived_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          status TEXT,
          status_source TEXT,
          attention_reason TEXT,
          last_status_change INTEGER
        );
        INSERT INTO schema_version (version, applied_at) VALUES (17, 0);
        INSERT INTO sessions (name, project, last_activity, created_at, updated_at)
        VALUES ('legacy--x', 'legacy', 1, 1, 1);
      `);
      const before = (seed.pragma('table_info(sessions)') as Array<{ name: string }>).map(
        (c) => c.name
      );
      expect(before).not.toContain('owner_id');
      seed.close();

      const { initDatabase, closeDatabase } = await import('../../src/db/index.js');
      const db = initDatabase(dbPath);

      const after = (db.pragma('table_info(sessions)') as Array<{ name: string }>).map((c) => c.name);
      expect(after).toContain('owner_id');

      // Existing rows survive and stay untagged (owner-only visibility).
      const row = db.prepare(`SELECT owner_id FROM sessions WHERE name = 'legacy--x'`).get() as {
        owner_id: string | null;
      };
      expect(row.owner_id).toBeNull();

      const ver = db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number };
      expect(ver.v).toBe(18);

      closeDatabase();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fresh initTestDatabase already has owner_id + index', async () => {
    const { initTestDatabase, getDatabase } = await import('../../src/db/index.js');
    initTestDatabase();
    const db = getDatabase();

    const cols = (db.pragma('table_info(sessions)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('owner_id');

    const indexes = (db.pragma('index_list(sessions)') as Array<{ name: string }>).map(
      (i) => i.name
    );
    expect(indexes).toContain('idx_sessions_owner');
  });
});
