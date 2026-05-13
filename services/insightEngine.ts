import { createSupabaseServerClient } from "./newsFetcher";
import { withStageSpan } from "./pipelineInstrumentation";
import { workerPoolForEach } from "./workerPool";
import { recordPipelineDeadLetter } from "./pipelineDeadLetterService";
import { emitClusterEventOnce } from "./pipelineEventUtils";
import { hasSignificantInsightChange, type InsightState } from "./significantChange";
import type { SupabaseClient } from "@supabase/supabase-js";
import { factorSignalMap } from "@/lib/factorSignalMap";
import { logDebug } from "../utils/logger";
import { scoreRegimeSignals, type MacroRegime } from "./regimeEngine";

const BATCH_SIZE = 100;

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

type PortfolioSignalRow = {
  cluster_id: string | null;
  asset: string | null;
  signal: string | null;
  confidence: number | null;
};

type FactorExposureRow = {
  factor: string | null;
  exposure: number | null;
};

type ExposureMap = {
  inflation: number;
  liquidity: number;
  growth: number;
  currency: number;
  risk_sentiment: number;
  commodity_pressure: number;
  [key: string]: number;
};

type InsightReasoningSignal = {
  direction: "BUY" | "SELL" | "NEUTRAL";
  strength: number;
  confidence: number;
  source_factor: string;
};

type InsightReasoning = {
  event_summary: string;
  key_factors: string[];
  market_implications: string[];
  signals: InsightReasoningSignal[];
  contradictions: string[];
  regime: string | null;
  net_bias:
    | "bullish"
    | "bearish"
    | "neutral"
    | "inflationary"
    | "risk_off"
    | "growth"
    | "deflationary";
  confidence: number;
};

type LatestInsightRow = {
  id: string;
  confidence: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseInsightStateFromReasoning(
  reasoning: unknown,
  confidenceFallback: number | null,
): InsightState | null {
  let value: unknown = reasoning;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }

  if (!isRecord(value)) return null;

  const netBiasRaw = (value.net_bias ?? "").toString().trim();
  if (!netBiasRaw) return null;

  const regimeRaw = value.regime;
  const regime = regimeRaw == null ? null : regimeRaw.toString().trim() || null;

  const confRaw = Number((value.confidence ?? confidenceFallback) as unknown);
  const confidence = Number.isFinite(confRaw)
    ? confRaw
    : Number.isFinite(Number(confidenceFallback))
      ? Number(confidenceFallback)
      : NaN;

  if (!Number.isFinite(confidence)) return null;

  return { net_bias: netBiasRaw, regime, confidence };
}

function isUniqueViolation(err: unknown): boolean {
  const anyErr = err as { code?: unknown; message?: unknown } | null;
  const code = (anyErr?.code ?? "").toString();
  const message = (anyErr?.message ?? "").toString().toLowerCase();
  return code === "23505" || message.includes("duplicate key value");
}

function clamp(min: number, value: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function smoothConfidence(previous: number | null, current: number): number {
  const curr = clamp(0, Number(current), 1);
  if (!Number.isFinite(Number(previous))) return curr;
  const prev = clamp(0, Number(previous), 1);
  return clamp(0, prev * 0.7 + curr * 0.3, 1);
}

function computeAssetScoreFromExposures(exposures: ExposureMap, asset: string): number {
  const weights = (factorSignalMap as Record<string, Record<string, number>>)[asset] ?? {};
  let score = 0;
  for (const [factor, weight] of Object.entries(weights)) {
    const exposure = Number(exposures[factor] ?? 0);
    if (!Number.isFinite(exposure) || !Number.isFinite(weight)) continue;
    score += exposure * weight;
  }
  return score;
}

function computeInsightConfidence(
  exposures: ExposureMap,
  signalsByAsset: Record<string, { signal: "BUY" | "SELL" | "NEUTRAL"; confidence: number }>,
): number {
  // Weighted confidence based on directional strength and reliability.
  // - strength = min(1, abs(score))
  // - reliability confidence comes from the signal engine (0..1)
  // - NEUTRAL contributes nothing
  let bullish_score = 0;
  let bearish_score = 0;

  for (const [asset, v] of Object.entries(signalsByAsset)) {
    const direction = v.signal;
    if (direction === "NEUTRAL") continue;

    const reliability = clamp(0, Number(v.confidence), 1);
    const score = computeAssetScoreFromExposures(exposures, asset);
    let strength = Math.min(1, Math.abs(score));

    // Ensure BUY/SELL strength is > 0 for downstream expectations.
    if (strength <= 0) strength = 0.01;

    const weighted = strength * reliability;
    if (direction === "BUY") bullish_score += weighted;
    else if (direction === "SELL") bearish_score += weighted;
  }

  const total_strength = bullish_score + bearish_score;
  if (total_strength <= 0) return 0.5;

  const agreement = Math.max(bullish_score, bearish_score) / total_strength;

  const penalty =
    bullish_score > 0 && bearish_score > 0
      ? Math.min(bullish_score, bearish_score) / total_strength
      : 0;

  const confidence = agreement - 0.5 * penalty;
  return clamp(0, confidence, 1);
}

function normalizeSignal(signal: string | null | undefined): "BUY" | "SELL" | "NEUTRAL" {
  const s = (signal ?? "").toString().trim().toUpperCase();
  if (s === "BUY" || s === "SELL" || s === "NEUTRAL") return s;
  return "NEUTRAL";
}

function toExposureMap(rows: FactorExposureRow[]): ExposureMap {
  const base: ExposureMap = {
    inflation: 0,
    liquidity: 0,
    growth: 0,
    currency: 0,
    risk_sentiment: 0,
    commodity_pressure: 0,
  };

  for (const row of rows) {
    const factor = (row.factor ?? "").toString().trim();
    const exposure = Number(row.exposure);
    if (!factor || !Number.isFinite(exposure)) continue;
    base[factor] = (base[factor] ?? 0) + exposure;
  }

  return base;
}

function buildInsightImplications(
  exposures: ExposureMap,
  signals: Record<string, { signal: "BUY" | "SELL" | "NEUTRAL"; confidence: number }>,
): string[] {
  const lines: string[] = [];

  const inflation = exposures.inflation ?? 0;
  const liquidity = exposures.liquidity ?? 0;
  const growth = exposures.growth ?? 0;
  const risk = exposures.risk_sentiment ?? 0;
  const commodity = exposures.commodity_pressure ?? 0;

  const bonds = signals.bonds?.signal;
  const equities = signals.equities?.signal;
  const commoditiesSig = signals.commodities?.signal;
  const usd = signals.usd?.signal;

  // Examples requested in spec.
  if (inflation > 0.5 && bonds === "SELL") {
    lines.push(
      "Rising inflation pressure may weaken bond prices due to expectations of higher interest rates.",
    );
  }

  if (liquidity < -0.5 && equities === "SELL") {
    lines.push(
      "Tighter liquidity conditions may create downside pressure for equity markets.",
    );
  }

  // Additional lightweight synthesis (still simple, no extra architecture).
  if (inflation > 0.5 && commoditiesSig === "BUY") {
    lines.push(
      "Elevated inflation tends to support real assets, which can provide a tailwind for commodities.",
    );
  }

  if (risk < -0.5 && equities === "SELL") {
    lines.push(
      "Deteriorating risk sentiment often drives a defensive shift, weighing on equities and favoring safer exposures.",
    );
  }

  if (growth < -0.5 && equities === "SELL") {
    lines.push(
      "Slowing growth expectations can compress earnings outlooks and reduce risk appetite in equity markets.",
    );
  }

  if (liquidity < -0.5 && usd === "BUY") {
    lines.push(
      "Tighter global liquidity can strengthen demand for USD funding, supporting the US dollar.",
    );
  }

  if (commodity > 0.5 && commoditiesSig === "BUY") {
    lines.push(
      "Commodity supply pressure can lift spot prices and reinforce upside skew in commodities.",
    );
  }

  // Fallback if none of the rules fired.
  if (lines.length === 0) {
    const parts: string[] = [];
    if (inflation !== 0) parts.push(`inflation exposure ${inflation.toFixed(2)}`);
    if (liquidity !== 0) parts.push(`liquidity exposure ${liquidity.toFixed(2)}`);
    if (growth !== 0) parts.push(`growth exposure ${growth.toFixed(2)}`);

    const signalParts: string[] = [];
    for (const [asset, v] of Object.entries(signals)) {
      signalParts.push(`${asset} ${v.signal}`);
    }

    const exposureText = parts.length ? parts.join(", ") : "mixed macro exposures";
    const signalText = signalParts.length ? signalParts.join(", ") : "neutral positioning";

    lines.push(
      `This cluster reflects ${exposureText} and maps to portfolio signals: ${signalText}.`,
    );
  }

  return lines;
}

function buildInsightText(
  exposures: ExposureMap,
  signals: Record<string, { signal: "BUY" | "SELL" | "NEUTRAL"; confidence: number }>,
): string {
  // Join into a single paragraph.
  return buildInsightImplications(exposures, signals).join(" ");
}

function buildKeyFactors(exposures: ExposureMap, limit: number): string[] {
  const entries = Object.entries(exposures)
    .map(([factor, exposure]) => ({ factor, exposure: Number(exposure) }))
    .filter((e) => e.factor && Number.isFinite(e.exposure) && e.exposure !== 0);

  entries.sort(
    (a, b) => Math.abs(b.exposure) - Math.abs(a.exposure) || a.factor.localeCompare(b.factor),
  );

  return entries.slice(0, limit).map((e) => {
    const sign = e.exposure > 0 ? "+" : "";
    return `${e.factor} (${sign}${e.exposure.toFixed(2)})`;
  });
}

function buildSignalsArray(
  exposures: ExposureMap,
  signals: Record<string, { signal: "BUY" | "SELL" | "NEUTRAL"; confidence: number }>,
): InsightReasoningSignal[] {
  const assets = Object.keys(signals).sort((a, b) => a.localeCompare(b));
  return assets.map((asset) => {
    const v = signals[asset];
    const conf = Number(v.confidence);
    const confidence = Number.isFinite(conf) ? clamp(0, conf, 1) : 0.6;

    // Strength reflects macro intensity (magnitude), not reliability.
    // We re-score the asset using factor exposures and the same deterministic factor map.
    const weights = (factorSignalMap as Record<string, Record<string, number>>)[asset] ?? {};
    let score = 0;
    for (const [factor, weight] of Object.entries(weights)) {
      const exposure = Number(exposures[factor] ?? 0);
      if (!Number.isFinite(exposure) || !Number.isFinite(weight)) continue;
      score += exposure * weight;
    }

    let strength = v.signal === "NEUTRAL" ? 0 : Math.min(1, Math.abs(score));
    if (v.signal !== "NEUTRAL" && strength <= 0) strength = 0.01;

    return {
      direction: v.signal,
      strength,
      confidence,
      // Keep this as the asset key so downstream consumers can map it deterministically.
      source_factor: asset,
    };
  });
}

function computeNetBias(signals: InsightReasoningSignal[]): "bullish" | "bearish" | "neutral" {
  const buy = signals.filter((s) => s.direction === "BUY").length;
  const sell = signals.filter((s) => s.direction === "SELL").length;
  if (buy > sell) return "bullish";
  if (sell > buy) return "bearish";
  return "neutral";
}

function explanationForRegime(regime: MacroRegime | null): string | null {
  switch (regime) {
    case "inflationary":
      return "Detected inflationary regime: bonds under pressure, commodities supported";
    case "risk_off":
      return "Detected risk_off regime: equities under pressure, USD supported";
    case "growth":
      return "Detected growth regime: equities and commodities supported";
    case "deflationary":
      return "Detected deflationary regime: bonds supported, equities under pressure";
    default:
      return null;
  }
}

function buildContradictions(signals: InsightReasoningSignal[]): string[] {
  const buys = signals.filter((s) => s.direction === "BUY").map((s) => s.source_factor);
  const sells = signals.filter((s) => s.direction === "SELL").map((s) => s.source_factor);
  if (buys.length === 0 || sells.length === 0) return [];
  return [`Conflicting signals: BUY=[${buys.join(", ")}] SELL=[${sells.join(", ")}]`];
}

function buildEventSummary(
  keyFactors: string[],
  netBias: InsightReasoning["net_bias"],
  signals: InsightReasoningSignal[],
): string {
  const signalSummary = signals
    .filter((s) => s.direction !== "NEUTRAL")
    .slice(0, 6)
    .map((s) => `${s.source_factor} ${s.direction}`)
    .join(", ");

  const factorsText = keyFactors.length ? keyFactors.join(", ") : "mixed macro exposures";
  const signalsText = signalSummary ? `Signals: ${signalSummary}. ` : "";

  return `${signalsText}Key factors: ${factorsText}. Net bias: ${netBias}.`;
}

function buildReasoning(
  exposures: ExposureMap,
  signalsByAsset: Record<string, { signal: "BUY" | "SELL" | "NEUTRAL"; confidence: number }>,
  confidence: number,
  clusterSummary: string | null,
): InsightReasoning {
  const signals = buildSignalsArray(exposures, signalsByAsset);
  const regimeResult = scoreRegimeSignals(signals);
  const regime = regimeResult.regime;
  const explanation = explanationForRegime(regime);
  logDebug("REGIME_SCORES", { scores: regimeResult.scores, topScore: regimeResult.topScore, secondScore: regimeResult.secondScore });
  logDebug("REGIME_DETECTED", { regime });
  const net_bias = regime ?? computeNetBias(signals);
  const contradictions = buildContradictions(signals);
  const key_factors = buildKeyFactors(exposures, 5);
  const market_implications = buildInsightImplications(exposures, signalsByAsset);
  const defaultSummary = buildEventSummary(key_factors, net_bias, signals);
  const summaryFallback = (clusterSummary ?? "").toString().trim();
  const withRegime = explanation ? `${explanation}. ${defaultSummary}` : defaultSummary;
  const event_summary = signals.length === 0 && summaryFallback ? summaryFallback : withRegime;

  return {
    event_summary,
    key_factors,
    market_implications,
    signals,
    contradictions,
    regime,
    net_bias,
    confidence,
  };
}

async function loadClusterSummary(
  supabase: SupabaseClient,
  clusterId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from("event_clusters")
    .select("summary")
    .eq("id", clusterId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load cluster summary: ${error.message}`);
  }

  const summary = (data as { summary?: unknown } | null)?.summary;
  if (summary == null) return null;
  const trimmed = summary.toString().trim();
  return trimmed ? trimmed : null;
}

async function loadSignalsForCluster(
  supabase: SupabaseClient,
  clusterId: string,
): Promise<PortfolioSignalRow[]> {
  const { data, error } = await supabase
    .from("portfolio_signals")
    .select("cluster_id,asset,signal,confidence")
    .eq("cluster_id", clusterId);

  if (error) {
    throw new Error(`Failed to load portfolio signals: ${error.message}`);
  }

  return (data as PortfolioSignalRow[] | null) ?? [];
}

async function loadExposuresForCluster(
  supabase: SupabaseClient,
  clusterId: string,
): Promise<FactorExposureRow[]> {
  const { data, error } = await supabase
    .from("event_factor_exposures")
    .select("factor,exposure")
    .eq("cluster_id", clusterId);

  if (error) {
    throw new Error(`Failed to load factor exposures: ${error.message}`);
  }

  return (data as FactorExposureRow[] | null) ?? [];
}

export async function runInsightEngine(): Promise<void> {
  const supabase = createSupabaseServerClient();

  const { data: events, error } = await supabase
    .from("pipeline_events")
    .select("id,payload")
    .eq("event_type", "INSIGHT_REQUIRED")
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
          stageName: "insight",
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

        const { data: latestInsightRows, error: existingError } = await supabase
          .from("event_insights")
          .select("id,confidence,reasoning")
          .eq("cluster_id", clusterId)
          .order("created_at", { ascending: false })
          .limit(1);

        if (existingError) {
          throw new Error(`Failed to check existing insights: ${existingError.message}`);
        }

        const existing = ((latestInsightRows as Array<LatestInsightRow & { reasoning?: unknown | null }> | null) ?? [])[0] ?? null;

        const needsBackfill = !!existing && (existing as { reasoning?: unknown | null }).reasoning == null;

        const prevState = existing
          ? parseInsightStateFromReasoning(
              (existing as { reasoning?: unknown | null }).reasoning,
              existing.confidence,
            )
          : null;

        const signalsRows = await loadSignalsForCluster(supabase, clusterId);

        const exposuresRows = await loadExposuresForCluster(supabase, clusterId);
        const exposures = toExposureMap(exposuresRows);

        const signals: Record<string, { signal: "BUY" | "SELL" | "NEUTRAL"; confidence: number }> = {};

        for (const row of signalsRows) {
          const asset = (row.asset ?? "").toString().trim().toLowerCase();
          if (!asset) continue;
          const signal = normalizeSignal(row.signal);
          const confidence = Number(row.confidence);
          signals[asset] = {
            signal,
            confidence: Number.isFinite(confidence) ? confidence : 0.6,
          };
        }

        const insight = buildInsightText(exposures, signals);
        const rawConf = computeInsightConfidence(exposures, signals);
        const smoothedConf = smoothConfidence(existing?.confidence ?? null, rawConf);
        const clusterSummary = await loadClusterSummary(supabase, clusterId);

        // Always generate reasoning (never null/undefined), even if signals are empty.
        const reasoning = buildReasoning(exposures, signals, smoothedConf, clusterSummary);

        if (process.env.PIPELINE_DEBUG_INSIGHT_REASONING === "1") {
          console.log("INSIGHT_REASONING:", reasoning);
        }

        const currentState: InsightState = {
          net_bias: reasoning.net_bias,
          regime: reasoning.regime,
          confidence: smoothedConf,
        };

        const significantChange = needsBackfill || hasSignificantInsightChange(prevState, currentState);

        const payload = {
          insight,
          reasoning,
          confidence: smoothedConf,
        };

        if (significantChange) {
          if (!existing) {
            const { error: insertError } = await supabase.from("event_insights").insert({
              cluster_id: clusterId,
              ...payload,
            });

            if (insertError) {
              if (isUniqueViolation(insertError)) {
                const { error: updateError } = await supabase
                  .from("event_insights")
                  .update(payload)
                  .eq("cluster_id", clusterId);

                if (updateError) {
                  throw new Error(
                    `Failed to update event insight after duplicate insert: ${updateError.message} (cluster_id=${clusterId})`,
                  );
                }
              } else {
                throw new Error(
                  `Failed to insert event insight: ${insertError.message} (cluster_id=${clusterId})`,
                );
              }
            }
          } else {
            const { error: updateError } = await supabase
              .from("event_insights")
              .update(payload)
              .eq("cluster_id", clusterId);

            if (updateError) {
              throw new Error(
                `Failed to update event insight: ${updateError.message} (cluster_id=${clusterId})`,
              );
            }
          }
        } else if (existing) {
          // Persist smoothed confidence/reasoning even when change is below significance threshold.
          const { error: updateError } = await supabase
            .from("event_insights")
            .update(payload)
            .eq("cluster_id", clusterId);

          if (updateError) {
            throw new Error(
              `Failed to persist smoothed event insight: ${updateError.message} (cluster_id=${clusterId})`,
            );
          }
        } else {
          // No previous row: first run always stores the computed baseline without smoothing.
          const { error: insertError } = await supabase.from("event_insights").insert({
            cluster_id: clusterId,
            ...payload,
          });

          if (insertError) {
            if (isUniqueViolation(insertError)) {
              const { error: updateError } = await supabase
                .from("event_insights")
                .update(payload)
                .eq("cluster_id", clusterId);

              if (updateError) {
                throw new Error(
                  `Failed to update event insight after duplicate insert: ${updateError.message} (cluster_id=${clusterId})`,
                );
              }
            } else {
              throw new Error(
                `Failed to insert event insight: ${insertError.message} (cluster_id=${clusterId})`,
              );
            }
          }
        }

        try {
          await emitClusterEventOnce({
            supabase,
            eventType: "INSIGHT_COMPLETED",
            clusterId,
            payload: { significant_change: significantChange },
          });
        } catch (err) {
          throw new Error("INSIGHT_COMPLETED emission failed", {
            cause: err as unknown,
          });
        }

        const { error: markEventError } = await supabase
          .from("pipeline_events")
          .update({ processed: true })
          .eq("id", evt.id);

        if (markEventError) {
          throw new Error(`Failed to mark pipeline event processed: ${markEventError.message}`);
        }

          },
        });
      } catch (err) {
        await recordPipelineDeadLetter({
          supabase,
          id: evt.id,
          clusterId,
          stageName: "insight",
          err,
        });

        // If INSIGHT_COMPLETED emission failed, leave the event unprocessed so it can be retried.
        if ((err as { message?: unknown } | null)?.message !== "INSIGHT_COMPLETED emission failed") {
          const { error: markError } = await supabase
            .from("pipeline_events")
            .update({ processed: true })
            .eq("id", evt.id);
          if (markError) {
            console.error("[insightEngine] failed to mark event processed after error", {
              eventId: evt.id,
              clusterId,
              error: markError.message,
            });
          }
        } else {
          console.error(
            "[insightEngine] leaving event unprocessed due to INSIGHT_COMPLETED emit failure",
            {
              eventId: evt.id,
              clusterId,
            },
          );
        }
      }
    },
    { concurrency: Number(process.env.PIPELINE_CONCURRENCY ?? 5) },
  );
}
