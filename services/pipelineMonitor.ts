import { createSupabaseServerClient } from "./newsFetcher";
import { fileURLToPath } from "url";
import path from "path";

type StageAggregate = {
  stage: string;
  processed: number;
  failed: number;
  skipped: number;
  avgDurationMs: number;
};

type RuntimeRow = {
  stage_name: string | null;
  duration_ms: number | null;
  status: string | null;
};

type FailureRow = {
  stage_name: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function minuteBucketIso(date: Date): string {
  const ms = date.getTime();
  const bucketMs = Math.floor(ms / 60_000) * 60_000;
  return new Date(bucketMs).toISOString();
}

async function fetchRuntimeRows(sinceIso: string): Promise<RuntimeRow[]> {
  const supabase = createSupabaseServerClient();
  const pageSize = 1000;
  const maxRows = 5000;

  const out: RuntimeRow[] = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const { data, error } = await supabase
      .from("pipeline_stage_runtime")
      .select("stage_name,duration_ms,status")
      .gte("end_time", sinceIso)
      .order("end_time", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) throw new Error(`Failed to query pipeline_stage_runtime: ${error.message}`);

    const rows = (data as RuntimeRow[] | null) ?? [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }

  return out;
}

async function fetchFailureRows(sinceIso: string): Promise<FailureRow[]> {
  const supabase = createSupabaseServerClient();
  const pageSize = 1000;
  const maxRows = 5000;

  const out: FailureRow[] = [];
  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const { data, error } = await supabase
      .from("pipeline_failures")
      .select("stage_name")
      .gte("occurred_at", sinceIso)
      .order("occurred_at", { ascending: true })
      .range(offset, offset + pageSize - 1);

    if (error) throw new Error(`Failed to query pipeline_failures: ${error.message}`);

    const rows = (data as FailureRow[] | null) ?? [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }

  return out;
}

async function getBacklogSize(): Promise<number> {
  const supabase = createSupabaseServerClient();
  const { count, error } = await supabase
    .from("pipeline_events")
    .select("id", { head: true, count: "exact" })
    .eq("processed", false);

  if (error) {
    // Observability should be best-effort.
    return 0;
  }

  return count ?? 0;
}

function aggregateStages(runtimeRows: RuntimeRow[], failureRows: FailureRow[]): StageAggregate[] {
  const byStage = new Map<
    string,
    { processed: number; failed: number; skipped: number; durationSum: number; durationCount: number; failureCount: number }
  >();

  for (const row of runtimeRows) {
    const stage = (row.stage_name ?? "").toString().trim() || "unknown";
    const status = (row.status ?? "").toString().trim().toLowerCase();
    const duration = Number(row.duration_ms);

    const entry =
      byStage.get(stage) ??
      {
        processed: 0,
        failed: 0,
        skipped: 0,
        durationSum: 0,
        durationCount: 0,
        failureCount: 0,
      };

    if (status === "failure") entry.failed += 1;
    else if (status === "skipped") entry.skipped += 1;
    else entry.processed += 1;

    if (Number.isFinite(duration) && duration >= 0) {
      entry.durationSum += duration;
      entry.durationCount += 1;
    }

    byStage.set(stage, entry);
  }

  for (const row of failureRows) {
    const stage = (row.stage_name ?? "").toString().trim() || "unknown";
    const entry =
      byStage.get(stage) ??
      {
        processed: 0,
        failed: 0,
        skipped: 0,
        durationSum: 0,
        durationCount: 0,
        failureCount: 0,
      };

    entry.failureCount += 1;
    byStage.set(stage, entry);
  }

  const aggregates: StageAggregate[] = [];
  for (const [stage, v] of byStage.entries()) {
    aggregates.push({
      stage,
      processed: v.processed,
      failed: v.failed,
      skipped: v.skipped,
      avgDurationMs: v.durationCount ? v.durationSum / v.durationCount : 0,
    });
  }

  aggregates.sort((a, b) => {
    const aTotal = a.processed + a.failed + a.skipped;
    const bTotal = b.processed + b.failed + b.skipped;
    return bTotal - aTotal;
  });

  return aggregates;
}

async function writeMetricsSnapshot(windowStartIso: string, backlogSize: number, stages: StageAggregate[]): Promise<void> {
  const supabase = createSupabaseServerClient();

  const rows = stages.length
    ? stages.map((s) => ({
        window_start: windowStartIso,
        stage_name: s.stage,
        processed_count: s.processed,
        avg_duration_ms: Number.isFinite(s.avgDurationMs) ? s.avgDurationMs : null,
        failure_count: s.failed,
        backlog_size: backlogSize,
      }))
    : [
        {
          window_start: windowStartIso,
          stage_name: "pipeline_overall",
          processed_count: 0,
          avg_duration_ms: null,
          failure_count: 0,
          backlog_size: backlogSize,
        },
      ];

  const { error } = await supabase.from("pipeline_metrics").upsert(rows, {
    onConflict: "window_start,stage_name",
  });

  if (error) {
    return;
  }
}

function printHealthSummary(windowStartIso: string, backlogSize: number, stages: StageAggregate[]): void {
  const totalProcessed = stages.reduce((sum, s) => sum + s.processed, 0);
  const totalFailed = stages.reduce((sum, s) => sum + s.failed, 0);
  const totalSkipped = stages.reduce((sum, s) => sum + s.skipped, 0);

  console.log(
    `[pipelineMonitor] ${windowStartIso} backlog=${backlogSize} processed=${totalProcessed} failed=${totalFailed} skipped=${totalSkipped}`,
  );

  for (const s of stages.slice(0, 10)) {
    console.log(
      `  - ${s.stage}: processed=${s.processed} failed=${s.failed} skipped=${s.skipped} avg_ms=${Math.round(s.avgDurationMs)}`,
    );
  }
}

async function tick(): Promise<void> {
  const now = new Date();
  const windowStartIso = minuteBucketIso(now);
  const sinceIso = new Date(now.getTime() - 60_000).toISOString();

  const backlogSize = await getBacklogSize();

  const runtimeRows = await fetchRuntimeRows(sinceIso);
  const failureRows = await fetchFailureRows(sinceIso);

  const stages = aggregateStages(runtimeRows, failureRows);

  await writeMetricsSnapshot(windowStartIso, backlogSize, stages);
  printHealthSummary(windowStartIso, backlogSize, stages);
}

/**
 * Aggregates pipeline observability tables and prints a health summary every minute.
 *
 * This is additive: it does not affect pipeline execution.
 */
export async function runPipelineMonitor(): Promise<void> {
  console.log("[pipelineMonitor] starting");

  while (true) {
    try {
      await tick();
    } catch (err) {
      console.error("[pipelineMonitor] tick failed", err);
    }

    await sleep(60_000);
  }
}

function isMainModule(): boolean {
  try {
    const current = fileURLToPath(import.meta.url);
    const invoked = process.argv[1] ?? "";
    const invokedAbs = path.resolve(process.cwd(), invoked);
    return path.normalize(invokedAbs).toLowerCase() === path.normalize(current).toLowerCase();
  } catch {
    return false;
  }
}

// If executed directly via tsx/node.
if (isMainModule()) {
  runPipelineMonitor().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
