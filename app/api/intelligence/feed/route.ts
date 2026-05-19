/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { queryIntelligenceFeed } from '../../../../services/feedEngine';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Number(url.searchParams.get('limit') ?? '20');
    const offset = Number(url.searchParams.get('offset') ?? '0');
    const category = url.searchParams.get('category');
    const importance = url.searchParams.get('importance');
    const q = url.searchParams.get('q');

    const result = await queryIntelligenceFeed({ limit, offset, category: category ?? null, importance: importance ?? null, q: q ?? null });
    return NextResponse.json(result);
//   } catch (err: any) {
//     return new NextResponse(JSON.stringify({ error: err?.message ?? String(err) }), { status: 500 });
//   }
} catch (err: any) {
  console.error('INTELLIGENCE_FEED_ERROR:', err);

  return new NextResponse(
    JSON.stringify({
      error: err?.message ?? String(err),
      stack: err?.stack ?? null,
    }),
    { status: 500 }
  );
}
}
/* eslint-enable @typescript-eslint/no-explicit-any */