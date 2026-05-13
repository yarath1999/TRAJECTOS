import { createSupabaseServerClient } from "./newsFetcher";
import { factorSignalMap } from "@/lib/factorSignalMap";
import { withStageSpan } from "./pipelineInstrumentation";
import { workerPoolForEach } from "./workerPool";
import { emitClusterEventOnce } from "./pipelineEventUtils";
import { recordPipelineDeadLetter } from "./pipelineDeadLetterService";
import { hasSignificantSignalChange, type SignalState } from "./significantChange";

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
  strength: number;
};

function clamp(min: number, value: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(0, value, 1);
}

function smoothWithPrevious(previous: number | null, current: number): number {
  const curr = clamp01(Number(current));
  if (!Number.isFinite(Number(previous))) return curr;
  const prev = clamp01(Number(previous));
  return clamp01(prev * 0.7 + curr * 0.3);
}

function scoreToSignal(score: number): "BUY" | "SELL" | "NEUTRAL" {
  // Directional thresholding to reduce excessive NEUTRAL signals.
  if (score > 0.3) return "BUY";
  if (score < -0.3) return "SELL";
  return "NEUTRAL";
}

function scoreToReliabilityConfidence(
  score: number,
  contributions: Array<{ factor: string; contribution: number }>,
): number {
  // Confidence reflects reliability / agreement, not magnitude.
  // Default to a 0.6–0.8 range; increase when multiple factors agree.
  const direction = scoreToSignal(score);
  if (direction === "NEUTRAL") return 0.6;

  const sign = Math.sign(score);
  const significant = contributions.filter((c) => Math.abs(c.contribution) >= 0.05);
  const agreeCount = significant.filter((c) => Math.sign(c.contribution) === sign).length;
  const opposeCount = significant.filter((c) => Math.sign(c.contribution) === -sign).length;

  const base = 0.65;
  const confidence = base + 0.05 * Math.max(0, agreeCount - 1) - 0.05 * opposeCount;
  return clamp(0.6, confidence, 0.8);
}

function computeSignalsForCluster(exposureByFactor: Map<string, number>): PortfolioSignalRow[] {
  const assets = Object.keys(factorSignalMap) as Array<keyof typeof factorSignalMap>;

  let dominantFactor: string | null = null;
  let dominantExposure = 0;
  for (const [factor, exposure] of exposureByFactor.entries()) {
    if (!Number.isFinite(exposure)) continue;
    if (Math.abs(exposure) > Math.abs(dominantExposure)) {
      dominantExposure = exposure;
      dominantFactor = factor;
    }
  }

  const results: PortfolioSignalRow[] = [];
  for (const asset of assets) {
    let score = 0;
    const weights = factorSignalMap[asset];

    const contributions: Array<{ factor: string; contribution: number }> = [];

    for (const [factor, exposure] of exposureByFactor.entries()) {
      const weight = (weights as Record<string, number>)[factor];
      if (!Number.isFinite(weight)) continue;
      const contribution = exposure * weight;
      score += contribution;
      if (factor) contributions.push({ factor, contribution });
    }

    const signal = scoreToSignal(score);
    const confidence = scoreToReliabilityConfidence(score, contributions);
    const strength = clamp01(Math.abs(score));

    results.push({
      // cluster_id filled by caller
      cluster_id: "",
      asset: asset.toString(),
      signal,
      confidence,
      strength,
    });
  }

  // Ensure at least one non-NEUTRAL signal when meaningful exposure exists.
  // If all signals are NEUTRAL but max(|exposure|) > 0.5, force the dominant factor to produce direction.
  const hasDirectional = results.some((r) => r.signal !== "NEUTRAL");
  const maxAbsExposure = Math.abs(dominantExposure);
  if (!hasDirectional && maxAbsExposure > 0.5 && dominantFactor) {
    let chosenAsset: string | null = null;
    let chosenContribution = 0;

    for (const asset of assets) {
      const weights = factorSignalMap[asset] as unknown as Record<string, number>;
      const w = Number(weights[dominantFactor]);
      if (!Number.isFinite(w) || w === 0) continue;
      const contribution = dominantExposure * w;

      if (
        chosenAsset === null ||
        Math.abs(contribution) > Math.abs(chosenContribution) ||
        (Math.abs(contribution) === Math.abs(chosenContribution) && asset.toString() < (chosenAsset ?? ""))
      ) {
        chosenAsset = asset.toString();
        chosenContribution = contribution;
      }
    }

    // If the dominant factor doesn't map to any asset, fall back deterministically to equities.
    if (!chosenAsset) {
      chosenAsset = "equities";
      chosenContribution = dominantExposure;
    }

    const forcedScore =
      chosenContribution === 0
        ? dominantExposure >= 0
          ? 0.31
          : -0.31
        : chosenContribution;

    const forcedSignal = scoreToSignal(forcedScore);
    // With a single dominant factor driving direction, treat reliability as moderate.
    const forcedConfidence = 0.7;
    const finalSignal =
      forcedSignal === "NEUTRAL" ? (dominantExposure >= 0 ? "BUY" : "SELL") : forcedSignal;

    const forcedStrength = clamp01(Math.abs(forcedScore));

    const idx = results.findIndex((r) => r.asset === chosenAsset);
    if (idx >= 0) {
      results[idx] = {
        ...results[idx],
        signal: finalSignal,
        confidence: forcedConfidence,
        strength: forcedStrength,
      };
    }
  }

  return results;
}

function toSignalState(rows: Array<{ asset: string; signal: string; strength: number | null }>): SignalState {
  const out: SignalState = {};
  for (const row of rows) {
    const asset = (row.asset ?? "").toString().trim().toLowerCase();
    if (!asset) continue;
    const signal = (row.signal ?? "").toString().trim().toUpperCase();
    const direction =
      signal === "BUY" || signal === "SELL" || signal === "NEUTRAL" ? (signal as "BUY" | "SELL" | "NEUTRAL") : "NEUTRAL";
    const strength = clamp01(Number(row.strength));
    out[asset] = { direction, strength };
  }
  return out;
}

function smoothSignalsWithPrevious(params: {
  previous: SignalState | null;
  current: PortfolioSignalRow[];
}): PortfolioSignalRow[] {
  const { previous, current } = params;
  return current.map((row) => {
    const asset = (row.asset ?? "").toString().trim().toLowerCase();
    const prevStrength = previous?.[asset]?.strength ?? null;
    return {
      ...row,
      strength: smoothWithPrevious(prevStrength, Number(row.strength)),
    };
  });
}

function toSignalInsertRows(
  clusterId: string,
  rows: PortfolioSignalRow[],
): Array<{
  cluster_id: string;
  asset: string;
  signal: "BUY" | "SELL" | "NEUTRAL";
  confidence: number;
  strength: number;
}> {
  return rows.map((row) => ({
    cluster_id: clusterId,
    asset: (row.asset ?? "").toString().trim().toLowerCase(),
    signal: row.signal,
    confidence: clamp(0, Number(row.confidence), 1),
    strength: clamp01(Number(row.strength)),
  })).filter((row) => row.asset.length > 0);
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

async function backfillNullStrengthSignals(params: {
  supabase: ReturnType<typeof createSupabaseServerClient>;
  clusterLimit?: number;
}): Promise<void> {
  const supabase = params.supabase;
  const clusterLimit = Number.isFinite(Number(params.clusterLimit))
    ? Math.max(1, Math.floor(Number(params.clusterLimit)))
    : 100;

  const { data: nullRows, error: nullRowsError } = await supabase
    .from("portfolio_signals")
    .select("cluster_id")
    .is("strength", null)
    .not("cluster_id", "is", null)
    .limit(clusterLimit * 5);

  if (nullRowsError) {
    throw new Error(`Failed to load clusters with null strength: ${nullRowsError.message}`);
  }

  const clusterIds = Array.from(
    new Set(
      ((nullRows as Array<{ cluster_id?: string | null }> | null) ?? [])
        .map((r) => (r.cluster_id ?? "").toString().trim())
        .filter(Boolean),
    ),
  ).slice(0, clusterLimit);

  if (clusterIds.length === 0) return;

  const exposures = await loadFactorExposuresForClusters(clusterIds);
  const exposuresByCluster = new Map<string, Map<string, number>>();

  for (const row of exposures) {
    const clusterId = (row.cluster_id ?? "").toString().trim();
    const factor = (row.factor ?? "").toString().trim();
    const exposure = Number(row.exposure);
    if (!clusterId || !factor || !Number.isFinite(exposure)) continue;

    const byFactor = exposuresByCluster.get(clusterId) ?? new Map<string, number>();
    byFactor.set(factor, (byFactor.get(factor) ?? 0) + exposure);
    exposuresByCluster.set(clusterId, byFactor);
  }

  for (const clusterId of clusterIds) {
    const factorSums = exposuresByCluster.get(clusterId) ?? new Map<string, number>();
    const rows = computeSignalsForCluster(factorSums).map((s) => ({ ...s, cluster_id: clusterId }));
    const inserts = toSignalInsertRows(clusterId, rows);

    const { error: deleteError } = await supabase
      .from("portfolio_signals")
      .delete()
      .eq("cluster_id", clusterId);

    if (deleteError) {
      throw new Error(`Failed to clear null-strength signals for cluster ${clusterId}: ${deleteError.message}`);
    }

    if (inserts.length > 0) {
      const { error: insertError } = await supabase
        .from("portfolio_signals")
        .insert(inserts);

      if (insertError) {
        throw new Error(`Failed to backfill signal strength for cluster ${clusterId}: ${insertError.message}`);
      }
    }
  }
}

export async function runPortfolioSignalEngine(): Promise<void> {
  const supabase = createSupabaseServerClient();

  // One bounded pass to migrate legacy NULL strength rows to computed values.
  await backfillNullStrengthSignals({
    supabase,
    clusterLimit: Number(process.env.PIPELINE_SIGNAL_STRENGTH_BACKFILL_CLUSTER_LIMIT ?? 100),
  });

  const BATCH_SIZE = 100;

  const { data: events, error } = await supabase
    .from("pipeline_events")
    .select("id,payload")
    .eq("event_type", "SIGNAL_REQUIRED")
    .eq("processed", false)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);

  if (error) {
    throw new Error(`Failed to load pipeline events: ${error.message}`);
  }

  const pending = (events as PipelineEventRow[] | null) ?? [];
  if (pending.length === 0) return;

  const seen = new Set<string>();
  const unique: PipelineEventRow[] = [];
  for (const evt of pending) {
    const clusterId = extractClusterIdFromPayload(evt.payload);
    if (!clusterId) {
      unique.push(evt);
      continue;
    }
    if (seen.has(clusterId)) continue;
    seen.add(clusterId);
    unique.push(evt);
  }

  await workerPoolForEach(
    unique,
    async (evt) => {
      const clusterId = extractClusterIdFromPayload(evt.payload);
      try {
        await withStageSpan({
          supabase,
          stageName: "portfolio_signal",
          clusterId,
          eventId: evt.id,
          statusOnSuccess: clusterId ? "success" : "skipped",
          fn: async () => {
        if (!clusterId) {
          const { error: markError } = await supabase
            .from("pipeline_events")
            .update({ processed: true })
            .eq("id", evt.id);

          if (markError) {
            throw new Error(`Failed to mark pipeline event processed: ${markError.message}`);
          }

          return;
        }

        const { data: prevRows, error: prevError } = await supabase
          .from("portfolio_signals")
          .select("asset,signal,strength")
          .eq("cluster_id", clusterId);

        if (prevError) {
          throw new Error(`Failed to load previous signals: ${prevError.message}`);
        }

        const exposures = await loadFactorExposuresForClusters([clusterId]);

        const factorSums = new Map<string, number>();
        for (const row of exposures) {
          const factor = (row.factor ?? "").toString().trim();
          const exposure = Number(row.exposure);
          if (!factor || !Number.isFinite(exposure)) continue;
          factorSums.set(factor, (factorSums.get(factor) ?? 0) + exposure);
        }

        const computedSignals = computeSignalsForCluster(factorSums).map((s) => ({
          ...s,
          cluster_id: clusterId,
        }));

        const prevState = (prevRows as Array<{ asset: string; signal: string; strength: number | null }> | null) ?? [];
        const prev = prevState.length > 0 ? toSignalState(prevState) : null;
        const hasLegacyNullStrength = prevState.some((row) => row.strength == null);
        const smoothedSignals = smoothSignalsWithPrevious({
          previous: prev,
          current: computedSignals,
        });
        const signalInsertRows = toSignalInsertRows(clusterId, smoothedSignals);
        const current = toSignalState(
          signalInsertRows.map((s) => ({ asset: s.asset, signal: s.signal, strength: s.strength })),
        );

        const significantChange = hasLegacyNullStrength || hasSignificantSignalChange(prev, current);

        const { error: deleteError } = await supabase
          .from("portfolio_signals")
          .delete()
          .eq("cluster_id", clusterId);

        if (deleteError) {
          throw new Error(`Failed to clear existing signals: ${deleteError.message}`);
        }

        if (signalInsertRows.length > 0) {
          const { error: insertError } = await supabase
            .from("portfolio_signals")
            .insert(signalInsertRows);

          if (insertError) {
            throw new Error(`Failed to insert portfolio signals: ${insertError.message}`);
          }
        }

        const { error: markEventError } = await supabase
          .from("pipeline_events")
          .update({ processed: true })
          .eq("id", evt.id);

        if (markEventError) {
          throw new Error(`Failed to mark pipeline event processed: ${markEventError.message}`);
        }

        await emitClusterEventOnce({
          supabase,
          eventType: "SIGNAL_COMPLETED",
          clusterId,
          payload: { significant_change: significantChange },
        });
          },
        });
      } catch (err) {
        await recordPipelineDeadLetter({
          supabase,
          id: evt.id,
          clusterId,
          stageName: "portfolio_signal",
          err,
        });

        const { error: markError } = await supabase
          .from("pipeline_events")
          .update({ processed: true })
          .eq("id", evt.id);
        if (markError) {
          console.error(
            "[portfolioSignalEngine] failed to mark event processed after error",
            {
              eventId: evt.id,
              clusterId,
              error: markError.message,
            },
          );
        }
      }
    },
    { concurrency: Number(process.env.PIPELINE_CONCURRENCY ?? 5) || 5 },
  );
}
