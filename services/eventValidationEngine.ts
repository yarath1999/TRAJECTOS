import { createSupabaseServerClient } from "./newsFetcher";

type ClusterRow = {
  id: string;
};

function clamp(min: number, value: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function getArticleCount(supabase: ReturnType<typeof createSupabaseServerClient>, clusterId: string): Promise<number> {
  const { count, error } = await supabase
    .from("macro_events_raw")
    .select("id", { count: "exact", head: true })
    .eq("cluster_id", clusterId);

  if (error) {
    throw new Error(`Failed to count articles: ${error.message}`);
  }

  return count ?? 0;
}

async function getSourceDiversity(supabase: ReturnType<typeof createSupabaseServerClient>, clusterId: string): Promise<number> {
  const { data, error } = await supabase
    .from("macro_events_raw")
    .select("source")
    .eq("cluster_id", clusterId)
    .limit(200);

  if (error) {
    throw new Error(`Failed to load sources: ${error.message}`);
  }

  const sources = new Set<string>();
  for (const row of (data as Array<{ source: string | null }> | null) ?? []) {
    const s = (row.source ?? "").toString().trim();
    if (s) sources.add(s);
  }

  return sources.size;
}

async function getTimeSpreadMs(
  supabase: ReturnType<typeof createSupabaseServerClient>,
  clusterId: string,
): Promise<number> {
  const { data: earliest, error: earliestError } = await supabase
    .from("macro_events_raw")
    .select("published_at")
    .eq("cluster_id", clusterId)
    .order("published_at", { ascending: true })
    .limit(1);

  if (earliestError) {
    throw new Error(`Failed to load earliest published_at: ${earliestError.message}`);
  }

  const { data: latest, error: latestError } = await supabase
    .from("macro_events_raw")
    .select("published_at")
    .eq("cluster_id", clusterId)
    .order("published_at", { ascending: false })
    .limit(1);

  if (latestError) {
    throw new Error(`Failed to load latest published_at: ${latestError.message}`);
  }

  const minIso = (earliest?.[0] as { published_at?: string | null } | undefined)
    ?.published_at;
  const maxIso = (latest?.[0] as { published_at?: string | null } | undefined)
    ?.published_at;

  const minMs = minIso ? Date.parse(minIso) : NaN;
  const maxMs = maxIso ? Date.parse(maxIso) : NaN;

  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs)) return 0;
  return Math.max(0, maxMs - minMs);
}

function computeValidationScore(params: {
  articleCount: number;
  sourceDiversity: number;
  timeSpreadMs: number;
}): number {
  let score = 0;

  if (params.articleCount >= 5) score += 0.4;
  if (params.sourceDiversity >= 3) score += 0.4;
  if (params.timeSpreadMs >= 60 * 60 * 1000) score += 0.2;

  return clamp(0, score, 1);
}

export async function runEventValidationEngine(): Promise<void> {
  const supabase = createSupabaseServerClient();

  const { data: clusters, error: clustersError } = await supabase
    .from("event_clusters")
    .select("id")
    .eq("validated", false)
    .limit(20);

  if (clustersError) {
    throw new Error(`Failed to load clusters to validate: ${clustersError.message}`);
  }

  const clusterRows = (clusters as ClusterRow[] | null) ?? [];
  if (clusterRows.length === 0) return;

  for (const cluster of clusterRows) {
    const clusterId = (cluster.id ?? "").toString().trim();
    if (!clusterId) continue;

    const articleCount = await getArticleCount(supabase, clusterId);
    const sourceDiversity = await getSourceDiversity(supabase, clusterId);
    const timeSpreadMs = await getTimeSpreadMs(supabase, clusterId);

    const validationScore = computeValidationScore({
      articleCount,
      sourceDiversity,
      timeSpreadMs,
    });

    const validated = validationScore >= 0.6;

    const { error: updateError } = await supabase
      .from("event_clusters")
      .update({
        validated,
        validation_score: validationScore,
      })
      .eq("id", clusterId);

    if (updateError) {
      throw new Error(
        `Failed to update validation status: ${updateError.message} (cluster_id=${clusterId})`,
      );
    }
  }
}
