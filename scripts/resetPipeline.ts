import { loadEnvConfig } from "@next/env";

import { createSupabaseServerClient } from "@/services/newsFetcher";
import type { SupabaseClient } from "@supabase/supabase-js";

loadEnvConfig(process.cwd());

function nowMs(): number {
  return Date.now();
}

type TableSpec = {
  name: string;
  keyColumn: string;
};

const TABLES_TO_CLEAR: TableSpec[] = [
  // Downstream/user-facing tables first
  { name: "insight_user_edges", keyColumn: "user_id" },
  { name: "user_feed_cache", keyColumn: "user_id" },
  { name: "user_feed", keyColumn: "id" },
  { name: "user_relevance_index", keyColumn: "id" },
  { name: "insight_tags", keyColumn: "id" },
  { name: "portfolio_allocations", keyColumn: "id" },
  { name: "event_insights", keyColumn: "id" },
  { name: "portfolio_signals", keyColumn: "id" },
  { name: "event_impact_scores", keyColumn: "id" },
  { name: "event_factor_exposures", keyColumn: "id" },
  // Dependent cluster state
  { name: "event_timelines", keyColumn: "id" },
  // Canonicalization/clustering last because others may FK to clusters
  { name: "canonical_events", keyColumn: "cluster_id" },
  { name: "event_clusters", keyColumn: "id" },
];

async function tableExistsWithClient(
  supabase: SupabaseClient,
  table: string,
  probeColumn: string,
): Promise<boolean> {
  const { error } = await supabase.from(table).select(probeColumn).limit(1);
  return !error;
}

async function countRows(
  supabase: SupabaseClient,
  table: string,
  keyColumn: string,
  filters?: (q: any) => any,
): Promise<number> {
  if (!(await tableExistsWithClient(supabase, table, keyColumn))) {
    return 0;
  }

  const pageSize = 1000;
  let total = 0;

  for (let from = 0; ; from += pageSize) {
    let query = supabase.from(table).select(keyColumn).range(from, from + pageSize - 1);
    if (filters) query = filters(query);

    const { data, error } = await query;
    if (error) {
      throw new Error(`Failed to count ${table}: ${error.message}`);
    }

    const pageCount = (data as unknown[] | null)?.length ?? 0;
    total += pageCount;

    if (pageCount < pageSize) break;
  }

  return total;
}

async function deleteAllRows(supabase: SupabaseClient, table: string, keyColumn: string): Promise<void> {
  if (!(await tableExistsWithClient(supabase, table, keyColumn))) {
    console.warn(`[resetPipeline] Skipping missing table: ${table}`);
    return;
  }

  // PostgREST requires a filter for delete; `NOT IS NULL` on a non-null key is effectively "all rows".
  const { error } = await supabase.from(table).delete().not(keyColumn, "is", null);

  if (error) {
    throw new Error(`Failed to clear ${table}: ${error.message}`);
  }
}

async function resetMacroEventFlags(supabase: SupabaseClient): Promise<void> {
  if (!(await tableExistsWithClient(supabase, "macro_events_raw", "id"))) {
    console.warn("[resetPipeline] macro_events_raw missing; skipping flag reset.");
    return;
  }

  const { error } = await supabase
    .from("macro_events_raw")
    .update({ clustered: false, cluster_id: null })
    .not("id", "is", null);

  if (error) {
    throw new Error(`Failed to reset macro_events_raw flags: ${error.message}`);
  }
}

async function clearPipelineEvents(supabase: SupabaseClient): Promise<void> {
  if (!(await tableExistsWithClient(supabase, "pipeline_events", "id"))) {
    console.warn("[resetPipeline] pipeline_events missing; skipping.");
    return;
  }

  const { error } = await supabase.from("pipeline_events").delete().not("id", "is", null);
  if (error) {
    throw new Error(`Failed to clear pipeline_events: ${error.message}`);
  }
}

async function main(): Promise<void> {
  const started = nowMs();
  const supabase = createSupabaseServerClient();

  console.log("[resetPipeline] Starting pipeline reset...");
  console.log("[resetPipeline] NOTE: Does NOT delete event_queue or macro_events_raw rows.");

  // Pre-counts (best-effort; missing tables count as 0)
  const before: Record<string, number> = {};
  for (const t of TABLES_TO_CLEAR) {
    before[t.name] = await countRows(supabase, t.name, t.keyColumn);
  }

  const pipelineEventsBefore = await countRows(supabase, "pipeline_events", "id");
  const flaggedBefore = await countRows(supabase, "macro_events_raw", "id", (q) =>
    q.or("clustered.eq.true,cluster_id.not.is.null"),
  );

  // Clear state tables
  for (const t of TABLES_TO_CLEAR) {
    await deleteAllRows(supabase, t.name, t.keyColumn);
  }

  // Reset flags and clear pipeline events
  await resetMacroEventFlags(supabase);
  await clearPipelineEvents(supabase);

  // Post-counts
  const after: Record<string, number> = {};
  for (const t of TABLES_TO_CLEAR) {
    after[t.name] = await countRows(supabase, t.name, t.keyColumn);
  }

  const pipelineEventsAfter = await countRows(supabase, "pipeline_events", "id");
  const flaggedAfter = await countRows(supabase, "macro_events_raw", "id", (q) =>
    q.or("clustered.eq.true,cluster_id.not.is.null"),
  );

  console.log("\n[resetPipeline] Reset summary:");
  for (const t of TABLES_TO_CLEAR) {
    const b = before[t.name] ?? 0;
    const a = after[t.name] ?? 0;
    console.log(`- ${t.name}: ${b} -> ${a}`);
  }
  console.log(`- pipeline_events: ${pipelineEventsBefore} -> ${pipelineEventsAfter}`);
  console.log(`- macro_events_raw flagged (clustered=true or cluster_id set): ${flaggedBefore} -> ${flaggedAfter}`);

  console.log(`\n[resetPipeline] Done in ${nowMs() - started}ms.`);
}

main().catch((err: unknown) => {
  console.error("[resetPipeline] Failed:", err);
  process.exitCode = 1;
});
