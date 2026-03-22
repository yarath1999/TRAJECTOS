import type { SupabaseClient } from "@supabase/supabase-js";

type DeadLetterRow = {
  id: string;
  event_type?: string | null;
  payload?: unknown;
  retry_after?: string | null;
  retry_count?: number | null;
};

function nowPlusMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

function computeBackoffMinutes(retryCount: unknown): number {
  const n = Number(retryCount);
  const safe = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  return 5 * Math.pow(2, safe);
}

function isUniqueViolation(message: string): boolean {
  const m = (message ?? "").toLowerCase();
  return m.includes("duplicate key value") || m.includes("unique constraint");
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || "Error";
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}

export async function recordPipelineDeadLetter(params: {
  supabase: SupabaseClient;
  id?: string;
  clusterId?: string | null;
  stageName: string;
  err: unknown;
}): Promise<void> {
  const clusterId = (params.clusterId ?? "").toString().trim();

  const row: Record<string, unknown> = {
    cluster_id: clusterId || null,
    stage_name: params.stageName,
    error_message: toErrorMessage(params.err),
  };

  if (params.id) {
    row.id = params.id;
  }

  const { error } = params.id
    ? await params.supabase
        .from("pipeline_dead_letters")
        .upsert(row, { onConflict: "id" })
    : await params.supabase.from("pipeline_dead_letters").insert(row);
  if (error) {
    // Dead-lettering must never stop the pipeline.
    console.error("[pipelineDeadLetterService] failed to record dead letter", {
      stageName: params.stageName,
      clusterId: clusterId || null,
      error: error.message,
    });
  }
}

/**
 * Retries due dead-lettered events by re-inserting them into pipeline_events.
 *
 * Behavior:
 * - Selects up to 50 dead letters where retry_after <= now()
 * - Reinserts { event_type, payload } into pipeline_events
 * - Deletes the dead letter row on success (or if uniqueness indicates it already exists)
 * - On failure, schedules the next retry for now()+5 minutes
 */
export async function runDeadLetterRetry(params: { supabase: SupabaseClient }): Promise<void> {
  const supabase = params.supabase;
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from("pipeline_dead_letters")
    .select("id,event_type,payload,retry_after,retry_count")
    .lte("retry_after", nowIso)
    .order("retry_after", { ascending: true })
    .limit(50);

  if (error) {
    throw new Error(`Failed to load pipeline dead letters: ${error.message}`);
  }

  const rows = (data as DeadLetterRow[] | null) ?? [];
  if (rows.length === 0) return;

  async function scheduleRetry(id: string, currentRetryCount: unknown): Promise<void> {
    const minutes = computeBackoffMinutes(currentRetryCount);
    const nextRetryCount = (() => {
      const n = Number(currentRetryCount);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) + 1 : 1;
    })();

    await supabase
      .from("pipeline_dead_letters")
      .update({
        retry_after: nowPlusMinutes(minutes),
        retry_count: nextRetryCount,
      })
      .eq("id", id);
  }

  for (const row of rows) {
    try {
      let eventType = (row.event_type ?? "").toString().trim();
      let payload = row.payload;

      // Backward-compat for older DLQ rows that only stored id.
      if (!eventType || !payload) {
        const { data: evt, error: evtError } = await supabase
          .from("pipeline_events")
          .select("event_type,payload")
          .eq("id", row.id)
          .maybeSingle();

        if (evtError) {
          throw new Error(`Failed to load original pipeline event: ${evtError.message}`);
        }

        if (evt) {
          eventType = (evt as { event_type?: unknown }).event_type?.toString?.() ?? eventType;
          payload = (evt as { payload?: unknown }).payload ?? payload;
        }
      }

      eventType = (eventType ?? "").toString().trim();
      if (!eventType || !payload) {
        // Not enough data to retry; schedule later.
        await scheduleRetry(row.id, row.retry_count);
        continue;
      }

      const { error: insertError } = await supabase.from("pipeline_events").insert({
        event_type: eventType,
        payload,
      });

      if (insertError) {
        if (isUniqueViolation(insertError.message)) {
          // Already re-enqueued by another worker.
          await supabase.from("pipeline_dead_letters").delete().eq("id", row.id);
          continue;
        }
        throw new Error(`Failed to reinsert pipeline event: ${insertError.message}`);
      }

      await supabase.from("pipeline_dead_letters").delete().eq("id", row.id);
    } catch (err) {
      console.error("[pipelineDeadLetterService] dead-letter retry failed", {
        id: row.id,
        error: toErrorMessage(err),
      });

      // Exponential backoff for transient errors.
      await scheduleRetry(row.id, row.retry_count);
    }
  }
}
