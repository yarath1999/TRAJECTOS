import { createWriteStream } from "fs";
import { mkdir, rename } from "fs/promises";
import path from "path";

import { createSupabaseServerClient } from "./newsFetcher";

type TableBackupSpec = {
  table: string;
  orderBy: string;
};

const CRITICAL_TABLES: TableBackupSpec[] = [
  { table: "macro_events_raw", orderBy: "id" },
  { table: "event_clusters", orderBy: "id" },
  { table: "event_insights", orderBy: "id" },
  { table: "portfolio_signals", orderBy: "id" },
  { table: "user_feed", orderBy: "id" },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timestampForFilename(d: Date): string {
  // Example: 2026-03-14T12-34-56Z
  return d.toISOString().replace(/[:.]/g, "-");
}

async function waitForDrain(stream: NodeJS.WritableStream): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.once("drain", resolve);
    stream.once("error", reject);
  });
}

async function writeChunk(stream: NodeJS.WritableStream, chunk: string): Promise<void> {
  const ok = stream.write(chunk);
  if (!ok) {
    await waitForDrain(stream);
  }
}

async function streamTableToJsonFile(params: {
  table: string;
  orderBy: string;
  outDir: string;
  timestamp: string;
  pageSize?: number;
}): Promise<{ filePath: string; rowCount: number } | null> {
  const supabase = createSupabaseServerClient();
  const pageSize = params.pageSize ?? 1000;

  // Best-effort existence check (some environments may not have all tables).
  const probe = await supabase.from(params.table).select(params.orderBy).limit(1);
  if (probe.error) {
    console.warn(`[backupService] Skipping missing/unreadable table: ${params.table} (${probe.error.message})`);
    return null;
  }

  const baseName = `${params.table}_${params.timestamp}.json`;
  const finalPath = path.join(params.outDir, baseName);
  const tmpPath = `${finalPath}.tmp`;

  const stream = createWriteStream(tmpPath, { encoding: "utf8" });

  let wroteAny = false;
  let total = 0;

  try {
    await writeChunk(stream, "[\n");

    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from(params.table)
        .select("*")
        .order(params.orderBy, { ascending: true })
        .range(from, from + pageSize - 1);

      if (error) {
        console.warn(`[backupService] Failed to export ${params.table}: ${error.message}`);
        break;
      }

      const rows = (data as unknown[] | null) ?? [];
      for (const row of rows) {
        const json = JSON.stringify(row);
        if (wroteAny) {
          await writeChunk(stream, ",\n");
        }
        await writeChunk(stream, json);
        wroteAny = true;
        total += 1;
      }

      if (rows.length < pageSize) break;
    }

    await writeChunk(stream, "\n]\n");

    await new Promise<void>((resolve, reject) => {
      stream.end(() => resolve());
      stream.once("error", reject);
    });

    await rename(tmpPath, finalPath);
    return { filePath: finalPath, rowCount: total };
  } catch (err) {
    console.error(`[backupService] Export failed for ${params.table}`, err);

    // Best-effort: attempt to close stream; leaving tmp file is acceptable.
    try {
      stream.end();
    } catch {
      // ignore
    }

    return null;
  }
}

export async function runBackupOnce(): Promise<void> {
  const started = Date.now();
  const timestamp = timestampForFilename(new Date());
  const outDir = path.resolve(process.cwd(), "backups");

  try {
    await mkdir(outDir, { recursive: true });
  } catch (err) {
    console.error("[backupService] Failed to create backups directory", err);
    return;
  }

  const results: Array<{ table: string; rows: number } > = [];

  for (const spec of CRITICAL_TABLES) {
    try {
      const result = await streamTableToJsonFile({
        table: spec.table,
        orderBy: spec.orderBy,
        outDir,
        timestamp,
      });

      if (result) {
        results.push({ table: spec.table, rows: result.rowCount });
        console.log(`[backupService] Wrote ${spec.table} rows=${result.rowCount} -> ${path.basename(result.filePath)}`);
      }
    } catch (err) {
      // Backups are best-effort and must not take down any long-running process.
      console.error(`[backupService] Table backup failed: ${spec.table}`, err);
    }
  }

  const tookMs = Date.now() - started;
  console.log(
    `[backupService] Snapshot complete tables=${results.length}/${CRITICAL_TABLES.length} took_ms=${tookMs}`,
  );
}

/**
 * Runs the backup snapshot loop.
 *
 * Intended to be run as a separate background process.
 * Backups are best-effort and should never block the main pipeline.
 */
export async function runBackupService(): Promise<void> {
  console.log("[backupService] starting");

  // Run once on startup.
  try {
    await runBackupOnce();
  } catch (err) {
    console.error("[backupService] initial snapshot failed", err);
  }

  while (true) {
    await sleep(12 * 60 * 60 * 1000);

    try {
      await runBackupOnce();
    } catch (err) {
      console.error("[backupService] snapshot failed", err);
    }
  }
}

/**
 * Starts the backup loop on a timer and returns immediately.
 *
 * This is suitable for running alongside the main pipeline in the same process
 * without blocking it.
 */
export function startBackupService(): void {
  console.log("[backupService] starting (timer mode)");

  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runBackupOnce();
    } catch (err) {
      console.error("[backupService] snapshot failed", err);
    } finally {
      running = false;
    }
  };

  // Fire and forget.
  void run();
  setInterval(() => {
    void run();
  }, 12 * 60 * 60 * 1000);
}
