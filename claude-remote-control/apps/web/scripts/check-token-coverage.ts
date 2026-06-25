#!/usr/bin/env tsx
/**
 * Pre-flip token-coverage gate (Story 3.4, AC1).
 *
 * Counts `agent_connection` rows with missing/empty token and advises the
 * operator to re-pair any tokenless connections before flipping
 * AGENT_TOKEN_ENFORCE to ON.
 *
 * Advisory only: this script does NOT block the agent boot path. Runtime
 * fail-safes (shouldAcceptUpgrade per-connection policy) remain in effect
 * regardless of the script's verdict.
 *
 * Usage:
 *   pnpm --filter 247-web db:check-token-coverage
 *
 * Exit codes:
 *   0 — all rows hold a non-null, non-empty token (PASS)
 *   1 — one or more tokenless rows detected (re-pair advised)
 *   2 — cannot read the DB file
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';
import Database from 'better-sqlite3';

// Default DB location: WEB_DB_PATH env (Docker) or ~/.247/data/web.db (native/dev).
// Resolved lazily as the `run()` default so tests can pass an explicit path in-process
// (no subprocess spawn) without depending on module-load-time env.
function defaultDbPath(): string {
  return process.env.WEB_DB_PATH ?? resolve(homedir(), '.247', 'data', 'web.db');
}

export function run(dbPath: string = defaultDbPath()): number {
  if (!existsSync(dbPath)) {
    console.log(`[check-token-coverage] DB not found at ${dbPath}`);
    console.log(`  A fresh self-host web.db has no connections yet — nothing to check.`);
    console.log(`  After pairing your first connection, re-run this script before flipping enforcement.`);
    console.log(`\nPASS — 0 connections. No tokenless connections to worry about.`);
    return 0;
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (e) {
    console.error(`[check-token-coverage] cannot open ${dbPath}: ${(e as Error).message}`);
    return 2;
  }

  try {
    // Table may not exist yet (fresh install before any migration ran)
    const hasTable = db
      .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_connection' LIMIT 1`)
      .get();
    if (!hasTable) {
      console.log(`[check-token-coverage] agent_connection table does not exist in ${dbPath}`);
      console.log(`  Run migrations first (pnpm --filter 247-web db:migrate) then re-pair connections.`);
      console.log(`\nPASS — no agent_connection table yet. Nothing to check.`);
      return 0;
    }

    const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM agent_connection`).get() as { n: number };
    const total = totalRow.n;

    // NULL or blank covers un-provisioned rows, accidental empty writes, and
    // whitespace-only tokens (TRIM) — none of which can match a real presented
    // token at the agent, so all count as tokenless.
    const tokenlessRow = db
      .prepare(`SELECT COUNT(*) AS n FROM agent_connection WHERE token IS NULL OR TRIM(token) = ''`)
      .get() as { n: number };
    const tokenless = tokenlessRow.n;

    console.log(`[check-token-coverage] ${dbPath}`);
    console.log(`  Total connections: ${total}`);
    console.log(`  Tokenless:         ${tokenless}`);

    if (total === 0) {
      console.log(`\nPASS — no connections yet. After your first pairing, re-run this script.`);
      return 0;
    }

    if (tokenless === 0) {
      console.log(`\nPASS — every connection holds a token. Safe to flip AGENT_TOKEN_ENFORCE to ON.`);
      return 0;
    }

    console.log(
      `\nFAIL — ${tokenless} of ${total} connection(s) hold no token.`
    );
    console.log(`  Re-pair those connections before flipping enforcement; re-pairing provisions`);
    console.log(`  the token onto the agent_connection row (Story 3.2).`);
    console.log(`  After re-pairing, re-run this script to confirm coverage.`);
    return 1;
  } catch (e) {
    // A failing query (e.g. schema mismatch) should exit with the documented
    // code 2, not an unstructured stack trace.
    console.error(`[check-token-coverage] query failed on ${dbPath}: ${(e as Error).message}`);
    return 2;
  } finally {
    db.close();
  }
}

// Only exit the process when invoked directly as a CLI (tsx scripts/check-token-coverage.ts).
// When imported by tests, run() is called in-process and must NOT terminate the test runner.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(run());
}
