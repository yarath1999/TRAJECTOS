import "./loadEnv";
import { createSupabaseServerClient } from "./newsFetcher";
import { recordPipelineDeadLetter } from "./pipelineDeadLetterService";
import type { SupabaseClient } from "@supabase/supabase-js";

type PipelineEventRow = {
  id: string;
  event_type: string;
  payload: unknown;
  created_at?: string;
};

type OrchestratorOptions = {
  batchSize?: number;
  maxPasses?: number;
};

const ORCHESTRATOR_EVENT_TYPES = [
  // Primary chain
  "CLUSTER_CREATED",
  "CLUSTER_VALIDATED",
  "FACTOR_COMPLETED",
  "IMPACT_COMPLETED",
  "SIGNAL_COMPLETED",
  "INSIGHT_COMPLETED",
  "ALLOCATION_COMPLETED",

  // Backward compatibility (treated as completion -> next required)
  "VALIDATION_COMPLETED",
  "FACTOR_CREATED",
  "IMPACT_CREATED",
  "SIGNAL_CREATED",
  "INSIGHT_CREATED",
  "ALLOCATION_CREATED",
] as const;

type JsonObject = Record<string, unknown>;

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || "Error";
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}

async function deadLetterEvent(
  supabase: SupabaseClient,
  evt: PipelineEventRow,
  err: unknown,
): Promise<void> {
  const clusterId = extractClusterIdFromPayload(evt.payload);

  // Best-effort: dead-letter should not crash the orchestrator.
  await recordPipelineDeadLetter({
    supabase,
    id: evt.id,
    clusterId,
    stageName: "orchestrator",
    err,
  });

  // Mark as processed so the pipeline won't get stuck on a poisoned event.
  const { error: markError } = await supabase
    .from("pipeline_events")
    .update({ processed: true })
    .eq("id", evt.id)
    .eq("processed", false);

  if (markError) {
    // If we can't mark processed, the event will keep retrying and continue to block.
    throw new Error(`Failed to mark dead-lettered event processed: ${markError.message}`);
  }
}

async function incrementRetryCount(supabase: SupabaseClient, eventId: string): Promise<number> {
  const { data, error: loadError } = await supabase
    .from("pipeline_events")
    .select("retry_count")
    .eq("id", eventId)
    .maybeSingle();

  if (loadError) {
    throw new Error(`Failed to load retry_count for pipeline event: ${loadError.message}`);
  }

  const current = Number((data as { retry_count?: unknown } | null)?.retry_count ?? 0);
  const next = Number.isFinite(current) ? current + 1 : 1;

  const { error: updateError } = await supabase
    .from("pipeline_events")
    .update({ retry_count: next })
    .eq("id", eventId)
    .eq("processed", false);

  if (updateError) {
    throw new Error(`Failed to update retry_count for pipeline event: ${updateError.message}`);
  }

  return next;
}

async function handleEventFailureWithRetries(
  supabase: SupabaseClient,
  evt: PipelineEventRow,
  err: unknown,
): Promise<void> {
  const retryCount = await incrementRetryCount(supabase, evt.id);

  // "More than 3 times" => dead-letter on the 4th failure.
  if (retryCount > 3) {
    console.error(
      "[pipelineOrchestrator] event exceeded retry limit; dead-lettering",
      {
        eventId: evt.id,
        eventType: evt.event_type,
        retryCount,
        message: toErrorMessage(err),
      },
    );
    await deadLetterEvent(supabase, evt, err);
    return;
  }

  console.warn("[pipelineOrchestrator] event failed; will retry", {
    eventId: evt.id,
    eventType: evt.event_type,
    retryCount,
    message: toErrorMessage(err),
  });
}

function extractClusterIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const clusterId = (payload as { cluster_id?: unknown }).cluster_id;
  if (typeof clusterId !== "string" && typeof clusterId !== "number") return null;
  const trimmed = clusterId.toString().trim();
  return trimmed ? trimmed : null;
}

async function markEventProcessed(supabase: SupabaseClient, id: string): Promise<void> {
  const { error } = await supabase
    .from("pipeline_events")
    .update({ processed: true })
    .eq("id", id)
    .eq("processed", false);

  if (error) {
    throw new Error(`Failed to mark pipeline event processed: ${error.message}`);
  }
}

function extractClusterIdFromJsonObject(payload: JsonObject): string | null {
  const clusterId = payload.cluster_id;
  if (typeof clusterId !== "string" && typeof clusterId !== "number") return null;
  const trimmed = clusterId.toString().trim();
  return trimmed ? trimmed : null;
}

async function ensureEvent(
  supabase: SupabaseClient,
  eventType: string,
  payload: JsonObject,
): Promise<void> {
  const clusterId = extractClusterIdFromJsonObject(payload);
  if (!clusterId) {
    throw new Error(
      `ensureEvent(${eventType}) requires payload.cluster_id for deduplication`,
    );
  }

  const { data: existing, error: existingError } = await supabase
    .from("pipeline_events")
    .select("id")
    .eq("event_type", eventType)
    .eq("processed", false)
    .eq("payload->>cluster_id", clusterId)
    .limit(1);

  if (existingError) {
    throw new Error(`Failed to check existing ${eventType} events: ${existingError.message}`);
  }

  if ((existing ?? []).length > 0) return;

  const { error } = await supabase.from("pipeline_events").insert({
    event_type: eventType,
    payload,
  });

  if (error) {
    throw new Error(`Failed to emit ${eventType} event: ${error.message}`);
  }
}

async function handleEvent(supabase: SupabaseClient, evt: PipelineEventRow): Promise<void> {
  const type = (evt.event_type ?? "").toString().trim();
  const clusterId = extractClusterIdFromPayload(evt.payload);

  // Dependency graph (required):
  // CLUSTER_CREATED
  // → VALIDATION_REQUIRED
  // → CLUSTER_VALIDATED
  // → FACTOR_REQUIRED
  // → FACTOR_COMPLETED
  // → IMPACT_REQUIRED
  // → IMPACT_COMPLETED
  // → SIGNAL_REQUIRED
  // → SIGNAL_COMPLETED
  // → INSIGHT_REQUIRED
  // → INSIGHT_COMPLETED
  // → ALLOCATION_REQUIRED
  // → ALLOCATION_COMPLETED
  switch (type) {
    // Pure event-driven orchestration:
    // - Orchestrator emits next-stage events
    // - Workers consume *_REQUIRED events and emit *_COMPLETED events
    case "VALIDATION_REQUIRED":
    case "FACTOR_REQUIRED":
    case "IMPACT_REQUIRED":
    case "SIGNAL_REQUIRED":
    case "INSIGHT_REQUIRED":
    case "ALLOCATION_REQUIRED": {
      // Handled by engine workers; orchestrator must not mark processed.
      return;
    }

    case "CLUSTER_CREATED": {
      if (!clusterId) {
        await markEventProcessed(supabase, evt.id);
        return;
      }

      await ensureEvent(supabase, "VALIDATION_REQUIRED", { cluster_id: clusterId });
      await markEventProcessed(supabase, evt.id);
      return;
    }

    case "CLUSTER_VALIDATED": {
      if (!clusterId) {
        await markEventProcessed(supabase, evt.id);
        return;
      }

      await ensureEvent(supabase, "FACTOR_REQUIRED", { cluster_id: clusterId });
      await markEventProcessed(supabase, evt.id);
      return;
    }

    case "FACTOR_COMPLETED": {
      if (!clusterId) {
        await markEventProcessed(supabase, evt.id);
        return;
      }

      await ensureEvent(supabase, "IMPACT_REQUIRED", { cluster_id: clusterId });
      await markEventProcessed(supabase, evt.id);
      return;
    }

    case "IMPACT_COMPLETED": {
      if (!clusterId) {
        await markEventProcessed(supabase, evt.id);
        return;
      }

      await ensureEvent(supabase, "SIGNAL_REQUIRED", { cluster_id: clusterId });
      await markEventProcessed(supabase, evt.id);
      return;
    }

    case "SIGNAL_COMPLETED": {
      if (!clusterId) {
        await markEventProcessed(supabase, evt.id);
        return;
      }

      await ensureEvent(supabase, "INSIGHT_REQUIRED", { cluster_id: clusterId });
      await markEventProcessed(supabase, evt.id);
      return;
    }

    case "INSIGHT_COMPLETED": {
      if (!clusterId) {
        await markEventProcessed(supabase, evt.id);
        return;
      }

      await ensureEvent(supabase, "ALLOCATION_REQUIRED", { cluster_id: clusterId });
      await markEventProcessed(supabase, evt.id);
      return;
    }

    case "ALLOCATION_COMPLETED": {
      await markEventProcessed(supabase, evt.id);
      return;
    }

    // Backward-compatibility: map older event names into the new chain
    // so existing rows cannot block the pipeline.
    case "VALIDATION_COMPLETED": {
      if (!clusterId) {
        await markEventProcessed(supabase, evt.id);
        return;
      }
      await ensureEvent(supabase, "FACTOR_REQUIRED", { cluster_id: clusterId });
      await markEventProcessed(supabase, evt.id);
      return;
    }

    case "FACTOR_CREATED": {
      if (!clusterId) {
        await markEventProcessed(supabase, evt.id);
        return;
      }
      await ensureEvent(supabase, "IMPACT_REQUIRED", { cluster_id: clusterId });
      await markEventProcessed(supabase, evt.id);
      return;
    }

    case "IMPACT_CREATED": {
      if (!clusterId) {
        await markEventProcessed(supabase, evt.id);
        return;
      }
      await ensureEvent(supabase, "SIGNAL_REQUIRED", { cluster_id: clusterId });
      await markEventProcessed(supabase, evt.id);
      return;
    }

    case "SIGNAL_CREATED": {
      if (!clusterId) {
        await markEventProcessed(supabase, evt.id);
        return;
      }
      await ensureEvent(supabase, "INSIGHT_REQUIRED", { cluster_id: clusterId });
      await markEventProcessed(supabase, evt.id);
      return;
    }

    case "INSIGHT_CREATED": {
      // Historical trigger-based emission after event_insights insert.
      // Treat it as insight completion.
      if (!clusterId) {
        await markEventProcessed(supabase, evt.id);
        return;
      }
      await ensureEvent(supabase, "ALLOCATION_REQUIRED", { cluster_id: clusterId });
      await markEventProcessed(supabase, evt.id);
      return;
    }

    case "ALLOCATION_CREATED": {
      await markEventProcessed(supabase, evt.id);
      return;
    }

    default:
      return;
  }
}

export async function runPipelineOrchestrator(options?: OrchestratorOptions): Promise<void> {
  const supabase = createSupabaseServerClient();

  const batchSize = options?.batchSize ?? 100;
  const maxPasses = options?.maxPasses ?? 100;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const { data: events, error } = await supabase
      .from("pipeline_events")
      .select("id,event_type,payload,created_at")
      .eq("processed", false)
      .in("event_type", [...ORCHESTRATOR_EVENT_TYPES])
      .order("created_at", { ascending: true })
      .limit(batchSize);

    if (error) {
      throw new Error(`Failed to poll pipeline events: ${error.message}`);
    }

    const pending = (events as PipelineEventRow[] | null) ?? [];
    if (pending.length === 0) return;

    for (const evt of pending) {
      try {
        await handleEvent(supabase, evt);
      } catch (err) {
        await handleEventFailureWithRetries(supabase, evt, err);
      }
    }
  }
}

/**
 * Event-driven entrypoint (used by the LISTEN/NOTIFY listener).
 * Fetches a specific pipeline event by id and runs the orchestrator logic for it.
 */
export async function handlePipelineEventById(eventId: string): Promise<void> {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from("pipeline_events")
    .select("id,event_type,payload,created_at,processed")
    .eq("id", eventId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load pipeline event ${eventId}: ${error.message}`);
  }

  if (!data) return;
  const processed = Boolean((data as { processed?: boolean } | null)?.processed);
  if (processed) return;

  const row: PipelineEventRow = {
    id: (data as { id: string }).id,
    event_type: (data as { event_type: string }).event_type,
    payload: (data as { payload: unknown }).payload,
    created_at: (data as { created_at?: string }).created_at,
  };

  try {
    await handleEvent(supabase, row);
  } catch (err) {
    await handleEventFailureWithRetries(supabase, row, err);
  }
}

// Allow running this file directly via `npx tsx services/pipelineOrchestrator.ts`.
// Guarded for ESM environments where `require`/`module` are not defined.
if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  (async () => {
    try {
      console.log("[pipelineOrchestrator] starting orchestrator...");

      await runPipelineOrchestrator({
        batchSize: 100,
        maxPasses: 100,
      });

      console.log("[pipelineOrchestrator] completed successfully");
      process.exit(0);
    } catch (err) {
      console.error("[pipelineOrchestrator] fatal error:", err);
      process.exit(1);
    }
  })();
}