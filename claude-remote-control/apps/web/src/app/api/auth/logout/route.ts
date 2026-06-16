import { NextResponse } from 'next/server';
import { destroySession } from '@/lib/auth';

export async function POST() {
  try {
    await destroySession();
    return NextResponse.json({ data: { success: true } });
  } catch {
    return NextResponse.json(
      { error: 'Logout failed' },
      { status: 500 }
    );
  }
}
