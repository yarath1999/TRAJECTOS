/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { createSupabaseServerClient } from '../../../../services/newsFetcher';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const clusterId = url.searchParams.get('cluster_id');
    if (!clusterId) return new NextResponse('Missing cluster_id', { status: 400 });

    const supabase = createSupabaseServerClient();
    const { data, error } = await supabase.from('event_clusters').select('id,title,summary,created_at').eq('id', clusterId).maybeSingle();
    if (error) return new NextResponse(JSON.stringify({ error: error.message }), { status: 500 });
    return NextResponse.json({ cluster: data });
  } catch (err: any) {
    return new NextResponse(JSON.stringify({ error: err?.message ?? String(err) }), { status: 500 });
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */