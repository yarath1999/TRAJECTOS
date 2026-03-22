import type { SupabaseClient } from "@supabase/supabase-js";

function isUniqueViolation(message: string): boolean {
  const m = (message ?? "").toLowerCase();
  return (
    m.includes("duplicate key value violates unique constraint") ||
    m.includes("duplicate key value") ||
    m.includes("unique constraint")
  );
}

export async function emitClusterEventOnce(params: {
  supabase: SupabaseClient;
  eventType: string;
  clusterId: string;
}): Promise<void> {
  const clusterId = (params.clusterId ?? "").toString().trim();
  const eventType = (params.eventType ?? "").toString().trim();
  if (!clusterId || !eventType) return;

  console.log("[emitClusterEventOnce] checking existing", eventType, clusterId);

  const { data: existing, error: existingError } = await params.supabase
    .from("pipeline_events")
    .select("id")
    .eq("event_type", eventType)
    .eq("payload->>cluster_id", clusterId)
    .limit(1);

  if (existingError) {
    // If we can't check for existence, we can't guarantee global idempotency.
    // Fail fast so callers can retry.
    throw new Error(`Failed to check existing ${eventType} events: ${existingError.message}`);
  }

  if ((existing ?? []).length > 0) {
    console.log(
      "[emitClusterEventOnce] skip existing",
      eventType,
      clusterId,
      (existing?.[0] as { id?: string } | undefined)?.id ?? null,
    );
    return;
  }

  const { error } = await params.supabase.from("pipeline_events").insert({
    event_type: eventType,
    payload: { cluster_id: clusterId },
  });

  if (error) {
    // In case a DB-level uniqueness constraint exists, treat violations as idempotent success.
    if (isUniqueViolation(error.message)) {
      console.log(
        "[emitClusterEventOnce] insert skipped (unique constraint)",
        eventType,
        clusterId,
        { code: (error as { code?: string }).code ?? null, message: error.message },
      );
      return;
    }

    console.error("[emitClusterEventOnce] insert failed", eventType, clusterId, {
      code: (error as { code?: string }).code ?? null,
      message: error.message,
      details: (error as { details?: string }).details ?? null,
      hint: (error as { hint?: string }).hint ?? null,
    });
    throw new Error(`Failed to emit ${eventType} event: ${error.message}`);
  }

  console.log("[emitClusterEventOnce] insert succeeded", eventType, clusterId);
}
