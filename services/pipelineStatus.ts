import "./loadEnv";

import { createSupabaseServerClient } from "./newsFetcher";

type PipelineEventTypeRow = {
  event_type: string | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fmtRate(rate: number): string {
  if (!Number.isFinite(rate)) return "n/a";
  return rate.toFixed(2);
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function fetchCountsByType(totalPendingHint?: number): Promise<Array<{ eventType: string; count: number }>> {
  const supabase = createSupabaseServerClient();

  // supabase-js doesn't expose a portable group-by API for PostgREST.
  // Instead, page through pending rows selecting only event_type and count in-memory.
  const pageSize = 1000;
  const maxRows = Math.max(0, Math.min(50_000, Math.floor(totalPendingHint ?? 50_000)));

  const counts = new Map<string, number>();
  for (let from = 0; from < maxRows; from += pageSize) {
    const to = from + pageSize - 1;

    const { data, error } = await supabase
      .from("pipeline_events")
      .select("event_type")
      .eq("processed", false)
      .range(from, to);

    if (error) {
      throw new Error(`Failed to page pending pipeline_events: ${error.message}`);
    }

    const rows = (data as PipelineEventTypeRow[] | null) ?? [];
    for (const row of rows) {
      const eventType = (row.event_type ?? "unknown").toString().trim() || "unknown";
      counts.set(eventType, (counts.get(eventType) ?? 0) + 1);
    }

    if (rows.length < pageSize) break;
  }

  const out = Array.from(counts.entries()).map(([eventType, count]) => ({ eventType, count }));
  out.sort((a, b) => b.count - a.count || a.eventType.localeCompare(b.eventType));
  return out;
}

async function fetchTotalPending(): Promise<number> {
  const supabase = createSupabaseServerClient();

  const { count, error } = await supabase
    .from("pipeline_events")
    .select("id", { head: true, count: "exact" })
    .eq("processed", false);

  if (error) {
    throw new Error(`Failed to count pending pipeline_events: ${error.message}`);
  }

  return Number(count ?? 0);
}

(async () => {
  const intervalMs = 5000;
  const maxTypes = 25;

  console.log("[pipelineStatus] starting (every 5s)");

  let lastTotal: number | null = null;
  let lastTsMs: number | null = null;

  while (true) {
    const startedMs = Date.now();

    try {
      const total = await fetchTotalPending();
      const byType = await fetchCountsByType(total);

      const nowMs = Date.now();
      let rate: number | null = null;

      if (lastTotal !== null && lastTsMs !== null) {
        const dtSec = (nowMs - lastTsMs) / 1000;
        if (dtSec > 0) {
          // Positive rate means we are draining backlog.
          rate = (lastTotal - total) / dtSec;
        }
      }

      lastTotal = total;
      lastTsMs = nowMs;

      const ts = new Date().toISOString();
      const rateStr = rate === null ? "n/a" : fmtRate(rate);

      console.log(`\n[pipelineStatus] ${ts} pending=${total} rate=${rateStr} events/sec`);

      if (byType.length === 0) {
        console.log("  (no pending events)");
      } else {
        const shown = byType.slice(0, maxTypes);
        const width = shown.reduce((m, r) => Math.max(m, r.eventType.length), 0);
        for (const row of shown) {
          console.log(`  - ${padRight(row.eventType, width)}  ${row.count}`);
        }
        if (byType.length > maxTypes) {
          console.log(`  … (${byType.length - maxTypes} more types)`);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.stack ?? err.message : String(err);
      console.error("[pipelineStatus] tick failed", message);
    }

    const elapsedMs = Date.now() - startedMs;
    await sleep(Math.max(0, intervalMs - elapsedMs));
  }
})().catch((err) => {
  console.error("[pipelineStatus] fatal", err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
