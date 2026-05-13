import { createHash } from "node:crypto";
import { createWorkerRunId } from "../utils/performanceTracker";
import { logEvent } from "../utils/logger";
import { createSupabaseServerClient } from "./newsFetcher";
import { generateClusterKey } from "@/lib/clusterKey";
import { extractEntities } from "@/lib/extractEntities";

type QueuedEvent = {
  id: string;
  title: string | null;
  description: string | null;
  source: string | null;
  url: string | null;
  category: string | null;
  geography: string | null;
  industries: string[] | null;
  entities?: string[] | null;
  published_at: string | null;
  processed: boolean | null;
};

function stableId(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizeDescription(value: unknown): string {
  return (typeof value === "string" ? value : "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function computeFingerprint(title: string, description: string): string {
  const t = title.trim();
  const d = normalizeDescription(description);
  return createHash("sha256").update(`${t}${d}`).digest("hex");
}

async function shouldInsertByFingerprint(params: {
  supabase: ReturnType<typeof createSupabaseServerClient>;
  fingerprint: string;
}): Promise<boolean> {
  const nowIso = new Date().toISOString();

  // First try to insert a new fingerprint (fast path).
  const { data: inserted, error: insertError } = await params.supabase
    .from("event_fingerprints")
    .upsert(
      {
        fingerprint: params.fingerprint,
        first_seen_at: nowIso,
        last_seen_at: nowIso,
      },
      {
        onConflict: "fingerprint",
        ignoreDuplicates: true,
      },
    )
    .select("fingerprint");

  if (insertError) {
    // Dedup must never block ingestion; if we can't check, insert normally.
    return true;
  }

  if ((inserted ?? []).length > 0) {
    return true;
  }

  // Fingerprint exists; only allow insert if it's older than 24 hours.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: updated, error: updateError } = await params.supabase
    .from("event_fingerprints")
    .update({ last_seen_at: nowIso })
    .eq("fingerprint", params.fingerprint)
    .lt("last_seen_at", cutoff)
    .select("fingerprint");

  if (updateError) {
    return true;
  }

  if ((updated ?? []).length > 0) {
    return true;
  }

  // Within 24h: best-effort bump last_seen_at for observability.
  await params.supabase
    .from("event_fingerprints")
    .update({ last_seen_at: nowIso })
    .eq("fingerprint", params.fingerprint);

  return false;
}

function toEpochMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isFinite(ms)) return ms;
  }

  return Date.now();
}

export async function processEventQueue(): Promise<void> {
  const runId = createWorkerRunId("event-queue");
  logEvent("EVENT_QUEUE_RUN_START", { run_id: runId }, "INFO");

  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from("event_queue")
    .select(
      "id,title,description,source,url,category,geography,industries,entities,published_at,processed",
    )
    .eq("processed", false)
    .limit(50);

  if (error) {
    throw new Error(`Failed to load event_queue: ${error.message}`);
  }

  if (!data?.length) {
    logEvent("EVENT_QUEUE_RUN_COMPLETE", { run_id: runId, processed: 0 }, "INFO");
    return;
  }

  let processed = 0;

  for (const event of data as QueuedEvent[]) {
    if (!event.url || !event.title || !event.description || !event.source) {
      await supabase
        .from("event_queue")
        .update({ processed: true })
        .eq("id", event.id);
      continue;
    }

    const fingerprint = computeFingerprint(event.title, event.description);
    const shouldInsert = await shouldInsertByFingerprint({ supabase, fingerprint });
    if (!shouldInsert) {
      await supabase.from("event_queue").update({ processed: true }).eq("id", event.id);
      continue;
    }

    const clusterKey = generateClusterKey(event.title);

    const entities = Array.isArray(event.entities)
      ? event.entities
      : extractEntities(`${event.title} ${event.description}`);

    const timestamp = toEpochMs(event.published_at);
    const id = stableId(
      `${event.source}::${event.title}::${event.url}::${timestamp}`,
    );

    const { error: upsertError } = await supabase.from("macro_events_raw").upsert(
      {
        id,
        title: event.title,
        description: event.description,
        source: event.source,
        url: event.url,
        published_at: new Date(timestamp).toISOString(),
        processed: false,
        category: (event.category ?? "unknown").toString(),
        geography: event.geography,
        industries: event.industries,
        cluster_key: clusterKey,
        entities,
      },
      { onConflict: "url" },
    );

    if (upsertError) {
      throw new Error(`Failed to upsert macro_events_raw: ${upsertError.message}`);
    }

    const { error: markError } = await supabase
      .from("event_queue")
      .update({ processed: true })
      .eq("id", event.id);

    if (markError) {
      throw new Error(`Failed to mark queue processed: ${markError.message}`);
    }

    processed += 1;
  }

  logEvent("EVENT_QUEUE_RUN_COMPLETE", { run_id: runId, processed }, "INFO");
}
