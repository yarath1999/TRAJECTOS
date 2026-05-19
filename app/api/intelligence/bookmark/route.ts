/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { toggleBookmarkForUser, getBookmarksForUser } from '../../../../services/bookmarks';

export async function POST(req: Request) {
  try {
    const auth = req.headers.get('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    const body = await req.json();
    const eventId = body.eventId ?? body.feedItemId;
    if (!token) return new NextResponse('Unauthorized', { status: 401 });
    if (!eventId) return new NextResponse('Missing eventId', { status: 400 });

    const result = await toggleBookmarkForUser(token, String(eventId));
    return NextResponse.json(result);
  } catch (err: any) {
    return new NextResponse(JSON.stringify({ error: err?.message ?? String(err) }), { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const auth = req.headers.get('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    if (!token) return new NextResponse('Unauthorized', { status: 401 });
    const list = await getBookmarksForUser(token);
    return NextResponse.json({ bookmarks: list });
  } catch (err: any) {
    return new NextResponse(JSON.stringify({ error: err?.message ?? String(err) }), { status: 500 });
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */