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

type SegmentInsightRow = {
  insight_id: string | null;
};

function clamp(min: number, value: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

function inferSegmentsFromAssets(assets: string[]): string[] {
  const segments = new Set<string>();
  const lower = assets.map((a) => a.toLowerCase());

  if (lower.some((a) => a.includes("equity") || a.includes("tech"))) {
    segments.add("tech_investors");
  }

  if (lower.some((a) => a.includes("bond") || a.includes("treasury"))) {
    segments.add("bond_investors");
  }

  if (lower.some((a) => a.includes("bitcoin") || a.includes("crypto"))) {
    segments.add("crypto_investors");
  }

  return Array.from(segments);
}

async function loadUserPortfolios(limit: number): Promise<UserPortfolioRow[]> {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from("user_portfolios")
    .select("user_id,asset")
    .limit(limit);

  if (error) {
    throw new Error(
      `Failed to load user_portfolios (expected columns: user_id, asset): ${error.message}`,
    );
  }

  return (data as UserPortfolioRow[] | null) ?? [];
}

async function loadTagsForAssets(assets: string[]): Promise<string[]> {
  const supabase = createSupabaseServerClient();

  const uniqueAssets = uniq(
    assets
      .map((a) => a.toString().trim().toLowerCase())
      .filter(Boolean),
  );

  if (uniqueAssets.length === 0) return [];

  const { data, error } = await supabase
    .from("asset_tags")
    .select("tag")
    .in("asset", uniqueAssets)
    .limit(5000);

  if (error) {
    throw new Error(`Failed to load asset tags: ${error.message}`);
  }

  return uniq(
    ((data as AssetTagRow[] | null) ?? [])
      .map((r) => (r.tag ?? "").toString().trim().toLowerCase())
      .filter(Boolean),
  );
}

async function loadCandidateInsightsFromTags(userTags: string[]): Promise<string[]> {
  const supabase = createSupabaseServerClient();

  if (userTags.length === 0) return [];

  const { data, error } = await supabase
    .from("insight_tags")
    .select("insight_id")
    .in("tag", userTags)
    .limit(5000);

  if (error) {
    throw new Error(`Failed to load matching insight tags: ${error.message}`);
  }

  const rows = (data as Array<{ insight_id: string | null }> | null) ?? [];
  return uniq(
    rows
      .map((r) => (r.insight_id ?? "").toString().trim())
      .filter(Boolean),
  );
}

async function loadCandidateInsightsFromSegments(segments: string[]): Promise<string[]> {
  const supabase = createSupabaseServerClient();

  if (segments.length === 0) return [];

  const { data, error } = await supabase
    .from("segment_insight_index")
    .select("insight_id")
    .in("segment", segments)
    .limit(5000);

  if (error) {
    throw new Error(`Failed to load segment insight index: ${error.message}`);
  }

  return uniq(
    ((data as SegmentInsightRow[] | null) ?? [])
      .map((r) => (r.insight_id ?? "").toString().trim())
      .filter(Boolean),
  );
}

async function computeMatchCounts(params: {
  insightIds: string[];
  userTags: string[];
}): Promise<Map<string, number>> {
  const supabase = createSupabaseServerClient();

  const insightIds = uniq(params.insightIds.filter(Boolean));
  const userTags = uniq(params.userTags.filter(Boolean));

  if (insightIds.length === 0 || userTags.length === 0) return new Map();

  const { data, error } = await supabase
    .from("insight_tags")
    .select("insight_id,tag")
    .in("insight_id", insightIds)
    .in("tag", userTags)
    .limit(20000);

  if (error) {
    throw new Error(`Failed to load insight tag matches: ${error.message}`);
  }

  const rows = (data as InsightTagRow[] | null) ?? [];
  const tagsByInsight = new Map<string, Set<string>>();

  for (const row of rows) {
    const insightId = (row.insight_id ?? "").toString().trim();
    const tag = (row.tag ?? "").toString().trim().toLowerCase();
    if (!insightId || !tag) continue;

    let set = tagsByInsight.get(insightId);
    if (!set) {
      set = new Set<string>();
      tagsByInsight.set(insightId, set);
    }

    set.add(tag);
  }

  const counts = new Map<string, number>();
  for (const [insightId, set] of tagsByInsight.entries()) {
    counts.set(insightId, set.size);
  }

  return counts;
}

async function filterExistingInsights(insightIds: string[]): Promise<Set<string>> {
  const supabase = createSupabaseServerClient();

  const unique = uniq(insightIds.filter(Boolean));
  if (unique.length === 0) return new Set();

  const { data, error } = await supabase
    .from("event_insights")
    .select("id")
    .in("id", unique)
    .limit(5000);

  if (error) {
    throw new Error(`Failed to load event_insights ids: ${error.message}`);
  }

  const existing = new Set<string>();
  for (const row of (data as Array<{ id: string }> | null) ?? []) {
    if (row?.id) existing.add(row.id);
  }

  return existing;
}

export async function runUserRelevanceEngine(): Promise<void> {
  const supabase = createSupabaseServerClient();

  const portfolioRows = await loadUserPortfolios(2000);
  if (portfolioRows.length === 0) return;

  const assetsByUser = new Map<string, string[]>();
  for (const row of portfolioRows) {
    const userId = (row.user_id ?? "").toString().trim();
    const asset = (row.asset ?? "").toString().trim();
    if (!userId || !asset) continue;

    const list = assetsByUser.get(userId) ?? [];
    list.push(asset);
    assetsByUser.set(userId, list);
  }

  const userIds = Array.from(assetsByUser.keys()).slice(0, 50);
  if (userIds.length === 0) return;

  for (const userId of userIds) {
    const assets = uniq((assetsByUser.get(userId) ?? []).filter(Boolean));

    // 2) Fetch asset tags
    const userTags = await loadTagsForAssets(assets);

    // Clear prior rows for idempotency.
    const { error: deleteError } = await supabase
      .from("user_relevance_index")
      .delete()
      .eq("user_id", userId);

    if (deleteError) {
      throw new Error(`Failed to clear old relevance rows: ${deleteError.message}`);
    }

    if (userTags.length === 0) {
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

    // Clear prior edges for this user (delta propagation uses these edges).
    const { error: deleteEdgesError } = await supabase
      .from("insight_user_edges")
      .delete()
      .eq("user_id", userId);

    if (deleteEdgesError) {
      throw new Error(
        `Failed to clear old insight_user_edges rows: ${deleteEdgesError.message}`,
      );
    }

    // 3) Candidate insights
    const tagCandidates = await loadCandidateInsightsFromTags(userTags);

    // Optional accelerator: union with segment-based candidates.
    const segments = inferSegmentsFromAssets(assets);
    const segmentCandidates = await loadCandidateInsightsFromSegments(segments);

    const candidateIds = uniq([...tagCandidates, ...segmentCandidates]).slice(0, 1000);

    if (candidateIds.length === 0) {
      const { error: emitError } = await supabase.from("pipeline_events").insert({
        event_type: "USER_RELEVANCE_UPDATED",
        payload: { user_id: userId, insight_ids: [] },
      });

      if (emitError) {
        throw new Error(
          `Failed to emit USER_RELEVANCE_UPDATED event: ${emitError.message}`,
        );
      }

      continue;
    }

    // Ensure we only insert insights that actually exist.
    const existing = await filterExistingInsights(candidateIds);
    const existingCandidates = candidateIds.filter((id) => existing.has(id));

    if (existingCandidates.length === 0) {
      const { error: emitError } = await supabase.from("pipeline_events").insert({
        event_type: "USER_RELEVANCE_UPDATED",
        payload: { user_id: userId, insight_ids: [] },
      });

      if (emitError) {
        throw new Error(
          `Failed to emit USER_RELEVANCE_UPDATED event: ${emitError.message}`,
        );
      }

      continue;
    }

    // 4) Compute relevance: matching_tags / total_asset_tags
    const matchCounts = await computeMatchCounts({
      insightIds: existingCandidates,
      userTags,
    });

    const scored = Array.from(matchCounts.entries())
      .map(([insightId, matchCount]) => ({
        insight_id: insightId,
        relevance_score: clamp(0, matchCount / userTags.length, 1),
      }))
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, 200);

    if (scored.length > 0) {
      const inserts = scored.map((r) => ({
        user_id: userId,
        insight_id: r.insight_id,
        relevance_score: r.relevance_score,
      }));

      const { error: insertError } = await supabase
        .from("user_relevance_index")
        .insert(inserts);

      if (insertError) {
        throw new Error(`Failed to insert relevance index: ${insertError.message}`);
      }

      const { error: edgeInsertError } = await supabase
        .from("insight_user_edges")
        .insert(inserts);

      if (edgeInsertError) {
        throw new Error(
          `Failed to insert insight_user_edges rows: ${edgeInsertError.message}`,
        );
      }
    }

    // 3) Emit update event to trigger feed engine
    const changedInsightIds = scored.map((r) => r.insight_id);
    const { error: emitError } = await supabase.from("pipeline_events").insert({
      event_type: "USER_RELEVANCE_UPDATED",
      payload: { user_id: userId, insight_ids: changedInsightIds },
    });

    if (emitError) {
      throw new Error(`Failed to emit USER_RELEVANCE_UPDATED event: ${emitError.message}`);
    }
  }
}
