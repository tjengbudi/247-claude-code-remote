import { homedir } from 'os';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdirSync } from 'fs';
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
function resolveMigrationsFolder(): string {
  const candidates = [
    resolve(process.cwd(), 'drizzle'),
    resolve(process.cwd(), 'apps/web/drizzle'),
    resolve(__dirname, '../../../drizzle'),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'meta', '_journal.json'))) {
      return candidate;
    }
  }
  throw new Error(
    `[web.db] migrations folder not found; looked in: ${candidates.join(', ')}`
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
    // Enable foreign key enforcement (AC5 - better-sqlite3 defaults OFF)
    sqlite.pragma('foreign_keys = ON');

    const candidate = drizzle(sqlite, { schema });

    // Apply migrations on init (AC5 - fresh web.db has no tables otherwise).
    // migrate() is idempotent - records applied migrations in __drizzle_migrations.
    // Assign _db only AFTER migrate() succeeds: a half-initialized connection with
    // no tables must not be cached, or every later getDb() returns a broken db.
    try {
      migrate(candidate, { migrationsFolder: resolveMigrationsFolder() });
    } catch (e) {
      sqlite.close();
      throw new Error(`[web.db] migration failed for ${DB_PATH}: ${(e as Error).message}`);
    }

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
