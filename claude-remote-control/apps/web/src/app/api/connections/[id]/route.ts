import { NextResponse } from 'next/server';
import { db, agentConnection } from '@/lib/db';
import { eq, and } from 'drizzle-orm';
import { requireUser, AuthError } from '@/lib/auth';

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser();

    const { id } = await params;

    await db
      .delete(agentConnection)
      .where(and(eq(agentConnection.id, id), eq(agentConnection.userId, user.id)));

    return NextResponse.json({ success: true });
  } catch (error) {
    // Option A: discriminable 401 before generic 500
    if (error instanceof AuthError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: error.status });
    }
    return NextResponse.json({ error: 'Failed to delete connection' }, { status: 500 });
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user } = await requireUser();

    const { id } = await params;
    const body = await req.json();

    const [connection] = await db
      .update(agentConnection)
      .set({
        name: body.name,
        url: body.url,
        method: body.method,
        color: body.color,
        updatedAt: new Date(),
      })
      .where(and(eq(agentConnection.id, id), eq(agentConnection.userId, user.id)))
      .returning();

    if (!connection) {
      return NextResponse.json({ error: 'Connection not found' }, { status: 404 });
    }

    return NextResponse.json(connection);
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: error.status });
    }
    return NextResponse.json({ error: 'Failed to update connection' }, { status: 500 });
  }
}
