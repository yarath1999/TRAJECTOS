import "./loadEnv";

process.on("unhandledRejection", (reason) => {
  if (reason instanceof Error) {
    console.error("[FATAL] Unhandled Rejection:", reason.stack ?? reason.message);
    return;
  }

  console.error("[FATAL] Unhandled Rejection:", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught Exception:", err.stack ?? err.message);
});

process.on("exit", (code) => {
  console.error("[FATAL] Process exiting:", code);
});

import { Client } from "pg";

import { createSupabaseServerClient } from "./newsFetcher";
import { logEvent, logError, logDebug, logWarn } from "../utils/logger";
import { runPipelineOrchestrator } from "./pipelineOrchestrator";
import { runEventValidationEngine } from "./eventValidationEngine";
import { runFactorEngine } from "./factorEngine";
import { runImpactEngine } from "./impactEngine";
import { runPortfolioSignalEngine } from "./portfolioSignalEngine";
import { runInsightEngine } from "./insightEngine";
import { runAllocationEngine } from "./allocationEngine";
import { replayFallbackDeadLetters, runDeadLetterRetry } from "./pipelineDeadLetterService";
import { scoreRegimeSignals, type MacroRegime } from "./regimeEngine";
import { validateEnvOrThrow } from "../utils/validateEnv";

// Analytics state: counts, strength aggregation, transitions, and per-cluster last regime.
const regimeAnalytics = {
  counts: {
    inflationary: 0,
    risk_off: 0,
    growth: 0,
    deflationary: 0,
    null: 0,
  } as Record<string, number>,
  strengthSum: 0,
  strengthCount: 0,
  transitions: 0,
};

const clusterLastRegime: Map<string, MacroRegime | null> = new Map();
let processedClustersSinceReport = 0;
// TODO: persist regime analytics to a durable store once worker volume makes in-memory reporting insufficient.

const NOTIFY_CHANNEL = "pipeline_events_channel";
const LISTEN_RECONNECT_DELAY_MS = 5000;
const IDLE_POLL_MIN_MS = 10_000;
const IDLE_POLL_MAX_MS = 30_000;

let shutdownRequested = false;
let shutdownSignal: NodeJS.Signals | null = null;
let shutdownResolver: (() => void) | null = null;
let pgListenerClient: Client | null = null;

function requestShutdown(signal: NodeJS.Signals): void {
  if (shutdownRequested) return;
  shutdownRequested = true;
  shutdownSignal = signal;
  logEvent("PIPELINE_WORKER_SHUTDOWN_REQUESTED", { signal }, "WARN");
  signalWake();

  if (pgListenerClient) {
    void pgListenerClient.end().catch((err) => {
      logWarn("PIPELINE_WORKER_LISTENER_CLOSE_FAILED", {
        signal,
        error: toError(err),
      });
    });
  }

  if (shutdownResolver) {
    const resolve = shutdownResolver;
    shutdownResolver = null;
    resolve();
  }
}

function waitForShutdown(): Promise<void> {
  if (shutdownRequested) return Promise.resolve();
  return new Promise<void>((resolve) => {
    shutdownResolver = resolve;
  });
}

process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(minMs: number, maxMs: number): number {
  const min = Math.max(0, Math.floor(minMs));
  const max = Math.max(min, Math.floor(maxMs));
  return min + Math.floor(Math.random() * (max - min + 1));
}

function toError(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message || "Error";
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}

let wakeResolver: (() => void) | null = null;
let wakePending = false;

function signalWake(): void {
  wakePending = true;
  if (wakeResolver) {
    const resolve = wakeResolver;
    wakeResolver = null;
    resolve();
  }
}

async function sleepOrWake(ms: number): Promise<void> {
  if (wakePending) {
    wakePending = false;
    return;
  }

  await Promise.race([
    sleep(ms),
    new Promise<void>((resolve) => {
      wakeResolver = resolve;
    }),
    waitForShutdown(),
  ]);

  wakePending = false;
}

async function runSafely(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[pipelineWorker] ${label} failed:`, toError(err));
  }
}

(async () => {
  validateEnvOrThrow({
    serviceName: "pipelineWorker",
    required: ["NEXT_PUBLIC_SUPABASE_URL"],
    anyOf: [
      {
        names: ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY"],
        label: "SUPABASE_SERVICE_ROLE_KEY | SUPABASE_SERVICE_KEY",
      },
    ],
    optional: ["DATABASE_URL", "PGSSLMODE"],
  });

  logEvent("PIPELINE_WORKER_START", {}, "INFO");

  const supabase = createSupabaseServerClient();

  // Non-blocking startup recovery: replay locally persisted DLQ fallback records.
  void runSafely("dead-letter fallback replay", () => replayFallbackDeadLetters({ supabase }));

  const notifyHints = new Set<string>();

  async function handlePipelineEventById(eventId: string | null | undefined): Promise<void> {
    const id = (eventId ?? "").toString().trim();
    if (!id) return;

    try {
      const { data, error } = await supabase
        .from("pipeline_events")
        .select("id,event_type,processed")
        .eq("id", id)
        .maybeSingle();

      if (error) {
        console.error(
          "[pipelineWorker] failed to load pipeline event after notification; will wake worker:",
          error.message,
        );
        signalWake();
        return;
      }

      const row = (data as { id?: string; event_type?: string; processed?: boolean } | null) ?? null;
      const eventType = (row?.event_type ?? "").toString().trim();
      const processed = Boolean(row?.processed);

      if (processed) return;
      if (eventType) notifyHints.add(eventType);
    } catch (err) {
      console.error(
        "[pipelineWorker] failed to load pipeline event after notification; will wake worker:",
        toError(err),
      );
    } finally {
      // Always wake: even non-*_REQUIRED events may require orchestrator transitions.
      signalWake();
    }
  }

  async function startPgListener(): Promise<void> {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      console.warn(
        "[pipelineWorker] DATABASE_URL not set; LISTEN/NOTIFY disabled (falling back to polling)",
      );
      return;
    }

    const wantsSsl =
      databaseUrl.includes("sslmode=require") ||
      (process.env.PGSSLMODE ?? "").toLowerCase() === "require";

    while (true) {
      if (shutdownRequested) return;

      const client = new Client({
        connectionString: databaseUrl,
        ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
      });
      pgListenerClient = client;

      try {
        await client.connect();
        await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
        console.log(`[pipelineWorker] listening on ${NOTIFY_CHANNEL}`);

        client.on("notification", async (msg) => {
          if (msg.channel !== NOTIFY_CHANNEL) return;

          try {
            await handlePipelineEventById(msg.payload);
          } catch (err) {
            console.error(
              "[pipelineWorker] notification handler failed",
              err instanceof Error ? err.stack ?? err.message : err,
            );
          }
        });

        client.on("error", (err) => {
          console.error(
            "[pipelineWorker] pg listener error; will reconnect:",
            err.stack ?? err.message,
          );
        });

        // Keep this connection alive until it closes or errors.
        await new Promise<void>((resolve) => {
          client.once("end", resolve);
          client.once("error", () => resolve());
          if (shutdownRequested) resolve();
        });
      } catch (err) {
        if (shutdownRequested) break;
        console.error("[pipelineWorker] LISTEN loop failed; will reconnect:", toError(err));
      } finally {
        try {
          client.removeAllListeners();
          await client.end();
        } catch {
          // ignore
        }
        if (pgListenerClient === client) {
          pgListenerClient = null;
        }
      }

      if (shutdownRequested) break;
      await sleep(LISTEN_RECONNECT_DELAY_MS);
    }

    logEvent("PIPELINE_WORKER_LISTENER_STOPPED", { signal: shutdownSignal }, "INFO");
  }

  // Fire-and-forget: listener runs forever and only signals wake-ups.
  void startPgListener();

  async function hasPendingEvents(eventType: string): Promise<boolean> {
    // If we were notified about this event type, optimistically run the engine.
    if (notifyHints.has(eventType)) {
      notifyHints.delete(eventType);
      return true;
    }

    try {
      const { data, error } = await supabase
        .from("pipeline_events")
        .select("id")
        .eq("event_type", eventType)
        .eq("processed", false)
        .limit(1);

      if (error) {
        console.error(
          "[pipelineWorker] failed to query pipeline events; will run engine to avoid stalling:",
          error.message,
        );
        return true;
      }

      return ((data as Array<{ id: string }> | null) ?? []).length > 0;
    } catch (err) {
      console.error(
        "[pipelineWorker] failed to query pipeline events; will run engine to avoid stalling:",
        toError(err),
      );
      return true;
    }
  }

  while (!shutdownRequested) {
    let didWork = false;

    try {
      try {
        const { count, error: pendingError } = await supabase
          .from("pipeline_events")
          .select("id", { head: true, count: "exact" })
          .eq("processed", false);

        if (!pendingError) {
          logDebug("PIPELINE_PENDING_COUNT", { count: count ?? 0 });
        }
      } catch {
        // Best-effort; never block the worker loop on observability.
      }

      await runSafely("dead-letter retry", () => runDeadLetterRetry({ supabase }));
      await runSafely("orchestrator", () => runPipelineOrchestrator());

      if (await hasPendingEvents("VALIDATION_REQUIRED")) {
        await runSafely("validation engine", runEventValidationEngine);
        logDebug("PIPELINE_STAGE_PROCESSED", { stage: "validation" });
        didWork = true;
      }

      if (await hasPendingEvents("FACTOR_REQUIRED")) {
        await runSafely("factor engine", runFactorEngine);
        logDebug("PIPELINE_STAGE_PROCESSED", { stage: "factor" });
        didWork = true;
      }

      if (await hasPendingEvents("IMPACT_REQUIRED")) {
        await runSafely("impact engine", runImpactEngine);
        logDebug("PIPELINE_STAGE_PROCESSED", { stage: "impact" });
        didWork = true;
      }

      if (await hasPendingEvents("SIGNAL_REQUIRED")) {
        await runSafely("signal engine", runPortfolioSignalEngine);
        logDebug("PIPELINE_STAGE_PROCESSED", { stage: "signal" });
        didWork = true;
      }

      if (await hasPendingEvents("INSIGHT_REQUIRED")) {
        await runSafely("insight engine", runInsightEngine);
        logDebug("PIPELINE_STAGE_PROCESSED", { stage: "insight" });
        didWork = true;
      }

      if (await hasPendingEvents("ALLOCATION_REQUIRED")) {
        await runSafely("allocation engine", runAllocationEngine);
        logDebug("PIPELINE_STAGE_PROCESSED", { stage: "allocation" });
        didWork = true;
        // After allocations run, gather recent clusters and update regime analytics.
        try {
          const { data: recentAllocs, error: allocErr } = await supabase
            .from("event_allocations")
            .select("cluster_id,created_at")
            .order("created_at", { ascending: false })
            .limit(500);

          if (!allocErr && Array.isArray(recentAllocs)) {
            const seen: Set<string> = new Set();
            for (const r of recentAllocs as Array<{ cluster_id?: unknown }>) {
              const cid = (r.cluster_id ?? "").toString().trim();
              if (!cid) continue;
              if (seen.has(cid)) continue;
              seen.add(cid);

              // fetch latest reasoning for cluster
              const { data: insightRows, error: insightErr } = await supabase
                .from("event_insights")
                .select("reasoning")
                .eq("cluster_id", cid)
                .order("created_at", { ascending: false })
                .limit(1);

              let regime: MacroRegime | null = null;
              let strength = 0;
              if (!insightErr && Array.isArray(insightRows) && insightRows.length > 0) {
                const reasoning = (insightRows as Array<{ reasoning?: unknown }>)[0]?.reasoning;
                const scored = scoreRegimeSignals(
                  (() => {
                    let value: unknown = reasoning;
                    if (typeof value === "string") {
                      try {
                        value = JSON.parse(value);
                      } catch {
                        return [] as Array<{ direction?: unknown; confidence?: unknown; source_factor?: unknown }>;
                      }
                    }
                    if (!value || typeof value !== "object" || Array.isArray(value)) return [] as Array<{ direction?: unknown; confidence?: unknown; source_factor?: unknown }>;
                    const signals = (value as { signals?: unknown }).signals;
                    if (!Array.isArray(signals)) return [] as Array<{ direction?: unknown; confidence?: unknown; source_factor?: unknown }>;
                    return signals as Array<{ direction?: unknown; confidence?: unknown; source_factor?: unknown }>;
                  })(),
                );
                regime = scored.regime;
                const total = Object.values(scored.scores).reduce((a, b) => a + b, 0);
                strength = total > 0 ? scored.topScore / total : 0;
              }

              // update counts
              if (regime) {
                regimeAnalytics.counts[regime] = (regimeAnalytics.counts[regime] ?? 0) + 1;
              } else {
                regimeAnalytics.counts.null = (regimeAnalytics.counts.null ?? 0) + 1;
              }

              if (strength > 0) {
                regimeAnalytics.strengthSum += strength;
                regimeAnalytics.strengthCount += 1;
              }

              // transitions
              const last = clusterLastRegime.get(cid) ?? null;
              if (last !== regime) {
                if (last !== null) {
                  regimeAnalytics.transitions += 1;
                }
                clusterLastRegime.set(cid, regime);
              }

              processedClustersSinceReport += 1;
              if (processedClustersSinceReport >= 50) {
                // print summary
                const avgStrength = regimeAnalytics.strengthCount > 0 ? regimeAnalytics.strengthSum / regimeAnalytics.strengthCount : 0;
                logEvent("REGIME_ANALYTICS", {
                  inflationary: regimeAnalytics.counts.inflationary ?? 0,
                  risk_off: regimeAnalytics.counts.risk_off ?? 0,
                  growth: regimeAnalytics.counts.growth ?? 0,
                  deflationary: regimeAnalytics.counts.deflationary ?? 0,
                  null: regimeAnalytics.counts.null ?? 0,
                  transitions: regimeAnalytics.transitions ?? 0,
                  average_strength: Number(avgStrength.toFixed(3)),
                }, "INFO");

                // reset counters but keep last-known regimes map
                regimeAnalytics.counts = { inflationary: 0, risk_off: 0, growth: 0, deflationary: 0, null: 0 };
                regimeAnalytics.strengthSum = 0;
                regimeAnalytics.strengthCount = 0;
                regimeAnalytics.transitions = 0;
                processedClustersSinceReport = 0;
              }
            }
          }
        } catch (err) {
          logError("REGIME_ANALYTICS_FAILED", { error: toError(err) });
        }
      }
    } catch (err) {
      // Extra safety net: nothing inside the loop should be able to crash the worker.
      console.error("[pipelineWorker] unexpected worker loop error:", toError(err));
    }

    const delay = didWork ? 1000 : jitter(IDLE_POLL_MIN_MS, IDLE_POLL_MAX_MS);
    await sleepOrWake(delay);
  }

  logEvent("PIPELINE_WORKER_SHUTDOWN_COMPLETE", { signal: shutdownSignal }, "INFO");
})();
