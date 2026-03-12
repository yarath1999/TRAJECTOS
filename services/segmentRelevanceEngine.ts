import { createSupabaseServerClient } from "./newsFetcher";

type SegmentRow = {
  segment: string | null;
};

type SegmentTagRow = {
  tag: string | null;
};

type InsightTagRow = {
  insight_id: string | null;
  tag: string | null;
};

type UserPortfolioRow = {
  user_id: string | null;
  asset: string | null;
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

  // Spec examples
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

async function computeSegmentInsightIndex(segment: string): Promise<void> {
  const supabase = createSupabaseServerClient();

  // 2) Fetch tags for each segment
  const { data: segTagsData, error: segTagsError } = await supabase
    .from("segment_tags")
    .select("tag")
    .eq("segment", segment)
    .limit(200);

  if (segTagsError) {
    throw new Error(`Failed to load segment tags: ${segTagsError.message}`);
  }

  const segmentTags = uniq(
    ((segTagsData as SegmentTagRow[] | null) ?? [])
      .map((r) => (r.tag ?? "").toString().trim().toLowerCase())
      .filter(Boolean),
  );

  // Idempotent: clear prior rows even if tag set is empty.
  const { error: deleteError } = await supabase
    .from("segment_insight_index")
    .delete()
    .eq("segment", segment);

  if (deleteError) {
    throw new Error(`Failed to clear old segment index: ${deleteError.message}`);
  }

  if (segmentTags.length === 0) return;

  // 3) Match insights
  const { data: matchesData, error: matchesError } = await supabase
    .from("insight_tags")
    .select("insight_id,tag")
    .in("tag", segmentTags)
    .limit(10000);

  if (matchesError) {
    throw new Error(`Failed to load matching insight tags: ${matchesError.message}`);
  }

  const matches = (matchesData as InsightTagRow[] | null) ?? [];

  // 4) Compute relevance score = matching_tags / total_segment_tags
  const matchCountByInsight = new Map<string, number>();
  for (const row of matches) {
    const insightId = (row.insight_id ?? "").toString().trim();
    if (!insightId) continue;
    matchCountByInsight.set(
      insightId,
      (matchCountByInsight.get(insightId) ?? 0) + 1,
    );
  }

  const scored = Array.from(matchCountByInsight.entries())
    .map(([insightId, matchCount]) => ({
      segment,
      insight_id: insightId,
      relevance_score: clamp(0, matchCount / segmentTags.length, 1),
    }))
    .sort((a, b) => b.relevance_score - a.relevance_score)
    .slice(0, 500);

  if (scored.length === 0) return;

  // 5) Insert segment insight relevance
  const { error: insertError } = await supabase.from("segment_insight_index").insert(scored);

  if (insertError) {
    throw new Error(`Failed to insert segment insight index: ${insertError.message}`);
  }
}

async function mapUsersToSegments(): Promise<void> {
  const supabase = createSupabaseServerClient();

  // Load a bounded window of user portfolios.
  const { data, error } = await supabase
    .from("user_portfolios")
    .select("user_id,asset")
    .limit(1000);

  if (error) {
    throw new Error(
      `Failed to load user_portfolios (expected columns: user_id, asset): ${error.message}`,
    );
  }

  const rows = (data as UserPortfolioRow[] | null) ?? [];
  if (rows.length === 0) return;

  const assetsByUser = new Map<string, string[]>();
  for (const row of rows) {
    const userId = (row.user_id ?? "").toString().trim();
    const asset = (row.asset ?? "").toString().trim();
    if (!userId || !asset) continue;
    const list = assetsByUser.get(userId) ?? [];
    list.push(asset);
    assetsByUser.set(userId, list);
  }

  const userIds = Array.from(assetsByUser.keys()).slice(0, 200);

  for (const userId of userIds) {
    const assets = uniq((assetsByUser.get(userId) ?? []).filter(Boolean));
    const segments = inferSegmentsFromAssets(assets);

    // Idempotent mapping.
    const { error: deleteError } = await supabase
      .from("user_segments")
      .delete()
      .eq("user_id", userId);

    if (deleteError) {
      throw new Error(`Failed to clear user segments: ${deleteError.message}`);
    }

    if (segments.length === 0) continue;

    const inserts = segments.map((segment) => ({
      user_id: userId,
      segment,
    }));

    const { error: insertError } = await supabase.from("user_segments").insert(inserts);

    if (insertError) {
      throw new Error(`Failed to insert user segments: ${insertError.message}`);
    }
  }
}

export async function runSegmentRelevanceEngine(): Promise<void> {
  // Step 5: keep user->segment mapping fresh.
  await mapUsersToSegments();

  const supabase = createSupabaseServerClient();

  // 1) Load segments
  const { data: segmentsData, error: segmentsError } = await supabase
    .from("segment_tags")
    .select("segment")
    .limit(200);

  if (segmentsError) {
    throw new Error(`Failed to load segments: ${segmentsError.message}`);
  }

  const segments = uniq(
    ((segmentsData as SegmentRow[] | null) ?? [])
      .map((r) => (r.segment ?? "").toString().trim())
      .filter(Boolean),
  );

  if (segments.length === 0) return;

  for (const segment of segments) {
    await computeSegmentInsightIndex(segment);
  }
}
