import { NextResponse } from 'next/server';
import { db, agentConnection } from '@/lib/db';
import { eq, count, sql } from 'drizzle-orm';
import { requireUser, AuthError } from '@/lib/auth';
import { computeCoverageVerdict } from '@/lib/coverage-verdict';

export async function GET() {
  try {
    const { user } = await requireUser();

    // Two count queries scoped to the authenticated user (Trap #5).
    // Uses the app's own `db` accessor — NOT a second Database() (Trap #1).
    const [totalRow] = await db
      .select({ n: count() })
      .from(agentConnection)
      .where(eq(agentConnection.userId, user.id));

    const [tokenlessRow] = await db
      .select({ n: count() })
      .from(agentConnection)
      .where(
        sql`${agentConnection.userId} = ${user.id} AND (${agentConnection.token} IS NULL OR TRIM(${agentConnection.token}) = '')`,
      );

    const verdict = computeCoverageVerdict(totalRow.n, tokenlessRow.n);

    return NextResponse.json(verdict, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    // Discriminable 401 before DB-error (Trap #3, AC1).
    if (error instanceof AuthError) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: error.status, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    // Degraded-DB → structured verdict (AC4, Trap #7).
    // NEVER forward (e as Error).message — getDb() embeds ${DB_PATH} in its
    // error text (db/index.ts:54,62,102,112,126). Synthesize the operator msg.
    return NextResponse.json(
      {
        status: 'error',
        message:
          'Cannot read the connection database. Check WEB_DB_PATH, volume permissions, and database integrity.',
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
