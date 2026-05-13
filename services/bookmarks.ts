import { createSupabaseServerClient, type FetchAndStoreNewsResult } from "./newsFetcher";
import { createSupabaseClientWithAccessToken } from "../lib/supabase";

export async function toggleBookmarkForUser(accessToken: string, feedItemId: string) {
  const supabase = createSupabaseClientWithAccessToken(accessToken);
  if (!supabase) throw new Error('Supabase not configured');

  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData.user) throw new Error('Not authenticated');
  const userId = userData.user.id;

  const { data: existing, error: selErr } = await supabase
    .from('intelligence_bookmarks')
    .select('id')
    .eq('user_id', userId)
    .eq('feed_item_id', feedItemId)
    .maybeSingle();

  if (selErr) throw new Error(selErr.message);

  if (existing) {
    const { error: delErr } = await supabase
      .from('intelligence_bookmarks')
      .delete()
      .eq('id', existing.id);
    if (delErr) throw new Error(delErr.message);
    return { removed: true };
  }

  const { error: insErr } = await supabase.from('intelligence_bookmarks').insert({
    user_id: userId,
    feed_item_id: feedItemId,
  });
  if (insErr) throw new Error(insErr.message);
  return { removed: false };
}

export async function getBookmarksForUser(accessToken: string) {
  const supabase = createSupabaseClientWithAccessToken(accessToken);
  if (!supabase) throw new Error('Supabase not configured');
  const { data: userData, error: userErr } = await supabase.auth.getUser();
  if (userErr || !userData.user) throw new Error('Not authenticated');
  const userId = userData.user.id;

  const { data, error } = await supabase
    .from('intelligence_bookmarks')
    .select('feed_item_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []).map((r: any) => String(r.feed_item_id));
}
