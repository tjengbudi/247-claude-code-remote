// @vitest-environment node
/**
 * Dev auto-seed instrumentation tests (Story 4.5 AC1)
 *
 * Tests the register() function in instrumentation.ts which:
 *  - validates WEB_AUTH_SECRET at boot (fail-fast, all runtimes), and
 *  - seeds a dev owner only when NEXT_RUNTIME='nodejs' AND NODE_ENV='development'.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';

describe('instrumentation.register()', () => {
  let tempDir: string;

  // 64 hex chars: clears the bootstrap entropy bar (>=32 bytes, >=16 distinct).
  const STRONG_SECRET =
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'instrumentation-test-'));

    // Set up fresh DB for each test
    vi.stubEnv('WEB_DB_PATH', join(tempDir, 'web.db'));
    vi.stubEnv('HOME', tempDir);
    // register() now validates the signing secret at boot; supply a strong one
    // so tests focused on seeding don't trip the fail-fast guard.
    vi.stubEnv('WEB_AUTH_SECRET', STRONG_SECRET);

    // Reset module cache to get fresh imports
    vi.resetModules();

    // Boot the DB (runs migrations)
    const { getDb } = await import('@/lib/db');
    getDb();
  });

  afterEach(async () => {
    // Close DB connection
    try {
      const { db } = await import('@/lib/db');
      (db as unknown as { $client: { close: () => void } }).$client.close();
    } catch {
      // db may not have been initialized
    }

    // Clean up all env stubs
    vi.unstubAllEnvs();

    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it('skips seeding in production environment', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');

    const { register } = await import('@/instrumentation');
    await register();

    // Verify no user was created
    const { db } = await import('@/lib/db');
    const { user } = await import('@/lib/db/schema');
    const users = await db.select().from(user);

    expect(users).toHaveLength(0);
  });

  it('skips seeding in edge runtime', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_RUNTIME', 'edge');

    const { register } = await import('@/instrumentation');
    await register();

    // Verify no user was created
    const { db } = await import('@/lib/db');
    const { user } = await import('@/lib/db/schema');
    const users = await db.select().from(user);

    expect(users).toHaveLength(0);
  });

  it('seeds dev owner on first run in development', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');

    const { register } = await import('@/instrumentation');
    await register();

    // Verify dev owner was created with defaults
    const { db } = await import('@/lib/db');
    const { user } = await import('@/lib/db/schema');
    const users = await db.select().from(user);

    expect(users).toHaveLength(1);
    expect(users[0].username).toBe('dev');
    expect(users[0].passwordHash).toBeTruthy();
    expect(users[0].email).toBeNull();
  });

  it('seeds dev owner with custom credentials from env', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('DEV_SEED_USERNAME', 'custom-user');
    vi.stubEnv('DEV_SEED_PASSWORD', 'custom-password-123');

    const { register } = await import('@/instrumentation');
    await register();

    // Verify custom owner was created
    const { db } = await import('@/lib/db');
    const { user } = await import('@/lib/db/schema');
    const users = await db.select().from(user);

    expect(users).toHaveLength(1);
    expect(users[0].username).toBe('custom-user');
    expect(users[0].passwordHash).toBeTruthy();
  });

  it('is idempotent - does not create duplicate users on re-run', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');

    const { register } = await import('@/instrumentation');

    // First run
    await register();

    const { db } = await import('@/lib/db');
    const { user } = await import('@/lib/db/schema');
    let users = await db.select().from(user);
    expect(users).toHaveLength(1);

    // Second run (same module, should skip)
    await register();

    users = await db.select().from(user);
    expect(users).toHaveLength(1); // Still only one user
  });

  it('skips seeding if owner already exists', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');

    // Pre-create an owner
    const { db } = await import('@/lib/db');
    const { user } = await import('@/lib/db/schema');
    const { hashPassword } = await import('@/lib/auth');

    const existingHash = await hashPassword('existing-password');
    await db.insert(user).values({
      id: 'existing-user-id',
      username: 'existing-owner',
      email: null,
      passwordHash: existingHash,
    });

    // Run register() - should skip
    const { register } = await import('@/instrumentation');
    await register();

    // Verify only the pre-existing owner exists
    const users = await db.select().from(user);
    expect(users).toHaveLength(1);
    expect(users[0].username).toBe('existing-owner');
  });

  it('does NOT seed when NODE_ENV is unset (allowlist, not denylist)', async () => {
    // The guard allowlists 'development'. An unset NODE_ENV must not seed a
    // known-credential owner — that would be an auth bypass on a fresh DB.
    vi.stubEnv('NODE_ENV', undefined as unknown as string);
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');

    const { register } = await import('@/instrumentation');
    await register();

    const { db } = await import('@/lib/db');
    const { user } = await import('@/lib/db/schema');
    const users = await db.select().from(user);

    expect(users).toHaveLength(0);
  });

  it('does NOT seed when NODE_ENV is a non-standard value (e.g. staging)', async () => {
    vi.stubEnv('NODE_ENV', 'staging');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');

    const { register } = await import('@/instrumentation');
    await register();

    const { db } = await import('@/lib/db');
    const { user } = await import('@/lib/db/schema');
    const users = await db.select().from(user);

    expect(users).toHaveLength(0);
  });

  it('falls back to defaults when seed env vars are blank strings', async () => {
    // `||` (not `??`): a declared-but-empty env var must use the default,
    // never seed an empty username/password.
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('DEV_SEED_USERNAME', '');
    vi.stubEnv('DEV_SEED_PASSWORD', '');

    const { register } = await import('@/instrumentation');
    await register();

    const { db } = await import('@/lib/db');
    const { user } = await import('@/lib/db/schema');
    const users = await db.select().from(user);

    expect(users).toHaveLength(1);
    expect(users[0].username).toBe('dev');
    expect(users[0].passwordHash).toBeTruthy();
  });

  it('throws at boot when WEB_AUTH_SECRET is missing in production', async () => {
    // Fail-fast: a missing signing secret must surface at startup, not as a
    // runtime 500 on the first auth request.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('WEB_AUTH_SECRET', '');

    const { register } = await import('@/instrumentation');
    await expect(register()).rejects.toThrow(/WEB_AUTH_SECRET/);
  });

  it('skips secret validation and seeding outside the nodejs runtime', async () => {
    // No WEB_AUTH_SECRET, but edge runtime returns before validation — must not throw.
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    vi.stubEnv('WEB_AUTH_SECRET', '');

    const { register } = await import('@/instrumentation');
    await expect(register()).resolves.toBeUndefined();
  });
});
