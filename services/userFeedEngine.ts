import { createSupabaseServerClient } from "./newsFetcher";
import { computeInsightRankingScore, rankingConfig } from "./rankingEngine";

type PipelineEventRow = {
  id: string;
  payload: unknown;
};

type RelevanceRow = {
  user_id: string | null;
  insight_id: string | null;
  relevance_score: number | null;
};

type InsightMetaRow = {
  id: string;
  cluster_id: string | null;
  created_at: string | null;
  confidence: number | null;
};

type ImpactScoreRow = {
  cluster_id: string | null;
  impact_score: number | null;
  confidence: number | null;
};

type SignalConfidenceRow = {
  cluster_id: string | null;
  confidence: number | null;
};

type FactorExposureRow = {
  cluster_id: string | null;
  exposure: number | null;
  confidence: number | null;
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

  const { error: rankingProbeError } = await supabase
    .from("user_feed")
    .select("ranking_score")
    .limit(1);

  const supportsRankingScore = !rankingProbeError;

  const { data, error } = await supabase
    .from("user_relevance_index")
    .select("user_id,insight_id,relevance_score")
    .eq("user_id", userId)
    .order("relevance_score", { ascending: false })
    .limit(200);

  if (error) {
    throw new Error(`Failed to load user relevance index: ${error.message}`);
  }

  const rows = (data as RelevanceRow[] | null) ?? [];

  const insightIds = uniq(
    rows
      .map((row) => (row.insight_id ?? "").toString().trim())
      .filter(Boolean),
  );

  const insightById = new Map<string, InsightMetaRow>();
  const clusterIds: string[] = [];

  if (insightIds.length > 0) {
    const { data: insights, error: insightError } = await supabase
      .from("event_insights")
      .select("id,cluster_id,created_at,confidence")
      .in("id", insightIds)
      .limit(5000);

    if (insightError) {
      throw new Error(`Failed to load event_insights metadata: ${insightError.message}`);
    }

    for (const row of (insights as InsightMetaRow[] | null) ?? []) {
      if (!row?.id) continue;
      insightById.set(row.id, row);
      const clusterId = (row.cluster_id ?? "").toString().trim();
      if (clusterId) clusterIds.push(clusterId);
    }
  }

  const uniqueClusterIds = uniq(clusterIds);

  const impactStrengthByCluster = new Map<string, number>();
  const confidenceByCluster = new Map<string, number>();
  const exposureStrengthByCluster = new Map<string, number>();

  if (uniqueClusterIds.length > 0) {
    const { data: impactRows, error: impactError } = await supabase
      .from("event_impact_scores")
      .select("cluster_id,impact_score,confidence")
      .in("cluster_id", uniqueClusterIds)
      .limit(5000);

    if (impactError) {
      throw new Error(`Failed to load event_impact_scores: ${impactError.message}`);
    }

    for (const row of (impactRows as ImpactScoreRow[] | null) ?? []) {
      const clusterId = (row.cluster_id ?? "").toString().trim();
      if (!clusterId) continue;

      const impact = Math.abs(Number(row.impact_score));
      const conf = Number(row.confidence);
      const adjusted =
        Number.isFinite(impact) && Number.isFinite(conf)
          ? impact * Math.max(0, Math.min(1, conf))
          : Number.isFinite(impact)
            ? impact
            : 0;

      const prev = impactStrengthByCluster.get(clusterId) ?? 0;
      if (adjusted > prev) impactStrengthByCluster.set(clusterId, adjusted);
    }

    const { data: signalRows, error: signalError } = await supabase
      .from("portfolio_signals")
      .select("cluster_id,confidence")
      .in("cluster_id", uniqueClusterIds)
      .order("created_at", { ascending: false })
      .limit(5000);

    if (signalError) {
      throw new Error(`Failed to load portfolio_signals: ${signalError.message}`);
    }

    for (const row of (signalRows as SignalConfidenceRow[] | null) ?? []) {
      const clusterId = (row.cluster_id ?? "").toString().trim();
      if (!clusterId) continue;

      const conf = Number(row.confidence);
      if (!Number.isFinite(conf)) continue;
      const clamped = Math.max(0, Math.min(1, conf));

      const prev = confidenceByCluster.get(clusterId) ?? 0;
      if (clamped > prev) confidenceByCluster.set(clusterId, clamped);
    }

    const { data: exposureRows, error: exposureError } = await supabase
      .from("event_factor_exposures")
      .select("cluster_id,exposure,confidence")
      .in("cluster_id", uniqueClusterIds)
      .order("created_at", { ascending: false })
      .limit(10000);

    if (exposureError) {
      throw new Error(`Failed to load event_factor_exposures: ${exposureError.message}`);
    }

    for (const row of (exposureRows as FactorExposureRow[] | null) ?? []) {
      const clusterId = (row.cluster_id ?? "").toString().trim();
      if (!clusterId) continue;

      const exposure = Math.abs(Number(row.exposure));
      const conf = Number(row.confidence);
      const adjusted =
        Number.isFinite(exposure) && Number.isFinite(conf)
          ? exposure * Math.max(0, Math.min(1, conf))
          : Number.isFinite(exposure)
            ? exposure
            : 0;

      const prev = exposureStrengthByCluster.get(clusterId) ?? 0;
      if (adjusted > prev) exposureStrengthByCluster.set(clusterId, adjusted);
    }
  }

  const ranked = rows
    .map((row) => {
      const insightId = (row.insight_id ?? "").toString().trim();
      const relevanceScore = Number(row.relevance_score);
      if (!insightId || !Number.isFinite(relevanceScore)) return null;

      const meta = insightById.get(insightId);
      const createdAt = meta?.created_at ?? null;
      const insightConfidence = meta?.confidence ?? null;

      const clusterId = (meta?.cluster_id ?? "").toString().trim();
      const impactStrength = clusterId ? impactStrengthByCluster.get(clusterId) ?? 0 : 0;
      const signalConfidence = clusterId ? confidenceByCluster.get(clusterId) ?? null : null;
      const factorExposureStrength = clusterId ? exposureStrengthByCluster.get(clusterId) ?? 0 : 0;

      const rankingScore = computeInsightRankingScore(
        {
          relevanceScore,
          createdAt,
          impactScore: impactStrength,
          signalConfidence,
          insightConfidence,
          factorExposureStrength,
        },
        rankingConfig,
      );

      return {
        user_id: userId,
        insight_id: insightId,
        relevance_score: relevanceScore,
        ranking_score: rankingScore,
      };
    })
    .filter(Boolean) as Array<{
    user_id: string;
    insight_id: string;
    relevance_score: number;
    ranking_score: number;
  }>;

  const sorted = ranked
    .sort((a, b) => b.ranking_score - a.ranking_score || b.relevance_score - a.relevance_score)
    .slice(0, 100);

  const inserts = supportsRankingScore
    ? sorted
    : sorted.map((r) => ({
        user_id: r.user_id,
        insight_id: r.insight_id,
        relevance_score: r.relevance_score,
      }));

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
