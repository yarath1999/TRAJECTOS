import { createSupabaseServerClient } from "./newsFetcher";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type CountResult = { ok: true; count: number } | { ok: false; error: string };

async function countExact(table: string, filters?: (q: any) => any): Promise<CountResult> {
  const supabase = createSupabaseServerClient();

  let query = supabase.from(table).select("id", { head: true, count: "exact" });
  if (filters) query = filters(query);

  const { count, error } = await query;

  if (error) return { ok: false, error: error.message };
  return { ok: true, count: count ?? 0 };
}

async function tick(): Promise<void> {
  // If any critical count fails, skip this tick to avoid false positives.
  const events = await countExact("macro_events_raw");
  const clusters = await countExact("event_clusters");
  const canon = await countExact("canonical_events");
  const validated = await countExact("event_clusters", (q) => q.eq("validated", true));

  const failed = [events, clusters, canon, validated].find((r) => !r.ok) as
    | { ok: false; error: string }
    | undefined;

  if (failed) {
    console.warn(`[pipelineInvariantMonitor] count failed; skipping tick (${failed.error})`);
    return;
  }

  const eventCount = (events as { ok: true; count: number }).count;
  const clusterCount = (clusters as { ok: true; count: number }).count;
  const canonicalCount = (canon as { ok: true; count: number }).count;
  const validatedClusterCount = (validated as { ok: true; count: number }).count;

  if (eventCount > 100 && clusterCount === 0) {
    console.error(
      "Pipeline invariant violated: events exist but clustering produced zero clusters.",
    );
  }

  if (clusterCount > 0 && canonicalCount === 0) {
    console.warn("Pipeline stalled after clustering.");
  }

  if (canonicalCount > 0 && validatedClusterCount === 0) {
    console.warn("Pipeline stalled before validation.");
  }
}

/**
 * Periodically checks simple pipeline invariants and logs warnings.
 *
 * This monitor is read-only and must never mutate pipeline state.
 */
export async function runPipelineInvariantMonitor(): Promise<void> {
  console.log("[pipelineInvariantMonitor] starting");

  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error("[pipelineInvariantMonitor] tick failed", err);
    }

    await sleep(60_000);
  }
}
