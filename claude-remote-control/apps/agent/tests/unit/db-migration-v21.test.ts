/**
 * Tests for database migration v21 (description column)
 * Human-readable session label shown in place of the technical tmux name.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { initDatabase } from '../../src/db/index.js';
import { SCHEMA_VERSION } from '../../src/db/schema.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('Database Migration v21 - description column', () => {
  let db: Database.Database;
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-db-test-'));
    dbPath = path.join(tempDir, 'test.db');
  });

  afterEach(() => {
    if (db) {
      db.close();
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should have schema version at or beyond 21', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(21);
  });

  it('should add description column to sessions table', () => {
    db = initDatabase(dbPath);

    const columns = db.prepare(`SELECT name FROM pragma_table_info('sessions')`).all();
    const columnNames = columns.map((col: any) => col.name);
    expect(columnNames).toContain('description');
  });

  it('should allow NULL values for description', () => {
    db = initDatabase(dbPath);

    db.prepare(`
      INSERT INTO sessions (
        name, project, last_event, last_activity, created_at, updated_at,
        status, status_source, attention_reason, last_status_change, owner_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('test-session', 'test-project', 'test-event', Date.now(), Date.now(), Date.now(),
           'idle', 'hook', null, Date.now(), 'test-user');

    const result = db.prepare('SELECT description FROM sessions WHERE name = ?').get('test-session');
    expect(result).toBeDefined();
    expect((result as any).description).toBeNull();
  });

  it('should store description when provided', () => {
    db = initDatabase(dbPath);

    const label = 'Fix login bug';
    db.prepare(`
      INSERT INTO sessions (
        name, project, last_event, last_activity, created_at, updated_at,
        status, status_source, attention_reason, last_status_change, owner_id, description
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('test-session', 'test-project', 'test-event', Date.now(), Date.now(), Date.now(),
           'idle', 'hook', null, Date.now(), 'test-user', label);

    const result = db.prepare('SELECT description FROM sessions WHERE name = ?').get('test-session');
    expect((result as any).description).toBe(label);
  });

  it('should migrate an existing v20 database to the latest and preserve data', () => {
    // Create a v20 database (has working_dir but no description) with data.
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
        owner_id TEXT,
        working_dir TEXT
      )
    `);

    const now = Date.now();
    db.exec(`INSERT INTO schema_version (version, applied_at) VALUES (20, ${now})`);
    db.exec(`
      INSERT INTO sessions (
        name, project, last_event, last_activity, created_at, updated_at,
        status, status_source, attention_reason, last_status_change, owner_id, working_dir
      ) VALUES (
        'existing-session', 'test-project', 'test-event', ${now}, ${now}, ${now},
        'idle', 'hook', NULL, ${now}, 'test-user', NULL
      )
    `);

    db.close();

    // Run migration
    db = initDatabase(dbPath);

    const version = db
      .prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1')
      .get();
    expect((version as any).version).toBe(SCHEMA_VERSION);

    const columns = db.prepare(`SELECT name FROM pragma_table_info('sessions')`).all();
    const columnNames = columns.map((col: any) => col.name);
    expect(columnNames).toContain('description');

    const session = db.prepare('SELECT * FROM sessions WHERE name = ?').get('existing-session');
    expect((session as any).name).toBe('existing-session');
    expect((session as any).project).toBe('test-project');
    expect((session as any).description).toBeNull();
  });

  it('is idempotent when the column already exists', () => {
    db = initDatabase(dbPath);
    db.close();
    // Re-open — initDatabase should be a no-op migration-wise and not throw.
    db = initDatabase(dbPath);
    const columns = db.prepare(`SELECT name FROM pragma_table_info('sessions')`).all();
    const columnNames = columns.map((col: any) => col.name);
    expect(columnNames).toContain('description');
  });
});
