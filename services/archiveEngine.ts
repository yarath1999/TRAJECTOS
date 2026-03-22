import { createSupabaseServerClient } from "./newsFetcher";
import path from "path";
import { fileURLToPath } from "url";

type MacroEventRow = {
  id: string;
  title: string;
  description: string;
  source: string;
  url: string;
  published_at: string;
  ingested_at: string;
  processed: boolean;
  category: string;
  geography: string | null;
  industries: string[] | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function daysAgoIso(days: number): string {
  const ms = Date.now() - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function log(message: string, data?: Record<string, unknown>): void {
  const prefix = `[${new Date().toISOString()}] [archiveEngine]`;
  if (!data) {
    console.log(`${prefix} ${message}`);
    return;
  }
  console.log(`${prefix} ${message}`, data);
}

async function tableExists(table: string): Promise<boolean> {
  const supabase = createSupabaseServerClient();

  // Best-effort probe: select 0 rows.
  const { error } = await supabase.from(table).select("*").limit(1);
  return !error;
}

async function moveMacroEventsBatch(params: {
  sourceTable: string;
  batchSize: number;
  olderThanIso: string;
}): Promise<number> {
  const supabase = createSupabaseServerClient();

  const { data: idsRows, error: idsError } = await supabase
    .from(params.sourceTable)
    .select("id")
    .lt("published_at", params.olderThanIso)
    .order("published_at", { ascending: true })
    .limit(params.batchSize);

  if (idsError) {
    log("failed selecting macro event ids", { table: params.sourceTable, error: idsError.message });
    return 0;
  }

  const ids = ((idsRows as Array<{ id: string }> | null) ?? [])
    .map((r) => (r.id ?? "").toString().trim())
    .filter(Boolean);

  if (ids.length === 0) return 0;

  const { data: rows, error: rowsError } = await supabase
    .from(params.sourceTable)
    .select(
      "id,title,description,source,url,published_at,ingested_at,processed,category,geography,industries",
    )
    .in("id", ids);

  if (rowsError) {
    log("failed loading macro event rows", { table: params.sourceTable, error: rowsError.message });
    return 0;
  }

  const toInsert = ((rows as MacroEventRow[] | null) ?? []).map((r) => ({
    ...r,
    archived_at: new Date().toISOString(),
  }));

  if (toInsert.length === 0) return 0;

  // Idempotent: upsert on primary key id.
  const { error: insertError } = await supabase.from("macro_events_archive").upsert(toInsert, {
    onConflict: "id",
    ignoreDuplicates: true,
  });

  if (insertError) {
    log("failed inserting archive rows", { error: insertError.message });
    return 0;
  }

  const { error: deleteError } = await supabase.from(params.sourceTable).delete().in("id", ids);

  if (deleteError) {
    // Safe to rerun (upsert above is idempotent).
    log("failed deleting source rows after archival", { table: params.sourceTable, error: deleteError.message });
    return 0;
  }

  return ids.length;
}

async function deleteOldRowsBatch(params: {
  table: string;
  timeColumn: string;
  olderThanIso: string;
  batchSize: number;
}): Promise<number> {
  const supabase = createSupabaseServerClient();

  const { data: idsRows, error: idsError } = await supabase
    .from(params.table)
    .select("id")
    .lt(params.timeColumn, params.olderThanIso)
    .order(params.timeColumn, { ascending: true })
    .limit(params.batchSize);

  if (idsError) {
    log("failed selecting ids for deletion", {
      table: params.table,
      error: idsError.message,
    });
    return 0;
  }

  const ids = ((idsRows as Array<{ id: string }> | null) ?? [])
    .map((r) => (r.id ?? "").toString().trim())
    .filter(Boolean);

  if (ids.length === 0) return 0;

  const { error: deleteError } = await supabase.from(params.table).delete().in("id", ids);

  if (deleteError) {
    log("failed deleting old rows", { table: params.table, error: deleteError.message });
    return 0;
  }

  return ids.length;
}

export type ArchiveEngineResult = {
  macroEventsArchived: number;
  pipelineEventsDeleted: number;
  stageRuntimeDeleted: number;
  failuresDeleted: number;
};

/**
 * Runs a single archival pass using bounded batches.
 * Safe to run multiple times.
 */
export async function runArchiveEngineOnce(): Promise<ArchiveEngineResult> {
  const batchSize = envInt("ARCHIVE_BATCH_SIZE", 500);
  const maxBatches = envInt("ARCHIVE_MAX_BATCHES", 50);

  const macroOlderThanIso = daysAgoIso(30);
  const pipelineOlderThanIso = daysAgoIso(7);
  const runtimeOlderThanIso = daysAgoIso(14);
  const failureOlderThanIso = daysAgoIso(30);

  const sourceTable = (await tableExists("macro_events")) ? "macro_events" : "macro_events_raw";

  let macroEventsArchived = 0;
  let pipelineEventsDeleted = 0;
  let stageRuntimeDeleted = 0;
  let failuresDeleted = 0;

  log("starting archival pass", {
    sourceTable,
    batchSize,
    maxBatches,
    macroOlderThanIso,
    pipelineOlderThanIso,
    runtimeOlderThanIso,
    failureOlderThanIso,
  });

  // 1) Archive old macro events.
  for (let i = 0; i < maxBatches; i += 1) {
    const moved = await moveMacroEventsBatch({
      sourceTable,
      batchSize,
      olderThanIso: macroOlderThanIso,
    });
    macroEventsArchived += moved;
    if (moved === 0) break;
    await sleep(100);
  }

  // 2) Delete old pipeline events.
  for (let i = 0; i < maxBatches; i += 1) {
    const deleted = await deleteOldRowsBatch({
      table: "pipeline_events",
      timeColumn: "created_at",
      olderThanIso: pipelineOlderThanIso,
      batchSize,
    });
    pipelineEventsDeleted += deleted;
    if (deleted === 0) break;
    await sleep(50);
  }

  // 3) Delete old stage runtime rows.
  for (let i = 0; i < maxBatches; i += 1) {
    const deleted = await deleteOldRowsBatch({
      table: "pipeline_stage_runtime",
      timeColumn: "end_time",
      olderThanIso: runtimeOlderThanIso,
      batchSize,
    });
    stageRuntimeDeleted += deleted;
    if (deleted === 0) break;
    await sleep(50);
  }

  // 4) Delete old failures.
  for (let i = 0; i < maxBatches; i += 1) {
    const deleted = await deleteOldRowsBatch({
      table: "pipeline_failures",
      timeColumn: "occurred_at",
      olderThanIso: failureOlderThanIso,
      batchSize,
    });
    failuresDeleted += deleted;
    if (deleted === 0) break;
    await sleep(50);
  }

  log("archival pass completed", {
    macroEventsArchived,
    pipelineEventsDeleted,
    stageRuntimeDeleted,
    failuresDeleted,
  });

  return {
    macroEventsArchived,
    pipelineEventsDeleted,
    stageRuntimeDeleted,
    failuresDeleted,
  };
}

export async function runArchiveEngineDaily(): Promise<void> {
  const intervalMs = envInt("ARCHIVE_INTERVAL_MS", 24 * 60 * 60 * 1000);
  log("starting daily scheduler", { intervalMs });

  while (true) {
    try {
      await runArchiveEngineOnce();
    } catch (err) {
      log("archival pass failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await sleep(intervalMs);
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

// Runnable via: npx tsx services/archiveEngine.ts
if (isMainModule()) {
  runArchiveEngineDaily().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
