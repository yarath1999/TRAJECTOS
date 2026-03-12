import { createSupabaseServerClient } from "./newsFetcher";

type PipelineEventRow = {
  id: string;
  payload: unknown;
};

function extractClusterIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const clusterId = (payload as { cluster_id?: unknown }).cluster_id;
  if (typeof clusterId !== "string" && typeof clusterId !== "number") return null;
  const trimmed = clusterId.toString().trim();
  return trimmed ? trimmed : null;
}

export async function runFactorEngine(): Promise<void> {
  const supabase = createSupabaseServerClient();

  const { data: events, error } = await supabase
    .from("pipeline_events")
    .select("id,payload")
    .eq("event_type", "CLUSTER_CREATED")
    .eq("processed", false)
    .order("created_at", { ascending: true })
    .limit(20);

  if (error) {
    throw new Error(`Failed to load pipeline events: ${error.message}`);
  }

  const pending = (events as PipelineEventRow[] | null) ?? [];
  if (pending.length === 0) return;

  for (const evt of pending) {
    const clusterId = extractClusterIdFromPayload(evt.payload);
    if (!clusterId) {
      const { error: markError } = await supabase
        .from("pipeline_events")
        .update({ processed: true })
        .eq("id", evt.id);
      if (markError) {
        throw new Error(`Failed to mark pipeline event processed: ${markError.message}`);
      }
      continue;
    }

    const { data: cluster, error: clusterError } = await supabase
      .from("event_clusters")
      .select("id,title,validated,processed")
      .eq("id", clusterId)
      .maybeSingle();

    if (clusterError) {
      throw new Error(`Failed to load cluster: ${clusterError.message}`);
    }

    if (!cluster) {
      const { error: markError } = await supabase
        .from("pipeline_events")
        .update({ processed: true })
        .eq("id", evt.id);
      if (markError) {
        throw new Error(`Failed to mark pipeline event processed: ${markError.message}`);
      }
      continue;
    }

    // Preserve existing gating behavior: only process validated & unprocessed clusters.
    if (cluster.processed) {
      const { error: markError } = await supabase
        .from("pipeline_events")
        .update({ processed: true })
        .eq("id", evt.id);
      if (markError) {
        throw new Error(`Failed to mark pipeline event processed: ${markError.message}`);
      }
      continue;
    }

    if (!cluster.validated) {
      // Leave the event unprocessed so it can be retried after validation.
      continue;
    }

    const title = (cluster.title ?? "").toString().toLowerCase();

    const exposures: Array<{ factor: string; exposure: number }> = [];

    if (title.includes("rate") || title.includes("interest")) {
      exposures.push(
        { factor: "liquidity", exposure: -0.8 },
        { factor: "growth", exposure: -0.3 },
        { factor: "inflation", exposure: -0.4 },
      );
    }

    if (title.includes("oil") || title.includes("energy")) {
      exposures.push(
        { factor: "inflation", exposure: 0.7 },
        { factor: "commodity_pressure", exposure: 0.6 },
      );
    }

    if (title.includes("war") || title.includes("conflict")) {
      exposures.push({ factor: "risk_sentiment", exposure: -0.7 });
    }

    for (const exposure of exposures) {
      const { error: insertError } = await supabase
        .from("event_factor_exposures")
        .insert({
          cluster_id: clusterId,
          factor: exposure.factor,
          exposure: exposure.exposure,
        });

      if (insertError) {
        throw new Error(
          `Failed to insert factor exposure: ${insertError.message}`,
        );
      }
    }

    const { error: markProcessedError } = await supabase
      .from("event_clusters")
      .update({ processed: true })
      .eq("id", clusterId);

    if (markProcessedError) {
      throw new Error(
        `Failed to mark cluster processed: ${markProcessedError.message}`,
      );
    }

    const { error: markEventError } = await supabase
      .from("pipeline_events")
      .update({ processed: true })
      .eq("id", evt.id);

    if (markEventError) {
      throw new Error(
        `Failed to mark pipeline event processed: ${markEventError.message}`,
      );
    }

    const { error: emitError } = await supabase.from("pipeline_events").insert({
      event_type: "FACTOR_CREATED",
      payload: { cluster_id: clusterId },
    });

    if (emitError) {
      throw new Error(`Failed to emit FACTOR_CREATED event: ${emitError.message}`);
    }
  }
}
