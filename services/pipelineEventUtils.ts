import type { SupabaseClient } from "@supabase/supabase-js";

function isUniqueViolation(message: string): boolean {
  const m = (message ?? "").toLowerCase();
  return (
    m.includes("duplicate key value violates unique constraint") ||
    m.includes("duplicate key value") ||
    m.includes("unique constraint")
  );
}

async function existsActiveOrRecentEvent(params: {
  supabase: SupabaseClient;
  eventType: string;
  clusterId: string;
  cooldownMs: number;
}): Promise<boolean> {
  const { supabase, eventType, clusterId, cooldownMs } = params;

  // Fast check for active (unprocessed) event.
  const { data: active, error: activeError } = await supabase
    .from("pipeline_events")
    .select("id")
    .eq("event_type", eventType)
    .eq("payload->>cluster_id", clusterId)
    .eq("processed", false)
    .limit(1);

  if (activeError) {
    throw new Error(`Failed to check existing active ${eventType} events: ${activeError.message}`);
  }

  if ((active ?? []).length > 0) return true;

  // Cooldown window: suppress re-emission if a processed event was created recently.
  if (cooldownMs > 0) {
    const cutoffIso = new Date(Date.now() - cooldownMs).toISOString();
    const { data: recent, error: recentError } = await supabase
      .from("pipeline_events")
      .select("id")
      .eq("event_type", eventType)
      .eq("payload->>cluster_id", clusterId)
      .eq("processed", true)
      .gte("created_at", cutoffIso)
      .limit(1);

    if (recentError) {
      throw new Error(
        `Failed to check existing recent processed ${eventType} events: ${recentError.message}`,
      );
    }

    if ((recent ?? []).length > 0) return true;
  }

  return false;
}

export async function emitClusterEventOnce(params: {
  supabase: SupabaseClient;
  eventType: string;
  clusterId: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const clusterId = (params.clusterId ?? "").toString().trim();
  const eventType = (params.eventType ?? "").toString().trim();
  if (!clusterId || !eventType) return;

  // Cooldown window (minutes) to prevent rapid re-triggering of the same event.
  // Default: 1 minute. Set to 0 to disable.
  const cooldownMinutesRaw = process.env.PIPELINE_EVENT_COOLDOWN_MINUTES;
  const cooldownMinutes = cooldownMinutesRaw == null ? 1 : Number(cooldownMinutesRaw);

  // Backward compatibility: if cooldown is explicitly disabled, allow legacy env var.
  const legacyMinutes = Number(process.env.PIPELINE_EVENT_RECENT_PROCESSED_MINUTES ?? 0);

  const cooldownMs =
    Number.isFinite(cooldownMinutes) && cooldownMinutes > 0
      ? cooldownMinutes * 60_000
      : Number.isFinite(legacyMinutes) && legacyMinutes > 0
        ? legacyMinutes * 60_000
        : 0;

  // Pre-check to avoid unnecessary insert attempts.
  // Still rely on DB constraints for race-safety.
  const exists = await existsActiveOrRecentEvent({
    supabase: params.supabase,
    eventType,
    clusterId,
    cooldownMs,
  });

  if (exists) return;

  const payload: Record<string, unknown> = {
    ...(params.payload ?? {}),
    cluster_id: clusterId,
  };

  const { error } = await params.supabase.from("pipeline_events").insert({
    event_type: eventType,
    payload,
  });

  if (error) {
    // In case a DB-level uniqueness constraint exists, treat violations as idempotent success.
    if (isUniqueViolation(error.message)) {
      return;
    }

    console.error("[emitClusterEventOnce] insert failed", error);
    throw new Error(`Failed to emit ${eventType} event: ${error.message}`);
  }

  console.log("[emitClusterEventOnce] emitted", eventType, clusterId);
}
