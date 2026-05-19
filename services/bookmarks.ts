import { createSupabaseServerClient } from "./newsFetcher";
import { createSupabaseClientWithAccessToken } from "../lib/supabase";

type SupabaseErrorLike = {
  message?: string;
  code?: string;
  details?: string;
  hint?: string;
};

function getSupabaseErrorDetails(error: unknown): SupabaseErrorLike {
  if (!error || typeof error !== "object") {
    return { message: String(error) };
  }

  const candidate = error as SupabaseErrorLike;
  return {
    message: candidate.message ?? (error instanceof Error ? error.message : "Unknown error"),
    code: candidate.code,
    details: candidate.details,
    hint: candidate.hint,
  };
}

function logBookmarkFailure(action: string, error: unknown, context: Record<string, unknown>) {
  const details = getSupabaseErrorDetails(error);
  console.error(`[bookmarks] ${action} failed`, {
    ...context,
    error: {
      message: details.message,
      code: details.code,
      details: details.details,
      hint: details.hint,
    },
  });
}

export async function toggleBookmarkForUser(accessToken: string, eventId: string) {
  const authSupabase = createSupabaseClientWithAccessToken(accessToken);
  if (!authSupabase) throw new Error('Supabase not configured');

  const { data: userData, error: userErr } = await authSupabase.auth.getUser();
  if (userErr || !userData.user) throw new Error('Not authenticated');
  const userId = userData.user.id;

  const supabase = createSupabaseServerClient();

  const { data: existing, error: selErr } = await supabase
    .from('intelligence_bookmarks')
    .select('id')
    .eq('user_id', userId)
    .eq('event_id', eventId)
    .maybeSingle();

  if (selErr) {
    logBookmarkFailure('select', selErr, { userId, eventId });
    throw new Error(selErr.message);
  }

  if (existing) {
    const { error: delErr } = await supabase
      .from('intelligence_bookmarks')
      .delete()
      .eq('id', existing.id);
    if (delErr) {
      logBookmarkFailure('delete', delErr, { userId, eventId, bookmarkId: existing.id });
      throw new Error(delErr.message);
    }
    return { removed: true };
  }

  const { error: insErr } = await supabase.from('intelligence_bookmarks').insert({
    user_id: userId,
    event_id: eventId,
  });
  if (insErr) {
    logBookmarkFailure('insert', insErr, { userId, eventId });
    throw new Error(insErr.message);
  }
  return { removed: false };
}

export async function getBookmarksForUser(accessToken: string) {
  const authSupabase = createSupabaseClientWithAccessToken(accessToken);
  if (!authSupabase) throw new Error('Supabase not configured');
  const { data: userData, error: userErr } = await authSupabase.auth.getUser();
  if (userErr || !userData.user) throw new Error('Not authenticated');
  const userId = userData.user.id;

  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from('intelligence_bookmarks')
    .select('event_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (error) {
    logBookmarkFailure('list', error, { userId });
    throw new Error(error.message);
  }
  return (data ?? []).map((r: { event_id: string | number }) => String(r.event_id));
}
