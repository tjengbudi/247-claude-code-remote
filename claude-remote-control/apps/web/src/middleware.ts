import { NextResponse } from 'next/server';

export default async function middleware() {
  // All routes are public - no auth required
  // (Neon OAuth callback branch retired in Story 4.4; pass-through only.)
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|icon-|apple-icon|manifest).*)'],
};
