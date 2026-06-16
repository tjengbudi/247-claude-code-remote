/**
 * Unit tests for the token coverage check script (Story 3.4 AC1).
 *
 * Advisory check only - agent runtime fail-safe exists regardless.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import Database from 'better-sqlite3';

const TEST_DB_DIR = join(homedir(), '.247-test-coverage');
const TEST_DB_PATH = join(TEST_DB_DIR, 'web.db');

// Resolve the script path relative to this test file so the suite runs on any
// machine / CI clone, not just one developer's absolute path.
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = resolve(__dirname, '../../scripts/check-token-coverage.ts');

describe('Token Coverage Check (Advisory)', () => {
  beforeEach(() => {
    // Clean up test DB
    if (existsSync(TEST_DB_PATH)) {
      const fs = require('fs');
      fs.unlinkSync(TEST_DB_PATH);
    }
    mkdirSync(TEST_DB_DIR, { recursive: true });
  });

  afterEach(() => {
    // Clean up
    if (existsSync(TEST_DB_PATH)) {
      const fs = require('fs');
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  it('returns 0 (PASS) when no connections exist', () => {
    // Create empty database with schema
    const db = new Database(TEST_DB_PATH);
    db.exec(`
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
    `);
    db.close();

    // Run check
    const result = require('child_process').execSync(
      `tsx ${SCRIPT_PATH}`,
      {
        env: { ...process.env, WEB_DB_PATH: TEST_DB_PATH },
        encoding: 'utf-8'
      }
    );

    expect(result).toContain('PASS');
    expect(result).toContain('Total connections: 0');
  });

  it('returns 0 (PASS) when all connections have tokens', () => {
    // Create database with tokenized connections
    const db = new Database(TEST_DB_PATH);
    db.exec(`
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
    `);
    db.exec(`
      INSERT INTO agent_connection (id, user_id, url, name, token)
      VALUES ('conn-1', 'user-1', 'http://localhost:4678', 'Test Agent 1', 'token-abc-123')
    `);
    db.exec(`
      INSERT INTO agent_connection (id, user_id, url, name, token)
      VALUES ('conn-2', 'user-1', 'http://localhost:4679', 'Test Agent 2', 'token-xyz-456')
    `);
    db.close();

    // Run check
    const result = require('child_process').execSync(
      `tsx ${SCRIPT_PATH}`,
      {
        env: { ...process.env, WEB_DB_PATH: TEST_DB_PATH },
        encoding: 'utf-8'
      }
    );

    expect(result).toContain('PASS');
    expect(result).toContain('Total connections: 2');
  });

  it('returns 1 (FAIL) when connections have no tokens', () => {
    // Create database with tokenless connections
    const db = new Database(TEST_DB_PATH);
    db.exec(`
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
    `);
    db.exec(`
      INSERT INTO agent_connection (id, user_id, url, name, token)
      VALUES ('conn-1', 'user-1', 'http://localhost:4678', 'Test Agent 1', 'token-abc-123')
    `);
    db.exec(`
      INSERT INTO agent_connection (id, user_id, url, name, token)
      VALUES ('conn-2', 'user-1', 'http://localhost:4679', 'Test Agent 2', NULL)
    `);
    db.close();

    // Run check (should exit with code 1)
    try {
      require('child_process').execSync(
        `tsx ${SCRIPT_PATH}`,
        {
          env: { ...process.env, WEB_DB_PATH: TEST_DB_PATH },
          encoding: 'utf-8'
        }
      );
      expect.fail('Should have exited with code 1');
    } catch (error: any) {
      expect(error.status).toBe(1);
      expect(error.stdout).toContain('FAIL');
      expect(error.stdout).toContain('1 of 2');
    }
  });

  it('returns 1 (FAIL) when a token is whitespace-only', () => {
    // Whitespace-only tokens are effectively tokenless and must not pass.
    const db = new Database(TEST_DB_PATH);
    db.exec(`
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
    `);
    db.exec(`
      INSERT INTO agent_connection (id, user_id, url, name, token)
      VALUES ('conn-1', 'user-1', 'http://localhost:4678', 'Test Agent 1', '   ')
    `);
    db.close();

    try {
      require('child_process').execSync(
        `tsx ${SCRIPT_PATH}`,
        {
          env: { ...process.env, WEB_DB_PATH: TEST_DB_PATH },
          encoding: 'utf-8'
        }
      );
      expect.fail('Should have exited with code 1');
    } catch (error: any) {
      expect(error.status).toBe(1);
      expect(error.stdout).toContain('FAIL');
      expect(error.stdout).toContain('1 of 1');
    }
  });

  it('returns 0 (PASS) when database does not exist', () => {
    // Run check without creating database
    const result = require('child_process').execSync(
      `tsx ${SCRIPT_PATH}`,
      {
        env: { ...process.env, WEB_DB_PATH: '/nonexistent/web.db' },
        encoding: 'utf-8'
      }
    );

    expect(result).toContain('PASS');
    expect(result).toContain('0 connection');
  });
});
