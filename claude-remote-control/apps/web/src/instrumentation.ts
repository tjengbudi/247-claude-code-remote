import { randomUUID } from 'crypto'
import { ownerExists, hashPassword, getWebAuthSecret } from '@/lib/auth'
import { db, user } from '@/lib/db'
import { createLogger } from '@/lib/logger'

const logger = createLogger('Seed')

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

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
