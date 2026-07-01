/**
 * Tests for database migration v20 (working_dir column)
 * Story 6.5: Session binding to worktree/subfolder
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../src/db/index.js';
import { SCHEMA_VERSION } from '../../src/db/schema.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Database Migration v20 - working_dir column', () => {
  let db: Database.Database;
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    // Create temporary directory for test database
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-db-test-'));
    dbPath = path.join(tempDir, 'test.db');
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
    // Clean up temporary directory
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should have a schema version at or beyond 20', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(20);
  });

  it('should add working_dir column to sessions table', () => {
    db = initDatabase(dbPath);

    const columns = db.prepare(`
      SELECT name FROM pragma_table_info('sessions')
    `).all();

    const columnNames = columns.map((col: any) => col.name);
    expect(columnNames).toContain('working_dir');
  });

  it('should allow NULL values for working_dir', () => {
    db = initDatabase(dbPath);

    // Insert session without working_dir
    db.prepare(`
      INSERT INTO sessions (
        name, project, last_event, last_activity, created_at, updated_at,
        status, status_source, attention_reason, last_status_change, owner_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('test-session', 'test-project', 'test-event', Date.now(), Date.now(), Date.now(),
           'idle', 'hook', null, Date.now(), 'test-user');

    const result = db.prepare('SELECT working_dir FROM sessions WHERE name = ?').get('test-session');
    expect(result).toBeDefined();
    expect((result as any).working_dir).toBeNull();
  });

  it('should store working_dir when provided', () => {
    db = initDatabase(dbPath);

    const worktreePath = '/home/user/project/.worktrees/feature-branch';

    db.prepare(`
      INSERT INTO sessions (
        name, project, last_event, last_activity, created_at, updated_at,
        status, status_source, attention_reason, last_status_change, owner_id, working_dir
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('test-session', 'test-project', 'test-event', Date.now(), Date.now(), Date.now(),
           'idle', 'hook', null, Date.now(), 'test-user', worktreePath);

    const result = db.prepare('SELECT working_dir FROM sessions WHERE name = ?').get('test-session');
    expect(result).toBeDefined();
    expect((result as any).working_dir).toBe(worktreePath);
  });

  it('should update working_dir via UPSERT', () => {
    db = initDatabase(dbPath);

    const initialPath = '/home/user/project/.worktrees/feature-branch';
    const updatedPath = '/home/user/project/.worktrees/another-branch';

    // Insert with initial working_dir
    db.prepare(`
      INSERT INTO sessions (
        name, project, last_event, last_activity, created_at, updated_at,
        status, status_source, attention_reason, last_status_change, owner_id, working_dir
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('test-session', 'test-project', 'test-event', Date.now(), Date.now(), Date.now(),
           'idle', 'hook', null, Date.now(), 'test-user', initialPath);

    // Update with new working_dir
    db.prepare(`
      INSERT INTO sessions (
        name, project, last_event, last_activity, created_at, updated_at,
        status, status_source, attention_reason, last_status_change, owner_id, working_dir
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        working_dir = excluded.working_dir,
        last_event = excluded.last_event,
        last_activity = excluded.last_activity,
        updated_at = excluded.updated_at
    `).run('test-session', 'test-project', 'test-event-2', Date.now(), Date.now(), Date.now(),
           'idle', 'hook', null, Date.now(), 'test-user', updatedPath);

    const result = db.prepare('SELECT working_dir FROM sessions WHERE name = ?').get('test-session');
    expect((result as any).working_dir).toBe(updatedPath);
  });

  it('should migrate existing database to v20', () => {
    // Create a v19 database first
    db = new Database(dbPath);

    // Create v19 schema (without working_dir)
    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE sessions (
        name TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        last_event TEXT,
        last_activity INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT,
        status_source TEXT,
        attention_reason TEXT,
        last_status_change INTEGER,
        owner_id TEXT
      )
    `);

    db.prepare(`
      INSERT INTO schema_version (version, applied_at) VALUES (19, ?)
    `).run(Date.now());

    db.close();

    // Now run migration
    db = initDatabase(dbPath);

    // Verify schema version (migrates through to the latest)
    const version = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
    expect((version as any).version).toBe(SCHEMA_VERSION);

    // Verify working_dir column exists
    const columns = db.prepare(`
      SELECT name FROM pragma_table_info('sessions')
    `).all();

    const columnNames = columns.map((col: any) => col.name);
    expect(columnNames).toContain('working_dir');
  });

  it('should preserve existing data during migration', () => {
    // Create a v19 database with data
    db = new Database(dbPath);

    db.exec(`
      CREATE TABLE schema_version (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE sessions (
        name TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        last_event TEXT,
        last_activity INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        status TEXT,
        status_source TEXT,
        attention_reason TEXT,
        last_status_change INTEGER,
        owner_id TEXT
      )
    `);

    const now = Date.now();
    db.exec(`
      INSERT INTO schema_version (version, applied_at) VALUES (19, ${now})
    `);

    db.exec(`
      INSERT INTO sessions (
        name, project, last_event, last_activity, created_at, updated_at,
        status, status_source, attention_reason, last_status_change, owner_id
      ) VALUES (
        'existing-session', 'test-project', 'test-event', ${now}, ${now}, ${now},
        'idle', 'hook', NULL, ${now}, 'test-user'
      )
    `);

    db.close();

    // Run migration
    db = initDatabase(dbPath);

    // Verify data is preserved
    const session = db.prepare('SELECT * FROM sessions WHERE name = ?').get('existing-session');
    expect(session).toBeDefined();
    expect((session as any).name).toBe('existing-session');
    expect((session as any).project).toBe('test-project');
    expect((session as any).working_dir).toBeNull();
  });
});
