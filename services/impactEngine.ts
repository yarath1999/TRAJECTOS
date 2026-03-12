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

export async function runImpactEngine() {
  const supabase = createSupabaseServerClient();

  const { data: events, error } = await supabase
    .from("pipeline_events")
    .select("id,payload")
    .eq("event_type", "FACTOR_CREATED")
    .eq("processed", false)
    .order("created_at", { ascending: true })
    .limit(20);

  if (error) {
    throw new Error(`Failed to load pipeline events: ${error.message}`);
  }

  const pending = (events as PipelineEventRow[] | null) ?? [];
  if (pending.length === 0) return;

  const factorMap: Record<string, string[]> = {
    equities: ["growth", "liquidity"],
    bonds: ["inflation", "liquidity"],
    real_estate: ["inflation", "liquidity"],
  };

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

    const { data: exposures, error: exposuresError } = await supabase
      .from("event_factor_exposures")
      .select("factor,exposure")
      .eq("cluster_id", clusterId);

    if (exposuresError) {
      throw new Error(
        `Failed to load factor exposures: ${exposuresError.message}`,
      );
    }

    if (!exposures?.length) {
      const { error: markEventError } = await supabase
        .from("pipeline_events")
        .update({ processed: true })
        .eq("id", evt.id);

      if (markEventError) {
        throw new Error(
          `Failed to mark pipeline event processed: ${markEventError.message}`,
        );
      }

      continue;
    }

    const exposureByFactor = new Map<string, number>();
    for (const row of exposures as Array<{ factor: string; exposure: number }>) {
      const factor = (row.factor ?? "").toString();
      const exposure = Number(row.exposure);
      if (!factor || !Number.isFinite(exposure)) continue;
      exposureByFactor.set(factor, (exposureByFactor.get(factor) ?? 0) + exposure);
    }

    const impacts: Array<{ asset_class: string; impact_score: number }> = [];
    for (const [assetClass, factors] of Object.entries(factorMap)) {
      const contributions = factors.map((f) => exposureByFactor.get(f) ?? 0);
      const impactScore = contributions.reduce((a, b) => a + b, 0);
      if (impactScore === 0) continue;
      impacts.push({ asset_class: assetClass, impact_score: impactScore });
    }

    if (impacts.length === 0) {
      const { error: markEventError } = await supabase
        .from("pipeline_events")
        .update({ processed: true })
        .eq("id", evt.id);

      if (markEventError) {
        throw new Error(
          `Failed to mark pipeline event processed: ${markEventError.message}`,
        );
      }

      continue;
    }

    for (const impact of impacts) {
      const { error: insertError } = await supabase
        .from("event_impact_scores")
        .insert({
          cluster_id: clusterId,
          asset_class: impact.asset_class,
          impact_score: impact.impact_score,
        });

      if (insertError) {
        throw new Error(
          `Failed to insert impact score: ${insertError.message}`,
        );
      }
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
      event_type: "SIGNAL_CREATED",
      payload: { cluster_id: clusterId },
    });

    if (emitError) {
      throw new Error(`Failed to emit SIGNAL_CREATED event: ${emitError.message}`);
    }
  }
}
