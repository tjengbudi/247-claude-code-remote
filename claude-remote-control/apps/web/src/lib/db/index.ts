import { homedir } from 'os';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, resolve, join } from 'path';
import * as schema from './schema';

// Database file location: WEB_DB_PATH env (Docker) or ~/.247/data/web.db (native/dev)
// Env-first with native fallback - NOT hard-coded (Docker volume wiring depends on env)
// homedir() (not literal '~') so the fallback resolves even when HOME is unset.
const DB_PATH = process.env.WEB_DB_PATH ?? resolve(homedir(), '.247', 'data', 'web.db');

// Lazy initialization to avoid errors during build when env vars aren't available
let _db: BetterSQLite3Database<typeof schema> | null = null;

// Resolve the drizzle migrations folder. Next.js `output: 'standalone'` does not
// guarantee cwd === apps/web, so probe known layouts and fail closed if none exist.
// Only accept a folder whose _journal.json declares the sqlite dialect — the repo
// also ships a postgres `drizzle-pg-archive`, and a stray pg journal fed to the
// sqlite migrator would fail confusingly.
function resolveMigrationsFolder(): string {
  const candidates = [
    resolve(process.cwd(), 'drizzle'),
    resolve(process.cwd(), 'apps/web/drizzle'),
    resolve(__dirname, '../../../drizzle'),
  ];
  for (const candidate of candidates) {
    const journalPath = join(candidate, 'meta', '_journal.json');
    if (!existsSync(journalPath)) continue;
    try {
      const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
      if (journal.dialect === 'sqlite') {
        return candidate;
      }
    } catch {
      // unreadable/malformed journal — skip this candidate
    }
  }
  throw new Error(
    `[web.db] sqlite migrations folder not found; looked in: ${candidates.join(', ')}`
  );
}

export function getDb() {
  if (!_db) {
    // Ensure data directory exists before opening DB (AC4 fail-closed)
    const dir = dirname(DB_PATH);
    try {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    } catch (e) {
      throw new Error(`[web.db] cannot create data dir ${dir}: ${(e as Error).message}`);
    }

    // Open database (creates if doesn't exist)
    let sqlite: Database.Database;
    try {
      sqlite = new Database(DB_PATH);
    } catch (e) {
      throw new Error(`[web.db] cannot open ${DB_PATH}: ${(e as Error).message}`);
    }

    // Enable WAL mode for better concurrent performance (mirrors agent).
    // pragma returns the mode actually applied: a network FS (NFS/SMB) can
    // silently refuse WAL and fall back, which risks corruption — warn loudly
    // rather than degrade silently.
    const journalMode = sqlite.pragma('journal_mode = WAL', { simple: true });
    if (journalMode !== 'wal') {
      console.warn(
        `[web.db] WAL not enabled (got '${journalMode}') for ${DB_PATH} — ` +
          `the path may be on a network filesystem unsupported by WAL`
      );
    }
    // WAL serializes writers via a lock; without a busy_timeout a second writer
    // (e.g. a second instance, or concurrent migrate() on the shared volume DB)
    // throws SQLITE_BUSY immediately instead of waiting.
    sqlite.pragma('busy_timeout = 5000');

    const candidate = drizzle(sqlite, { schema });

    // Guard the "pre-populated but unbookmarked" case: if app tables already
    // exist but drizzle has no migration bookkeeping (__drizzle_migrations
    // missing/empty), migrate() re-runs CREATE TABLE and dies with an opaque
    // "table already exists". This happens with a DB bootstrapped by db:push or
    // a manual/legacy file. Fail closed with an actionable message instead.
    try {
      const appTableExists = sqlite
        .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='user' LIMIT 1`)
        .get();
      if (appTableExists) {
        const bookkeeping = sqlite
          .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations' LIMIT 1`)
          .get();
        const migrationCount = bookkeeping
          ? (sqlite.prepare(`SELECT count(*) AS n FROM __drizzle_migrations`).get() as { n: number }).n
          : 0;
        if (migrationCount === 0) {
          sqlite.close();
          throw new Error(
            `[web.db] ${DB_PATH} has tables but no drizzle migration history — ` +
              `it was likely created by db:push or a legacy/manual bootstrap. ` +
              `Back up and remove the file (or restore one created by this app) so migrations can run cleanly.`
          );
        }
      }
    } catch (e) {
      // Re-throw our own actionable error; wrap any unexpected probe failure.
      if (e instanceof Error && e.message.startsWith('[web.db]')) throw e;
      sqlite.close();
      throw new Error(`[web.db] migration precheck failed for ${DB_PATH}: ${(e as Error).message}`);
    }

    // Apply migrations on init (AC5 - fresh web.db has no tables otherwise).
    // migrate() is idempotent - records applied migrations in __drizzle_migrations.
    // Run with foreign_keys OFF: SQLite's recommended posture for migrations is
    // FK enforcement disabled (table-rebuild migrations toggle FKs internally),
    // and better-sqlite3 defaults it OFF anyway. Assign _db only AFTER migrate()
    // succeeds: a half-initialized connection with no tables must not be cached,
    // or every later getDb() returns a broken db.
    try {
      migrate(candidate, { migrationsFolder: resolveMigrationsFolder() });
    } catch (e) {
      sqlite.close();
      throw new Error(`[web.db] migration failed for ${DB_PATH}: ${(e as Error).message}`);
    }

    // Enable foreign key enforcement AFTER migrations (AC5 - better-sqlite3
    // defaults OFF; the session.userId → user.id FK is only enforced with this on).
    sqlite.pragma('foreign_keys = ON');

    _db = candidate;
  }
  return _db;
}

// For backwards compatibility - will throw at runtime if env vars missing
export const db = new Proxy({} as BetterSQLite3Database<typeof schema>, {
  get(_target, prop) {
    return getDb()[prop as keyof BetterSQLite3Database<typeof schema>];
  },
});

export * from './schema';
