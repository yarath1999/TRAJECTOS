import { createSupabaseServerClient } from "./newsFetcher";
import { emitClusterEventOnce } from "./pipelineEventUtils";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

type ClusterRow = {
  id: string;
  created_at?: string | null;
};

async function getPipelineBacklogSize(): Promise<number> {
  const supabase = createSupabaseServerClient();
  const { count, error } = await supabase
    .from("pipeline_events")
    .select("id", { head: true, count: "exact" })
    .eq("processed", false);

  if (error) return 0;
  return count ?? 0;
}

async function listStuckUnvalidatedClusters(cutoffIso: string, limit = 100): Promise<string[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("event_clusters")
    .select("id")
    .eq("validated", false)
    .lt("created_at", cutoffIso)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) return [];
  const rows = (data as ClusterRow[] | null) ?? [];
  return rows.map((r) => (r.id ?? "").toString().trim()).filter(Boolean);
}

async function listValidatedClustersMissingFactors(cutoffIso: string, limit = 100): Promise<string[]> {
  const supabase = createSupabaseServerClient();

  // Validated clusters that still have no factor exposures.
  const { data, error } = await supabase
    .from("event_clusters")
    .select("id,event_factor_exposures!left(id)")
    .eq("validated", true)
    .lt("created_at", cutoffIso)
    .is("event_factor_exposures.id", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) return [];
  const rows = (data as Array<ClusterRow & { event_factor_exposures?: unknown }> | null) ?? [];
  return rows.map((r) => (r.id ?? "").toString().trim()).filter(Boolean);
}

async function listValidatedClustersMissingImpacts(cutoffIso: string, limit = 100): Promise<string[]> {
  const supabase = createSupabaseServerClient();

  // Validated clusters that still have no impact scores.
  const { data, error } = await supabase
    .from("event_clusters")
    .select("id,event_impact_scores!left(id)")
    .eq("validated", true)
    .lt("created_at", cutoffIso)
    .is("event_impact_scores.id", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) return [];
  const rows = (data as Array<ClusterRow & { event_impact_scores?: unknown }> | null) ?? [];
  return rows.map((r) => (r.id ?? "").toString().trim()).filter(Boolean);
}

async function tick(): Promise<void> {
  const backlog = await getPipelineBacklogSize();

  const cutoffIso = minutesAgoIso(10);
  const stuckUnvalidated = await listStuckUnvalidatedClusters(cutoffIso, 200);

  // "Stuck after factor/impact" is interpreted as: validated clusters that have not produced
  // factor exposures and/or impact scores after enough time has passed.
  const missingFactors = await listValidatedClustersMissingFactors(cutoffIso, 200);
  const missingImpacts = await listValidatedClustersMissingImpacts(cutoffIso, 200);

  const hasBacklogWarning = backlog > 1000;
  const hasStuckWarning =
    stuckUnvalidated.length > 0 || missingFactors.length > 0 || missingImpacts.length > 0;

  if (hasBacklogWarning || hasStuckWarning) {
    console.warn(
      `[pipelineWatchdog] WARNING: backlog=${backlog} stuck_unvalidated=${stuckUnvalidated.length} missing_factors=${missingFactors.length} missing_impacts=${missingImpacts.length}`,
    );
  } else {
    console.log(`[pipelineWatchdog] ok backlog=${backlog}`);
  }

  // Recovery strategy:
  // - Unvalidated > 10m: re-emit CLUSTER_CREATED (kicks validation/orchestration)
  // - Validated but missing factor/impact: re-emit CLUSTER_VALIDATED
  // This service must not mutate other tables.
  const supabase = createSupabaseServerClient();

  for (const clusterId of stuckUnvalidated.slice(0, 100)) {
    await emitClusterEventOnce({
      supabase,
      eventType: "CLUSTER_CREATED",
      clusterId,
    });
  }

  const validatedRecoveryTargets = new Set<string>([...missingFactors, ...missingImpacts]);
  for (const clusterId of Array.from(validatedRecoveryTargets).slice(0, 100)) {
    await emitClusterEventOnce({
      supabase,
      eventType: "CLUSTER_VALIDATED",
      clusterId,
    });
  }
}

/**
 * Watches pipeline health and attempts self-healing by re-emitting pipeline events.
 *
 * - Runs every 60 seconds
 * - Never modifies data directly other than emitting recovery events to pipeline_events
 */
export async function runPipelineWatchdog(): Promise<void> {
  console.log("[pipelineWatchdog] starting");

  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error("[pipelineWatchdog] tick failed", err);
    }

    await sleep(60_000);
  }
}

// Exposed for tests/scripts.
export async function runPipelineWatchdogOnce(): Promise<void> {
  await tick();
}
