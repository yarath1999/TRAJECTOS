import { createSupabaseServerClient } from "./newsFetcher";

type PipelineEventRow = {
  id: string;
  payload: unknown;
};

type RelevanceRow = {
  user_id: string | null;
  insight_id: string | null;
  relevance_score: number | null;
};

function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function extractPayload(payload: unknown): {
  userId: string | null;
  insightIds: string[];
} {
  if (!payload || typeof payload !== "object") {
    return { userId: null, insightIds: [] };
  }

  const rawUserId = (payload as { user_id?: unknown }).user_id;
  const userId =
    typeof rawUserId === "string" || typeof rawUserId === "number"
      ? rawUserId.toString().trim() || null
      : null;

  const rawInsightIds = (payload as { insight_ids?: unknown }).insight_ids;
  const insightIds = Array.isArray(rawInsightIds)
    ? rawInsightIds
        .map((v) => (typeof v === "string" || typeof v === "number" ? v.toString().trim() : ""))
        .filter(Boolean)
    : [];

  return { userId, insightIds: uniq(insightIds) };
}

async function loadAffectedUsersByInsights(insightIds: string[]): Promise<string[]> {
  const supabase = createSupabaseServerClient();
  const unique = uniq(insightIds.filter(Boolean));
  if (unique.length === 0) return [];

  const { data, error } = await supabase
    .from("insight_user_edges")
    .select("user_id")
    .in("insight_id", unique)
    .limit(5000);

  if (error) {
    throw new Error(`Failed to load affected users: ${error.message}`);
  }

  const userIds = ((data as Array<{ user_id: string | null }> | null) ?? [])
    .map((r) => (r.user_id ?? "").toString().trim())
    .filter(Boolean);

  return uniq(userIds);
}

async function rebuildUserFeed(userId: string): Promise<void> {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from("user_relevance_index")
    .select("user_id,insight_id,relevance_score")
    .eq("user_id", userId)
    .order("relevance_score", { ascending: false })
    .limit(100);

  if (error) {
    throw new Error(`Failed to load user relevance index: ${error.message}`);
  }

  const rows = (data as RelevanceRow[] | null) ?? [];

  const inserts = rows
    .map((row) => {
      const insightId = (row.insight_id ?? "").toString().trim();
      const score = Number(row.relevance_score);
      if (!insightId || !Number.isFinite(score)) return null;
      return { user_id: userId, insight_id: insightId, relevance_score: score };
    })
    .filter(Boolean) as Array<{ user_id: string; insight_id: string; relevance_score: number }>;

  const { error: deleteError } = await supabase
    .from("user_feed")
    .delete()
    .eq("user_id", userId);

  if (deleteError) {
    throw new Error(`Failed to clear user feed: ${deleteError.message}`);
  }

  if (inserts.length > 0) {
    const { error: insertError } = await supabase.from("user_feed").insert(inserts);

    if (insertError) {
      throw new Error(`Failed to insert user feed rows: ${insertError.message}`);
    }
  }

  const { error: emitError } = await supabase.from("pipeline_events").insert({
    event_type: "USER_FEED_DELTA",
    payload: { user_id: userId },
  });

  if (emitError) {
    throw new Error(`Failed to emit USER_FEED_DELTA event: ${emitError.message}`);
  }
}

export async function runUserFeedEngine(): Promise<void> {
  const supabase = createSupabaseServerClient();

  const { data: events, error } = await supabase
    .from("pipeline_events")
    .select("id,payload")
    .eq("event_type", "USER_RELEVANCE_UPDATED")
    .eq("processed", false)
    .order("created_at", { ascending: true })
    .limit(25);

  if (error) {
    throw new Error(`Failed to load pipeline events: ${error.message}`);
  }

  const pending = (events as PipelineEventRow[] | null) ?? [];
  if (pending.length === 0) return;

  for (const evt of pending) {
    const { userId, insightIds } = extractPayload(evt.payload);

    let affectedUserIds: string[] = [];
    if (insightIds.length > 0) {
      affectedUserIds = await loadAffectedUsersByInsights(insightIds);
    } else if (userId) {
      affectedUserIds = [userId];
    }

    affectedUserIds = uniq(affectedUserIds).slice(0, 500);

    for (const uid of affectedUserIds) {
      await rebuildUserFeed(uid);
    }

    const { error: markError } = await supabase
      .from("pipeline_events")
      .update({ processed: true })
      .eq("id", evt.id);

    if (markError) {
      throw new Error(`Failed to mark pipeline event processed: ${markError.message}`);
    }
  }
}
