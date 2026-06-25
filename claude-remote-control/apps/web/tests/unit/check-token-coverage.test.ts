/**
 * Unit tests for the token coverage check script (Story 3.4 AC1).
 *
 * Advisory check only - agent runtime fail-safe exists regardless.
 *
 * These tests call `run()` IN-PROCESS (no `tsx` subprocess spawn). The earlier
 * version shelled out via execSync('tsx ...') 5×; each cold `tsx` start (~400ms)
 * became flaky timeouts under Vitest's parallel worker load. run() is pure and
 * returns the exit code, so we assert it directly and capture console output.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import { run } from '../../scripts/check-token-coverage';

const TEST_DB_DIR = join(homedir(), '.247-test-coverage');
const TEST_DB_PATH = join(TEST_DB_DIR, 'web.db');

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS agent_connection (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    machine_id TEXT,
    url TEXT NOT NULL,
    name TEXT NOT NULL,
    method TEXT DEFAULT 'tailscale',
    is_cloud INTEGER DEFAULT 0,
    cloud_agent_id TEXT,
    color TEXT,
    created_at INTEGER,
    updated_at INTEGER,
    token TEXT
  )
`;

describe('Token Coverage Check (Advisory)', () => {
  // Collects everything run() writes to stdout/stderr so assertions can match
  // the same strings the old execSync-based tests checked against `result`.
  let output: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Clean up test DB
    if (existsSync(TEST_DB_PATH)) {
      const fs = require('fs');
      fs.unlinkSync(TEST_DB_PATH);
    }
    mkdirSync(TEST_DB_DIR, { recursive: true });

    output = [];
    const capture = (...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    };
    logSpy = vi.spyOn(console, 'log').mockImplementation(capture);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(capture);
  });

  afterEach(() => {
    // Clean up
    if (existsSync(TEST_DB_PATH)) {
      const fs = require('fs');
      fs.unlinkSync(TEST_DB_PATH);
    }
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('returns 0 (PASS) when no connections exist', () => {
    // Create empty database with schema
    const db = new Database(TEST_DB_PATH);
    db.exec(CREATE_TABLE_SQL);
    db.close();

    const code = run(TEST_DB_PATH);

    expect(code).toBe(0);
    const stdout = output.join('\n');
    expect(stdout).toContain('PASS');
    expect(stdout).toContain('Total connections: 0');
  });

  it('returns 0 (PASS) when all connections have tokens', () => {
    // Create database with tokenized connections
    const db = new Database(TEST_DB_PATH);
    db.exec(CREATE_TABLE_SQL);
    db.exec(`
      INSERT INTO agent_connection (id, user_id, url, name, token)
      VALUES ('conn-1', 'user-1', 'http://localhost:4678', 'Test Agent 1', 'token-abc-123')
    `);
    db.exec(`
      INSERT INTO agent_connection (id, user_id, url, name, token)
      VALUES ('conn-2', 'user-1', 'http://localhost:4679', 'Test Agent 2', 'token-xyz-456')
    `);
    db.close();

    const code = run(TEST_DB_PATH);

    expect(code).toBe(0);
    const stdout = output.join('\n');
    expect(stdout).toContain('PASS');
    expect(stdout).toContain('Total connections: 2');
  });

  it('returns 1 (FAIL) when connections have no tokens', () => {
    // Create database with a tokenless connection
    const db = new Database(TEST_DB_PATH);
    db.exec(CREATE_TABLE_SQL);
    db.exec(`
      INSERT INTO agent_connection (id, user_id, url, name, token)
      VALUES ('conn-1', 'user-1', 'http://localhost:4678', 'Test Agent 1', 'token-abc-123')
    `);
    db.exec(`
      INSERT INTO agent_connection (id, user_id, url, name, token)
      VALUES ('conn-2', 'user-1', 'http://localhost:4679', 'Test Agent 2', NULL)
    `);
    db.close();

    const code = run(TEST_DB_PATH);

    expect(code).toBe(1);
    const stdout = output.join('\n');
    expect(stdout).toContain('FAIL');
    expect(stdout).toContain('1 of 2');
  });

  it('returns 1 (FAIL) when a token is whitespace-only', () => {
    // Whitespace-only tokens are effectively tokenless and must not pass.
    const db = new Database(TEST_DB_PATH);
    db.exec(CREATE_TABLE_SQL);
    db.exec(`
      INSERT INTO agent_connection (id, user_id, url, name, token)
      VALUES ('conn-1', 'user-1', 'http://localhost:4678', 'Test Agent 1', '   ')
    `);
    db.close();

    const code = run(TEST_DB_PATH);

    expect(code).toBe(1);
    const stdout = output.join('\n');
    expect(stdout).toContain('FAIL');
    expect(stdout).toContain('1 of 1');
  });

  it('returns 0 (PASS) when database does not exist', () => {
    // Run check against a path with no DB file.
    const code = run('/nonexistent/web.db');

    expect(code).toBe(0);
    const stdout = output.join('\n');
    expect(stdout).toContain('PASS');
    expect(stdout).toContain('0 connection');
  });
});
