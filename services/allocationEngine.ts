import { createSupabaseServerClient } from "./newsFetcher";
import { allocationModel, type AllocationSignal } from "@/lib/allocationModel";
import { withStageSpan } from "./pipelineInstrumentation";
import { workerPoolForEach } from "./workerPool";
import { emitClusterEventOnce } from "./pipelineEventUtils";
import { recordPipelineDeadLetter } from "./pipelineDeadLetterService";
import { hasSignificantAllocationChange, type AllocationState } from "./significantChange";
import { analyzeRegime, type MacroRegime } from "./regimeEngine";
import { logDebug, logWarn, logError, logEvent } from "../utils/logger";
import {
  createWorkerRunId,
  measureAsyncOperation,
  getPerformanceSnapshot,
  recordAllocationExecutionMs,
  recordAllocationFailure,
  recordClusterProcessed,
  recordDuplicateSkip,
} from "../utils/performanceTracker";
import { validateEnvOrThrow } from "../utils/validateEnv";

type PipelineEventRow = {
  id: string;
  payload: unknown;
};

type PortfolioSignal = {
  asset: string | null;
  signal: string | null;
  confidence: number | null;
};

type InsightReasoningSignal = {
  direction?: unknown;
  strength?: unknown;
  confidence?: unknown;
  source_factor?: unknown;
};

// Regime analysis is handled by services/regimeEngine.ts

function extractClusterIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const clusterId = (payload as { cluster_id?: unknown }).cluster_id;
  if (typeof clusterId !== "string" && typeof clusterId !== "number") return null;
  const trimmed = clusterId.toString().trim();
  return trimmed ? trimmed : null;
}

function normalizeSignal(signal: string | null | undefined): AllocationSignal {
  const s = (signal ?? "").toString().trim().toUpperCase();
  if (s === "BUY" || s === "SELL" || s === "NEUTRAL") return s;
  return "NEUTRAL";
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseInsightReasoningSignals(reasoning: unknown): InsightReasoningSignal[] {
  let value: unknown = reasoning;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }

  if (!isRecord(value)) return [];
  const signals = value.signals;
  if (!Array.isArray(signals)) return [];
  return signals as InsightReasoningSignal[];
}


function toSignalMapFromReasoning(
  signals: InsightReasoningSignal[],
): Map<string, { signal: AllocationSignal; confidence: number }> {
  const out = new Map<string, { signal: AllocationSignal; confidence: number }>();

  for (const row of signals) {
    if (!isRecord(row)) continue;
    const source = (row.source_factor ?? "").toString().trim().toLowerCase();
    if (!source) continue;

    const directionRaw = (row.direction ?? "").toString();
    const signal = normalizeSignal(directionRaw);

    const conf = Number(row.confidence);
    const confidence = clamp01(Number.isFinite(conf) ? conf : 0.6);

    out.set(source, { signal, confidence });
  }

  return out;
}

function normalizeAllocations(weights: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};

  for (const [asset, weight] of Object.entries(weights)) {
    out[asset] = clamp01(weight);
  }

  const sum = Object.values(out).reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    return { ...Object.fromEntries(Object.keys(out).map((k) => [k, 0])), cash: 1 };
  }

  for (const asset of Object.keys(out)) {
    out[asset] = out[asset] / sum;
  }

  return out;
}

function avg(nums: number[]): number {
  const finite = nums.filter((n) => Number.isFinite(n));
  if (finite.length === 0) return 0;
  return finite.reduce((a, b) => a + b, 0) / finite.length;
}

function toAllocationState(rows: Array<{ asset: string | null; weight: number | null }>): AllocationState {
  const out: AllocationState = {};
  for (const row of rows) {
    const asset = (row.asset ?? "").toString().trim().toLowerCase();
    if (!asset) continue;
    const weight = Number(row.weight);
    if (!Number.isFinite(weight)) continue;
    out[asset] = weight;
  }
  return out;
}

function logQueryTiming(operation: string, durationMs: number, details: Record<string, unknown> = {}): void {
  const payload = { operation, duration_ms: durationMs, ...details };
  if (durationMs > 500) {
    logWarn("ALLOCATION_SLOW_QUERY", payload);
  } else {
    logDebug("ALLOCATION_QUERY_TIMING", payload);
  }
}

export async function runAllocationEngine(): Promise<void> {
  validateEnvOrThrow({
    serviceName: "allocationEngine",
    required: ["NEXT_PUBLIC_SUPABASE_URL"],
    anyOf: [
      {
        names: ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY"],
        label: "SUPABASE_SERVICE_ROLE_KEY | SUPABASE_SERVICE_KEY",
      },
    ],
  });

  const workerRunId = createWorkerRunId("allocation");
  logEvent("ALLOCATION_WORKER_RUN_START", { run_id: workerRunId }, "INFO");

  const supabase = createSupabaseServerClient();

  const BATCH_SIZE = 100;
  // Track clusters and per-cluster assets processed during this run to avoid duplicate work/logs.
  const processedAllocationClusters: Set<string> = new Set();
  const processedAllocationAssets: Map<string, Set<string>> = new Map();

  const eventsQuery = supabase
    .from("pipeline_events")
    .select("id,payload")
    .eq("event_type", "ALLOCATION_REQUIRED")
    .eq("processed", false)
    .order("created_at", { ascending: true })
    .limit(BATCH_SIZE);
  const { value: eventsResult, durationMs: eventsDurationMs } = await measureAsyncOperation(() => eventsQuery);
  logQueryTiming("pipeline_events.pending_allocation", eventsDurationMs, { batch_size: BATCH_SIZE });
  const { data: events, error } = eventsResult;

  if (error) {
    throw new Error(`Failed to load pipeline events: ${error.message}`);
  }

  const pending = (events as PipelineEventRow[] | null) ?? [];
  if (pending.length === 0) {
    logEvent("ALLOCATION_WORKER_RUN_COMPLETE", { run_id: workerRunId, processed: 0 }, "INFO");
    return;
  }

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

  let duplicateSkipCount = 0;

  await workerPoolForEach(
    unique,
    async (evt) => {
      const clusterId = extractClusterIdFromPayload(evt.payload);
      const clusterStartedAt = Date.now();
      let clusterStatus: "success" | "failure" | "skipped" = clusterId ? "success" : "skipped";
      try {
        await withStageSpan({
          supabase,
          stageName: "allocation",
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

        // Duplicate-skip guard: if this cluster was already processed in this run, skip work and mark event processed.
        if (processedAllocationClusters.has(clusterId)) {
          logDebug("ALLOCATION_SKIPPED_DUPLICATE", { cluster_id: clusterId });
          recordDuplicateSkip();
          duplicateSkipCount += 1;
          clusterStatus = "skipped";
          if (duplicateSkipCount >= 2) {
            logWarn("ALLOCATION_DUPLICATE_SKIP_REPEATED", {
              run_id: workerRunId,
              cluster_id: clusterId,
              duplicateSkipCount,
            });
          }
          const { error: markError } = await supabase
            .from("pipeline_events")
            .update({ processed: true })
            .eq("id", evt.id);
          if (markError) {
            logError("PIPELINE_EVENT_MARK_ERROR", { cluster_id: clusterId, eventId: evt.id, error: markError.message });
          }
          return;
        }

        const prevAllocQuery = supabase
          .from("event_allocations")
          .select("asset,weight")
          .eq("cluster_id", clusterId);
        const { value: prevAllocResult, durationMs: prevAllocDurationMs } = await measureAsyncOperation(() => prevAllocQuery);
        logQueryTiming("event_allocations.previous", prevAllocDurationMs, { cluster_id: clusterId });
        const { data: prevAllocRows, error: prevAllocError } = prevAllocResult;

        if (prevAllocError) {
          throw new Error(`Failed to load previous allocations: ${prevAllocError.message}`);
        }

        const signalsQuery = supabase
          .from("event_insights")
          .select("reasoning")
          .eq("cluster_id", clusterId)
          .order("created_at", { ascending: false })
          .limit(1);
        const { value: signalsResult, durationMs: signalsDurationMs } = await measureAsyncOperation(() => signalsQuery);
        logQueryTiming("event_insights.latest", signalsDurationMs, { cluster_id: clusterId });
        const { data: signalsRows, error: signalsError } = signalsResult;

        let signalByAsset = new Map<string, { signal: AllocationSignal; confidence: number }>();
        let finalRegime: MacroRegime = "growth";
        let regimeConfidence = 0;
        let regimeStrength = 0;

        if (signalsError) {
          // Backward compatibility: if we can't load reasoning, fall back to legacy portfolio_signals.
          logWarn("ALLOCATION_INSIGHT_LOAD_FAILED", { cluster_id: clusterId, error: signalsError.message });
        } else {
          const row = (signalsRows as Array<{ reasoning?: unknown }> | null)?.[0];
          const reasoningSignals = parseInsightReasoningSignals(row?.reasoning);
          // Delegate regime analysis to the regime engine
          const regimeResult = analyzeRegime(row?.reasoning);
          finalRegime = regimeResult.finalRegime;
          regimeConfidence = regimeResult.confidence ?? 0;
          regimeStrength = regimeResult.adjustmentStrength ?? 0;

          if (reasoningSignals.length > 0) {
            signalByAsset = toSignalMapFromReasoning(reasoningSignals);
          }
        }

        if (signalByAsset.size === 0) {
          const legacySignalsQuery = supabase
            .from("portfolio_signals")
            .select("asset,signal,confidence")
            .eq("cluster_id", clusterId);
          const { value: legacySignalsResult, durationMs: legacySignalsDurationMs } = await measureAsyncOperation(() => legacySignalsQuery);
          logQueryTiming("portfolio_signals.legacy", legacySignalsDurationMs, { cluster_id: clusterId });
          const { data: legacySignalsRows, error: legacySignalsError } = legacySignalsResult;

          if (legacySignalsError) {
            throw new Error(`Failed to load portfolio signals: ${legacySignalsError.message}`);
          }

          const rows = (legacySignalsRows as PortfolioSignal[] | null) ?? [];
          for (const row of rows) {
            const asset = (row.asset ?? "").toString().trim().toLowerCase();
            if (!asset) continue;
            const signal = normalizeSignal(row.signal);
            const conf = Number(row.confidence);
            signalByAsset.set(asset, {
              signal,
              confidence: Number.isFinite(conf) ? conf : 0.6,
            });
          }
        }

        const allocationExecutionStartedAt = Date.now();

        // Base weights example
        const baseWeights: Record<string, number> = {
          equities: 0.4,
          bonds: 0.3,
          commodities: 0.2,
          usd: 0.1,
          cash: 0,
        };

        const rawWeights: Record<string, number> = { ...baseWeights };

        for (const asset of Object.keys(baseWeights)) {
          if (asset === "cash") continue;
          const entry = signalByAsset.get(asset);
          if (!entry) continue;
          rawWeights[asset] = (rawWeights[asset] ?? 0) + allocationModel[entry.signal];
        }

        // Apply regime-based secondary adjustments (smaller than signal adjustments).
        // Use regime metrics provided by the regime engine (already logged there).
        if (!processedAllocationClusters.has(clusterId)) {
          logDebug("REGIME_CONFIDENCE", { cluster_id: clusterId, confidence: regimeConfidence });
          logDebug("REGIME_ADJUSTMENT_STRENGTH", { cluster_id: clusterId, adjustmentStrength: regimeStrength });
        }

        // Apply small biases depending on finalRegime (keep signals primary)
        // inflationary: commodities up, bonds down
        // risk_off: bonds up, equities down
        // growth: equities up, commodities up
        // deflationary: bonds up, equities down
        switch (finalRegime) {
          case "inflationary":
            rawWeights["commodities"] = (rawWeights["commodities"] ?? 0) + regimeStrength;
            rawWeights["bonds"] = (rawWeights["bonds"] ?? 0) - regimeStrength;
            break;
          case "risk_off":
            rawWeights["bonds"] = (rawWeights["bonds"] ?? 0) + regimeStrength;
            rawWeights["equities"] = (rawWeights["equities"] ?? 0) - regimeStrength;
            break;
          case "growth":
            rawWeights["equities"] = (rawWeights["equities"] ?? 0) + regimeStrength;
            rawWeights["commodities"] = (rawWeights["commodities"] ?? 0) + regimeStrength;
            break;
          case "deflationary":
            rawWeights["bonds"] = (rawWeights["bonds"] ?? 0) + regimeStrength;
            rawWeights["equities"] = (rawWeights["equities"] ?? 0) - regimeStrength;
            break;
        }

        const normalized = normalizeAllocations(rawWeights);

        const clusterConfidence = Math.min(
          0.95,
          Math.max(0.5, avg(Array.from(signalByAsset.values()).map((v) => v.confidence))),
        );

        const inserts = Object.entries(normalized).map(([asset, allocation]) => {
          const entry = signalByAsset.get(asset);
          const confidence = entry?.confidence ?? clusterConfidence;
          const action = entry?.signal ?? "NEUTRAL";
          return {
            cluster_id: clusterId,
            asset,
            action,
            weight: allocation,
            confidence,
          };
        });

        const prevStateRows = (prevAllocRows as Array<{ asset: string | null; weight: number | null }> | null) ?? [];
        const prev = prevStateRows.length > 0 ? toAllocationState(prevStateRows) : null;
        const current: AllocationState = Object.fromEntries(
          Object.entries(normalized).map(([k, v]) => [k.toLowerCase(), v]),
        );

        const significantChange = hasSignificantAllocationChange({
          prev,
          current,
          baseWeights: Object.fromEntries(Object.entries(baseWeights).map(([k, v]) => [k.toLowerCase(), v])),
        });

        const deleteAllocQuery = supabase
          .from("event_allocations")
          .delete()
          .eq("cluster_id", clusterId);
        const { value: deleteAllocResult, durationMs: deleteAllocDurationMs } = await measureAsyncOperation(() => deleteAllocQuery);
        logQueryTiming("event_allocations.delete", deleteAllocDurationMs, { cluster_id: clusterId });
        const { error: deleteError } = deleteAllocResult;

        if (deleteError) {
          throw new Error(`Failed to clear existing allocations: ${deleteError.message}`);
        }

        // Log allocation decision once per asset per cluster
        const seenAssets = processedAllocationAssets.get(clusterId) ?? new Set<string>();
        for (const ins of inserts) {
          if (!seenAssets.has(ins.asset)) {
            logDebug("ALLOCATION_DECISION", { cluster_id: ins.cluster_id, asset: ins.asset, action: ins.action, weight: ins.weight, confidence: ins.confidence });
            seenAssets.add(ins.asset);
          }
        }
        processedAllocationAssets.set(clusterId, seenAssets);

        const insertAllocQuery = supabase
          .from("event_allocations")
          .insert(inserts);
        const { value: insertAllocResult, durationMs: insertAllocDurationMs } = await measureAsyncOperation(() => insertAllocQuery);
        logQueryTiming("event_allocations.insert", insertAllocDurationMs, { cluster_id: clusterId, rows: inserts.length });
        const { error: insertError } = insertAllocResult;

        if (insertError) {
          logError("ALLOCATION_INSERT_ERROR", { cluster_id: clusterId, error: insertError });
          throw new Error(`Failed to insert event allocations: ${insertError.message}`);
        }

        // Mark cluster as processed for this run to avoid duplicate logs/work
        processedAllocationClusters.add(clusterId);

        const markEventQuery = supabase
          .from("pipeline_events")
          .update({ processed: true })
          .eq("id", evt.id);
        const { value: markEventResult, durationMs: markEventDurationMs } = await measureAsyncOperation(() => markEventQuery);
        logQueryTiming("pipeline_events.mark_processed", markEventDurationMs, { cluster_id: clusterId, event_id: evt.id });
        const { error: markEventError } = markEventResult;

        if (markEventError) {
          logError("PIPELINE_EVENT_MARK_ERROR", { cluster_id: clusterId, eventId: evt.id, error: markEventError.message });
          throw new Error(`Failed to mark pipeline event processed: ${markEventError.message}`);
        }

        await emitClusterEventOnce({
          supabase,
          eventType: "ALLOCATION_COMPLETED",
          clusterId,
          payload: { significant_change: significantChange },
        });
        const allocationExecutionDurationMs = Date.now() - allocationExecutionStartedAt;
        recordAllocationExecutionMs(allocationExecutionDurationMs);
        logEvent("ALLOCATION_EXECUTION_DURATION", {
          run_id: workerRunId,
          cluster_id: clusterId,
          duration_ms: allocationExecutionDurationMs,
        }, "INFO");
        recordClusterProcessed();
        clusterStatus = "success";
          },
        });
      } catch (err) {
        clusterStatus = "failure";
        recordAllocationFailure();
        await recordPipelineDeadLetter({
          supabase,
          id: evt.id,
          clusterId,
          stageName: "allocation",
          err,
        });

        const { error: markError } = await supabase
          .from("pipeline_events")
          .update({ processed: true })
          .eq("id", evt.id);
        if (markError) {
          logError("PIPELINE_EVENT_MARK_ERROR", { cluster_id: clusterId, eventId: evt.id, error: markError.message });
        }
      } finally {
        const clusterDurationMs = Date.now() - clusterStartedAt;
        const highLatency = clusterDurationMs >= 2_500;
        logEvent("ALLOCATION_CLUSTER_DURATION", {
          run_id: workerRunId,
          cluster_id: clusterId,
          duration_ms: clusterDurationMs,
          status: clusterStatus,
        }, highLatency ? "WARN" : "INFO");

        if (highLatency) {
          logWarn("ALLOCATION_HIGH_LATENCY", {
            run_id: workerRunId,
            cluster_id: clusterId,
            duration_ms: clusterDurationMs,
            threshold_ms: 2_500,
          });
        }
      }
    },
    { concurrency: Number(process.env.PIPELINE_CONCURRENCY ?? 5) || 5 },
  );

  const metrics = getPerformanceSnapshot();
  logEvent("ALLOCATION_METRICS_SNAPSHOT", { run_id: workerRunId, ...metrics }, "INFO");
  logEvent("ALLOCATION_WORKER_RUN_COMPLETE", { run_id: workerRunId, processed: processedAllocationClusters.size }, "INFO");
}
