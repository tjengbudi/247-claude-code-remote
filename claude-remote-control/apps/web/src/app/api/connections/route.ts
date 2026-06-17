import { NextResponse } from 'next/server';
import { db, agentConnection } from '@/lib/db';
import { eq } from 'drizzle-orm';
import { requireUser, AuthError } from '@/lib/auth';

export async function GET() {
  try {
    const { user } = await requireUser();

    const connections = await db
      .select()
      .from(agentConnection)
      .where(eq(agentConnection.userId, user.id));

    return NextResponse.json(connections);
  } catch (error) {
    // Option A: discriminable 401 before generic 500
    if (error instanceof AuthError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: error.status });
    }
    return NextResponse.json({ error: 'Failed to fetch connections' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { user } = await requireUser();

    const body = await req.json();
    const id = crypto.randomUUID();

    const [connection] = await db
      .insert(agentConnection)
      .values({
        id,
        userId: user.id,
        url: body.url,
        name: body.name,
        machineId: body.machineId,
        method: body.method || 'tailscale',
        color: body.color,
        token: body.token,
      })
      .returning();

    return NextResponse.json(connection);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: error.status });
    }
    return NextResponse.json({ error: 'Failed to create connection' }, { status: 500 });
  }
}
