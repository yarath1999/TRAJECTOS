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
import { runPipelineOrchestrator } from "./pipelineOrchestrator";
import { runEventValidationEngine } from "./eventValidationEngine";
import { runFactorEngine } from "./factorEngine";
import { runImpactEngine } from "./impactEngine";
import { runPortfolioSignalEngine } from "./portfolioSignalEngine";
import { runInsightEngine } from "./insightEngine";
import { runAllocationEngine } from "./allocationEngine";
import { runDeadLetterRetry } from "./pipelineDeadLetterService";

const NOTIFY_CHANNEL = "pipeline_events_channel";
const LISTEN_RECONNECT_DELAY_MS = 5000;
const IDLE_POLL_MIN_MS = 10_000;
const IDLE_POLL_MAX_MS = 30_000;

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
  console.log("[pipelineWorker] starting worker loop");

  const supabase = createSupabaseServerClient();

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
      const client = new Client({
        connectionString: databaseUrl,
        ssl: wantsSsl ? { rejectUnauthorized: false } : undefined,
      });

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
        });
      } catch (err) {
        console.error("[pipelineWorker] LISTEN loop failed; will reconnect:", toError(err));
      } finally {
        try {
          client.removeAllListeners();
          await client.end();
        } catch {
          // ignore
        }
      }

      await sleep(LISTEN_RECONNECT_DELAY_MS);
    }
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

  while (true) {
    let didWork = false;

    try {
      await runSafely("dead-letter retry", () => runDeadLetterRetry({ supabase }));
      await runSafely("orchestrator", () => runPipelineOrchestrator());

      if (await hasPendingEvents("VALIDATION_REQUIRED")) {
        await runSafely("validation engine", runEventValidationEngine);
        console.log("[pipelineWorker] validation processed");
        didWork = true;
      }

      if (await hasPendingEvents("FACTOR_REQUIRED")) {
        await runSafely("factor engine", runFactorEngine);
        console.log("[pipelineWorker] factor processed");
        didWork = true;
      }

      if (await hasPendingEvents("IMPACT_REQUIRED")) {
        await runSafely("impact engine", runImpactEngine);
        console.log("[pipelineWorker] impact processed");
        didWork = true;
      }

      if (await hasPendingEvents("SIGNAL_REQUIRED")) {
        await runSafely("signal engine", runPortfolioSignalEngine);
        console.log("[pipelineWorker] signal processed");
        didWork = true;
      }

      if (await hasPendingEvents("INSIGHT_REQUIRED")) {
        await runSafely("insight engine", runInsightEngine);
        console.log("[pipelineWorker] insight processed");
        didWork = true;
      }

      if (await hasPendingEvents("ALLOCATION_REQUIRED")) {
        await runSafely("allocation engine", runAllocationEngine);
        console.log("[pipelineWorker] allocation processed");
        didWork = true;
      }
    } catch (err) {
      // Extra safety net: nothing inside the loop should be able to crash the worker.
      console.error("[pipelineWorker] unexpected worker loop error:", toError(err));
    }

    const delay = didWork ? 1000 : jitter(IDLE_POLL_MIN_MS, IDLE_POLL_MAX_MS);
    await sleepOrWake(delay);
  }
})();
