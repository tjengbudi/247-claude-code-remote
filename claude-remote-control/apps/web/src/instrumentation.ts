export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  // Node-only deps (argon2 native binary, better-sqlite3, fs/path) are imported
  // dynamically AFTER the runtime guard. A top-level static import pulls them into
  // the Edge Instrumentation bundle too, where `@node-rs/argon2` resolves to its
  // export-less `browser.js` and `fs`/`process.cwd` are unsupported — that breaks
  // both `next dev` (500 on every auth route) and `next build` (compile failure).
  const { randomUUID } = await import('crypto')
  const { ownerExists, hashPassword, getWebAuthSecret } = await import('@/lib/auth')
  const { db, user } = await import('@/lib/db')
  const { createLogger } = await import('@/lib/logger')
  const logger = createLogger('Seed')

  // Fail fast at boot if the signing secret is missing/weak. Without this the
  // container comes up green and only 500s on the first auth request, so an
  // operator who forgets WEB_AUTH_SECRET ships a silently-broken deploy.
  await getWebAuthSecret()

  // Dev-only owner auto-seed. Allowlist on 'development' (not a `=== 'production'`
  // denylist): an unset or non-standard NODE_ENV (e.g. 'staging', bare
  // `node server.js`) must NEVER seed an owner with known credentials, which
  // would be an instant auth bypass on a fresh reachable DB.
  if (process.env.NODE_ENV !== 'development') return

  try {
    if (await ownerExists()) return

    // `||` not `??`: a declared-but-blank env var ('') must fall back to the
    // default, not seed an empty username/password.
    const username = process.env.DEV_SEED_USERNAME || 'dev'
    const password = process.env.DEV_SEED_PASSWORD || 'dev-password'
    const passwordHash = await hashPassword(password)

    await db.insert(user).values({
      id: randomUUID(),
      username,
      email: null,
      passwordHash,
    }).onConflictDoNothing({ target: user.username })

    logger.info('Dev owner seeded', { username })
  } catch (error) {
    logger.error('Dev seed failed (non-fatal)', error)
  }
}
