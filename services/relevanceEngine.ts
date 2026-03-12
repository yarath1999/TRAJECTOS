import { createSupabaseServerClient } from "./newsFetcher";

type UserPortfolioRow = {
  user_id: string | null;
  asset: string | null;
};

type AssetTagRow = {
  tag: string | null;
};

type InsightTagRow = {
  insight_id: string | null;
  tag: string | null;
};

function clamp(min: number, value: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export async function runRelevanceEngine(): Promise<void> {
  const supabase = createSupabaseServerClient();

  // 1) Load users and their assets.
  const { data: portfolioRows, error: portfolioError } = await supabase
    .from("user_portfolios")
    .select("user_id,asset")
    .limit(500);

  if (portfolioError) {
    throw new Error(
      `Failed to load user_portfolios (expected columns: user_id, asset): ${portfolioError.message}`,
    );
  }

  const rows = (portfolioRows as UserPortfolioRow[] | null) ?? [];
  if (rows.length === 0) return;

  const assetsByUser = new Map<string, string[]>();
  for (const row of rows) {
    const userId = (row.user_id ?? "").toString().trim();
    const asset = (row.asset ?? "").toString().trim().toLowerCase();
    if (!userId || !asset) continue;

    const list = assetsByUser.get(userId) ?? [];
    list.push(asset);
    assetsByUser.set(userId, list);
  }

  const userIds = Array.from(assetsByUser.keys()).slice(0, 20);
  if (userIds.length === 0) return;

  for (const userId of userIds) {
    const assets = uniq((assetsByUser.get(userId) ?? []).filter(Boolean));
    if (assets.length === 0) continue;

    // 2) Fetch tags for user assets.
    const { data: assetTags, error: assetTagsError } = await supabase
      .from("asset_tags")
      .select("tag")
      .in("asset", assets);

    if (assetTagsError) {
      throw new Error(`Failed to load asset tags: ${assetTagsError.message}`);
    }

    const userTags = uniq(
      ((assetTags as AssetTagRow[] | null) ?? [])
        .map((r) => (r.tag ?? "").toString().trim().toLowerCase())
        .filter(Boolean),
    );

    if (userTags.length === 0) {
      // Still emit an update event so downstream systems know this user was processed.
      const { error: emitError } = await supabase.from("pipeline_events").insert({
        event_type: "USER_RELEVANCE_UPDATED",
        payload: { user_id: userId },
      });

      if (emitError) {
        throw new Error(
          `Failed to emit USER_RELEVANCE_UPDATED event: ${emitError.message}`,
        );
      }

      continue;
    }

    // 3) Match insight tags.
    const { data: matchingInsightTags, error: insightTagsError } = await supabase
      .from("insight_tags")
      .select("insight_id,tag")
      .in("tag", userTags)
      .limit(5000);

    if (insightTagsError) {
      throw new Error(`Failed to load matching insight tags: ${insightTagsError.message}`);
    }

    const matches = (matchingInsightTags as InsightTagRow[] | null) ?? [];

    // 4) Compute relevance score: match_count / total_user_tags
    const matchCountByInsight = new Map<string, number>();
    for (const row of matches) {
      const insightId = (row.insight_id ?? "").toString().trim();
      if (!insightId) continue;
      matchCountByInsight.set(insightId, (matchCountByInsight.get(insightId) ?? 0) + 1);
    }

    // Keep the index bounded per user.
    const scored = Array.from(matchCountByInsight.entries())
      .map(([insightId, matchCount]) => ({
        insight_id: insightId,
        relevance_score: clamp(0, matchCount / userTags.length, 1),
      }))
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, 200);

    // 5) Insert relevance index (idempotent per run).
    const { error: deleteError } = await supabase
      .from("user_relevance_index")
      .delete()
      .eq("user_id", userId);

    if (deleteError) {
      throw new Error(`Failed to clear old relevance rows: ${deleteError.message}`);
    }

    if (scored.length > 0) {
      const inserts = scored.map((r) => ({
        user_id: userId,
        insight_id: r.insight_id,
        relevance_score: r.relevance_score,
      }));

      const { error: insertError } = await supabase.from("user_relevance_index").insert(inserts);
      if (insertError) {
        throw new Error(`Failed to insert relevance index: ${insertError.message}`);
      }
    }

    // Emit update event
    const { error: emitError } = await supabase.from("pipeline_events").insert({
      event_type: "USER_RELEVANCE_UPDATED",
      payload: { user_id: userId },
    });

    if (emitError) {
      throw new Error(`Failed to emit USER_RELEVANCE_UPDATED event: ${emitError.message}`);
    }
  }
}
