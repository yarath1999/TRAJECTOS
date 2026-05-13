import { NextResponse } from 'next/server';
import { toggleBookmarkForUser, getBookmarksForUser } from '../../../../services/bookmarks';

export async function POST(req: Request) {
  try {
    const auth = req.headers.get('authorization') ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    const body = await req.json();
    const { feedItemId } = body;
    if (!token) return new NextResponse('Unauthorized', { status: 401 });
    if (!feedItemId) return new NextResponse('Missing feedItemId', { status: 400 });

    const result = await toggleBookmarkForUser(token, String(feedItemId));
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
