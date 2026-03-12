import { createSupabaseServerClient } from "./newsFetcher";
import { factorSignalMap } from "@/lib/factorSignalMap";

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

type FactorExposureRow = {
  cluster_id: string | null;
  factor: string | null;
  exposure: number | null;
};

type PortfolioSignalRow = {
  cluster_id: string;
  asset: string;
  signal: "BUY" | "SELL" | "NEUTRAL";
  confidence: number;
};

function clamp(min: number, value: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function scoreToSignal(score: number): "BUY" | "SELL" | "NEUTRAL" {
  if (score > 0.5) return "BUY";
  if (score < -0.5) return "SELL";
  return "NEUTRAL";
}

function scoreToConfidence(score: number): number {
  const absScore = Math.abs(score);
  // Keep it simple and monotonic: stronger score -> higher confidence.
  // Floor slightly above 0.5 so BUY/SELL thresholded signals don't look low-confidence.
  return clamp(0.55, absScore, 0.95);
}

function computeSignalsForCluster(exposureByFactor: Map<string, number>): PortfolioSignalRow[] {
  const assets = Object.keys(factorSignalMap) as Array<keyof typeof factorSignalMap>;

  const results: PortfolioSignalRow[] = [];
  for (const asset of assets) {
    let score = 0;
    const weights = factorSignalMap[asset];

    for (const [factor, exposure] of exposureByFactor.entries()) {
      const weight = (weights as Record<string, number>)[factor];
      if (!Number.isFinite(weight)) continue;
      score += exposure * weight;
    }

    const signal = scoreToSignal(score);
    const confidence = scoreToConfidence(score);

    results.push({
      // cluster_id filled by caller
      cluster_id: "",
      asset: asset.toString(),
      signal,
      confidence,
    });
  }

  return results;
}

async function loadFactorExposuresForClusters(
  clusterIds: string[],
): Promise<FactorExposureRow[]> {
  const supabase = createSupabaseServerClient();

  const unique = Array.from(new Set(clusterIds.filter(Boolean)));
  if (unique.length === 0) return [];

  const { data, error } = await supabase
    .from("event_factor_exposures")
    .select("cluster_id,factor,exposure")
    .in("cluster_id", unique);

  if (error) {
    throw new Error(`Failed to load factor exposures: ${error.message}`);
  }

  return (data as FactorExposureRow[] | null) ?? [];
}

export async function runPortfolioSignalEngine(): Promise<void> {
  const supabase = createSupabaseServerClient();

  const { data: events, error } = await supabase
    .from("pipeline_events")
    .select("id,payload")
    .eq("event_type", "SIGNAL_CREATED")
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

    const { data: existingSignals, error: existingError } = await supabase
      .from("portfolio_signals")
      .select("id")
      .eq("cluster_id", clusterId)
      .limit(1);

    if (existingError) {
      throw new Error(`Failed to check existing signals: ${existingError.message}`);
    }

    if ((existingSignals ?? []).length === 0) {
      const exposures = await loadFactorExposuresForClusters([clusterId]);

      const factorSums = new Map<string, number>();
      for (const row of exposures) {
        const factor = (row.factor ?? "").toString().trim();
        const exposure = Number(row.exposure);
        if (!factor || !Number.isFinite(exposure)) continue;
        factorSums.set(factor, (factorSums.get(factor) ?? 0) + exposure);
      }

      const signals = computeSignalsForCluster(factorSums).map((s) => ({
        ...s,
        cluster_id: clusterId,
      }));

      const { error: deleteError } = await supabase
        .from("portfolio_signals")
        .delete()
        .eq("cluster_id", clusterId);

      if (deleteError) {
        throw new Error(`Failed to clear existing signals: ${deleteError.message}`);
      }

      if (signals.length > 0) {
        const { error: insertError } = await supabase
          .from("portfolio_signals")
          .insert(signals);

        if (insertError) {
          throw new Error(`Failed to insert portfolio signals: ${insertError.message}`);
        }
      }
    }

    const { error: markEventError } = await supabase
      .from("pipeline_events")
      .update({ processed: true })
      .eq("id", evt.id);

    if (markEventError) {
      throw new Error(`Failed to mark pipeline event processed: ${markEventError.message}`);
    }

    const { error: emitError } = await supabase.from("pipeline_events").insert({
      event_type: "INSIGHT_REQUIRED",
      payload: { cluster_id: clusterId },
    });

    if (emitError) {
      throw new Error(`Failed to emit INSIGHT_REQUIRED event: ${emitError.message}`);
    }
  }
}
