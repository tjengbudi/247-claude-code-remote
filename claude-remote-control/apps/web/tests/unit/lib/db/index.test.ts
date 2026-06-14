/**
 * Database Driver Tests
 *
 * Validates the better-sqlite3 driver integration:
 * - getDb() returns working drizzle instance
 * - WEB_DB_PATH env var is honored
 * - Native fallback path works (~/.247/data/web.db)
 * - Unwritable paths throw clear errors (AC4 fail-closed)
 * - Foreign key pragma is enforced (AC5)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';

describe('Database Driver (better-sqlite3)', () => {
  let tempDir: string;
  let originalEnv: { WEB_DB_PATH?: string; HOME?: string };

  beforeEach(() => {
    // Create temp directory for test DB files
    tempDir = mkdtempSync(join(tmpdir(), 'web-db-test-'));

    // Save original env
    originalEnv = {
      WEB_DB_PATH: process.env.WEB_DB_PATH,
      HOME: process.env.HOME,
    };

    // Reset module cache to clear lazy singleton
    vi.resetModules();
  });

  afterEach(() => {
    // Restore original env
    if (originalEnv.WEB_DB_PATH !== undefined) {
      process.env.WEB_DB_PATH = originalEnv.WEB_DB_PATH;
    } else {
      delete process.env.WEB_DB_PATH;
    }

    if (originalEnv.HOME !== undefined) {
      process.env.HOME = originalEnv.HOME;
    } else {
      delete process.env.HOME;
    }

    // Clean up temp directory
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }

    vi.resetModules();
  });

  describe('getDb()', () => {
    it('returns a working drizzle instance', async () => {
      const dbPath = join(tempDir, 'test.db');
      process.env.WEB_DB_PATH = dbPath;

      const { getDb } = await import('@/lib/db');
      const db = getDb();

      expect(db).toBeDefined();
      expect(typeof db.select).toBe('function');
      expect(typeof db.insert).toBe('function');
    });

    it('insert→select round-trips on agent_connection', async () => {
      const dbPath = join(tempDir, 'test.db');
      process.env.WEB_DB_PATH = dbPath;

      const { getDb, agentConnection } = await import('@/lib/db');
      const { eq } = await import('drizzle-orm');

      const db = getDb();
      const testId = 'test-connection-123';
      const testUserId = 'test-user-456';

      // Insert
      await db.insert(agentConnection).values({
        id: testId,
        userId: testUserId,
        url: 'http://localhost:3000',
        name: 'Test Connection',
        machineId: 'test-machine-789',
        method: 'tailscale',
        color: '#ff0000',
      });

      // Select
      const [result] = await db
        .select()
        .from(agentConnection)
        .where(eq(agentConnection.id, testId));

      expect(result).toBeDefined();
      expect(result.id).toBe(testId);
      expect(result.userId).toBe(testUserId);
      expect(result.name).toBe('Test Connection');
    });
  });

  describe('WEB_DB_PATH resolution', () => {
    it('honors WEB_DB_PATH when set', async () => {
      const dbPath = join(tempDir, 'custom-path.db');
      process.env.WEB_DB_PATH = dbPath;

      const { getDb } = await import('@/lib/db');
      const db = getDb();

      // Verify DB is usable
      expect(db).toBeDefined();

      // Verify file was created at specified path
      const { existsSync } = await import('fs');
      expect(existsSync(dbPath)).toBe(true);
    });

    it('falls back to ~/.247/data/web.db when WEB_DB_PATH unset', async () => {
      delete process.env.WEB_DB_PATH;
      process.env.HOME = tempDir;

      const { getDb } = await import('@/lib/db');
      const db = getDb();

      // Verify DB is usable
      expect(db).toBeDefined();

      // Verify fallback path was used
      const { existsSync } = await import('fs');
      const fallbackPath = join(tempDir, '.247', 'data', 'web.db');
      expect(existsSync(fallbackPath)).toBe(true);
    });
  });

  describe('Fail-closed behavior (AC4)', () => {
    it('throws clear error for unwritable path', async () => {
      // Put the DB under a path whose parent is a regular FILE. mkdirSync then
      // fails with ENOTDIR even when running as root (a bare nonexistent path
      // under / is creatable by root, so it would not reliably throw).
      const blocker = join(tempDir, 'not-a-dir');
      writeFileSync(blocker, 'x');
      const invalidPath = join(blocker, 'web.db');
      process.env.WEB_DB_PATH = invalidPath;

      // Reset modules to force re-import
      vi.resetModules();

      // Expect error when importing the module
      await expect(async () => {
        const { getDb } = await import('@/lib/db');
        getDb();
      }).rejects.toThrow(/cannot create data dir|cannot open/);
    });

    it('error message includes resolved path', async () => {
      const blocker = join(tempDir, 'not-a-dir');
      writeFileSync(blocker, 'x');
      const invalidPath = join(blocker, 'web.db');
      process.env.WEB_DB_PATH = invalidPath;

      vi.resetModules();

      try {
        const { getDb } = await import('@/lib/db');
        getDb();
        expect.fail('Expected error to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        // Error should mention the path
        expect(message).toMatch(/web\.db/i);
      }
    });
  });

  describe('Foreign key pragma (AC5)', () => {
    it('enforces session→user foreign key (pragma is ON)', async () => {
      const dbPath = join(tempDir, 'fk-test.db');
      process.env.WEB_DB_PATH = dbPath;

      const { getDb, session } = await import('@/lib/db');
      const db = getDb();

      // Inserting a session whose user_id has no matching user row must be
      // rejected. This only happens when `PRAGMA foreign_keys = ON` is set on
      // the live connection (better-sqlite3 defaults it OFF). Asserting the
      // pragma on a *separate* fresh connection would read 0 and prove nothing.
      await expect(
        db.insert(session).values({
          id: 'sess-1',
          userId: 'nonexistent-user',
          tokenHash: 'hash-1',
          expiresAt: new Date(Date.now() + 60_000),
        })
      ).rejects.toThrow(/FOREIGN KEY/i);
    });
  });

  describe('user_settings round-trip (AC3)', () => {
    /**
     * user_settings has NO API route or app consumer in apps/web/src today
     * (only schema.ts references it). Route-level E2E is impossible, so this
     * DB-layer integration test is the correct substitute. This is a
     * pre-existing condition, NOT an Epic 1 regression.
     */
    it('inserts, reads, and updates a setting row', async () => {
      const dbPath = join(tempDir, 'settings-test.db');
      process.env.WEB_DB_PATH = dbPath;

      const { getDb, userSettings } = await import('@/lib/db');
      const { eq } = await import('drizzle-orm');
      const db = getDb();

      // Insert
      await db.insert(userSettings).values({
        id: 'setting-1',
        userId: 'user-1',
        key: 'theme',
        value: 'dark',
      });

      // Read
      const [row] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.id, 'setting-1'));
      expect(row).toBeDefined();
      expect(row.key).toBe('theme');
      expect(row.value).toBe('dark');

      // Update
      await db
        .update(userSettings)
        .set({ value: 'light', updatedAt: new Date() })
        .where(eq(userSettings.id, 'setting-1'));

      const [updated] = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.id, 'setting-1'));
      expect(updated.value).toBe('light');
    });

    it('rejects duplicate (userId, key) via UNIQUE index', async () => {
      const dbPath = join(tempDir, 'settings-unique-test.db');
      process.env.WEB_DB_PATH = dbPath;

      const { getDb, userSettings } = await import('@/lib/db');
      const db = getDb();

      await db.insert(userSettings).values({
        id: 'setting-a',
        userId: 'user-1',
        key: 'lang',
        value: 'en',
      });

      // Second insert with same (userId, key) must fail
      await expect(
        db.insert(userSettings).values({
          id: 'setting-b',
          userId: 'user-1',
          key: 'lang',
          value: 'fr',
        })
      ).rejects.toThrow(/UNIQUE/i);
    });
  });

  describe('Migration safety', () => {
    it('tables exist after getDb() on fresh file', async () => {
      const dbPath = join(tempDir, 'migration-test.db');
      process.env.WEB_DB_PATH = dbPath;

      const { getDb, user, session } = await import('@/lib/db');
      const db = getDb();

      // Verify we can query user and session tables (proves migrations ran)
      const users = await db.select().from(user);
      const sessions = await db.select().from(session);

      expect(Array.isArray(users)).toBe(true);
      expect(Array.isArray(sessions)).toBe(true);
    });

    it('fails closed with actionable error on a pre-populated, unbookmarked DB', async () => {
      // Simulate a DB created by db:push / manual bootstrap: app table exists but
      // there is no __drizzle_migrations history. migrate() would otherwise die
      // with an opaque "table already exists"; we expect a clear actionable error.
      const dbPath = join(tempDir, 'prepopulated.db');
      const Database = (await import('better-sqlite3')).default;
      const seed = new Database(dbPath);
      seed.exec(`CREATE TABLE user (id text PRIMARY KEY, username text, email text)`);
      seed.close();

      process.env.WEB_DB_PATH = dbPath;
      vi.resetModules();

      await expect(async () => {
        const { getDb } = await import('@/lib/db');
        getDb();
      }).rejects.toThrow(/no drizzle migration history/i);
    });

    it('reopens an app-created DB without error (bookkeeping present)', async () => {
      const dbPath = join(tempDir, 'reopen.db');
      process.env.WEB_DB_PATH = dbPath;

      // First open creates tables + __drizzle_migrations bookkeeping.
      const first = await import('@/lib/db');
      first.getDb();

      // Second open against the same file must succeed (migrate is idempotent,
      // and the precheck sees migration history so it does not fail closed).
      vi.resetModules();
      const second = await import('@/lib/db');
      const db = second.getDb();
      const users = await db.select().from(second.user);
      expect(Array.isArray(users)).toBe(true);
    });
  });
});
