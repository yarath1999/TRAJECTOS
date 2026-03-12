import { createSupabaseServerClient } from "./newsFetcher";

type PipelineEventRow = {
  id: string;
  payload: unknown;
};

type UserFeedRow = {
  user_id: string | null;
  insight_id: string | null;
  relevance_score: number | null;
  event_insights:
    | {
        insight: string | null;
        created_at: string | null;
        cluster_id: string | null;
      }
    | Array<{
        insight: string | null;
        created_at: string | null;
        cluster_id: string | null;
      }>
    | null;
};

type CanonicalEventRow = {
  cluster_id: string;
  canonical_title: string | null;
  canonical_summary: string | null;
};

type PortfolioSignalRow = {
  cluster_id: string | null;
  asset: string | null;
  signal: string | null;
};

type InsightTagRow = {
  insight_id: string | null;
  tag: string | null;
};

export type FeedCardSignal = {
  asset: string;
  signal: string;
};

export type FeedCard = {
  headline: string;
  summary: string;
  signals: FeedCardSignal[];
  tags: string[];
  score: number;
  timestamp: string;
};

function getEmbeddedInsight(row: UserFeedRow):
  | {
      insight: string | null;
      created_at: string | null;
      cluster_id: string | null;
    }
  | null {
  const embedded = row.event_insights;
  if (!embedded) return null;
  if (Array.isArray(embedded)) return embedded[0] ?? null;
  return embedded;
}

function extractUserIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const userId = (payload as { user_id?: unknown }).user_id;
  if (typeof userId !== "string" && typeof userId !== "number") return null;
  const trimmed = userId.toString().trim();
  return trimmed ? trimmed : null;
}

function uniq<T>(items: T[]): T[] {
  return Array.from(new Set(items));
}

export async function runFeedCacheEngine(): Promise<void> {
  const supabase = createSupabaseServerClient();

  const { data: events, error } = await supabase
    .from("pipeline_events")
    .select("id,payload")
    .eq("event_type", "USER_FEED_DELTA")
    .eq("processed", false)
    .order("created_at", { ascending: true })
    .limit(50);

  if (error) {
    throw new Error(`Failed to load pipeline events: ${error.message}`);
  }

  const pending = (events as PipelineEventRow[] | null) ?? [];
  if (pending.length === 0) return;

  for (const evt of pending) {
    const userId = extractUserIdFromPayload(evt.payload);

    if (!userId) {
      const { error: markError } = await supabase
        .from("pipeline_events")
        .update({ processed: true })
        .eq("id", evt.id);

      if (markError) {
        throw new Error(`Failed to mark pipeline event processed: ${markError.message}`);
      }

      continue;
    }

    const { data: rows, error: feedError } = await supabase
      .from("user_feed")
      .select(
        "user_id,insight_id,relevance_score,event_insights!inner(insight,created_at,cluster_id)",
      )
      .eq("user_id", userId)
      .order("relevance_score", { ascending: false })
      .limit(20);

    if (feedError) {
      throw new Error(`Failed to load user feed for cache: ${feedError.message}`);
    }

    const joined = ((rows as unknown as UserFeedRow[] | null) ?? []).filter(Boolean);

    const insightIds = uniq(
      joined
        .map((r) => (r.insight_id ?? "").toString().trim())
        .filter(Boolean),
    );

    const clusterIds = uniq(
      joined
        .map((r) => (getEmbeddedInsight(r)?.cluster_id ?? "").toString().trim())
        .filter(Boolean),
    );

    // Fetch canonical headline/summary per cluster.
    const canonicalByCluster = new Map<string, CanonicalEventRow>();
    if (clusterIds.length > 0) {
      const { data: canonicalRows, error: canonicalError } = await supabase
        .from("canonical_events")
        .select("cluster_id,canonical_title,canonical_summary")
        .in("cluster_id", clusterIds)
        .limit(2000);

      if (canonicalError) {
        throw new Error(`Failed to load canonical events: ${canonicalError.message}`);
      }

      for (const row of (canonicalRows as CanonicalEventRow[] | null) ?? []) {
        if (!row?.cluster_id) continue;
        canonicalByCluster.set(row.cluster_id, row);
      }
    }

    // Fetch portfolio signals per cluster.
    const signalsByCluster = new Map<string, FeedCardSignal[]>();
    if (clusterIds.length > 0) {
      const { data: signalRows, error: signalsError } = await supabase
        .from("portfolio_signals")
        .select("cluster_id,asset,signal")
        .in("cluster_id", clusterIds)
        .order("created_at", { ascending: false })
        .limit(5000);

      if (signalsError) {
        throw new Error(`Failed to load portfolio signals: ${signalsError.message}`);
      }

      for (const row of (signalRows as PortfolioSignalRow[] | null) ?? []) {
        const clusterId = (row.cluster_id ?? "").toString().trim();
        const asset = (row.asset ?? "").toString().trim();
        const signal = (row.signal ?? "").toString().trim();
        if (!clusterId || !asset || !signal) continue;

        const list = signalsByCluster.get(clusterId) ?? [];
        // Keep it tight for cache payload size.
        if (list.length < 10) {
          list.push({ asset, signal });
        }
        signalsByCluster.set(clusterId, list);
      }
    }

    // Fetch tags per insight.
    const tagsByInsight = new Map<string, string[]>();
    if (insightIds.length > 0) {
      const { data: tagRows, error: tagsError } = await supabase
        .from("insight_tags")
        .select("insight_id,tag")
        .in("insight_id", insightIds)
        .limit(5000);

      if (tagsError) {
        throw new Error(`Failed to load insight tags: ${tagsError.message}`);
      }

      for (const row of (tagRows as InsightTagRow[] | null) ?? []) {
        const insightId = (row.insight_id ?? "").toString().trim();
        const tag = (row.tag ?? "").toString().trim();
        if (!insightId || !tag) continue;

        const list = tagsByInsight.get(insightId) ?? [];
        if (!list.includes(tag)) list.push(tag);
        tagsByInsight.set(insightId, list);
      }
    }

    const feed: FeedCard[] = joined
      .map((r) => {
        const insightId = (r.insight_id ?? "").toString().trim();
        const score = Number(r.relevance_score);
        const embedded = getEmbeddedInsight(r);
        const insightText = (embedded?.insight ?? "").toString().trim();
        const clusterId = (embedded?.cluster_id ?? "").toString().trim();
        const timestamp = (embedded?.created_at ?? "").toString().trim();

        if (!insightId || !Number.isFinite(score) || !timestamp) return null;

        const canonical = clusterId ? canonicalByCluster.get(clusterId) : undefined;

        const headline = (canonical?.canonical_title ?? insightText).toString().trim();
        const summary = (canonical?.canonical_summary ?? insightText).toString().trim();

        return {
          headline,
          summary,
          signals: clusterId ? signalsByCluster.get(clusterId) ?? [] : [],
          tags: tagsByInsight.get(insightId) ?? [],
          score,
          timestamp,
        } satisfies FeedCard;
      })
      .filter((c): c is FeedCard => Boolean(c && c.headline && c.summary));

    const nowIso = new Date().toISOString();

    const { error: upsertError } = await supabase
      .from("user_feed_cache")
      .upsert(
        {
          user_id: userId,
          feed,
          updated_at: nowIso,
        },
        { onConflict: "user_id" },
      );

    if (upsertError) {
      throw new Error(`Failed to upsert user_feed_cache: ${upsertError.message}`);
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
