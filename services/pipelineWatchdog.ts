import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });
import { createSupabaseServerClient } from "./newsFetcher";
import { emitClusterEventOnce } from "./pipelineEventUtils";
import { fileURLToPath } from "url";
import path from "path";
import { logEvent, logWarn } from "../utils/logger";
import { validateEnvOrThrow } from "../utils/validateEnv";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let shutdownRequested = false;
let shutdownSignal: NodeJS.Signals | null = null;
let shutdownResolver: (() => void) | null = null;

function requestShutdown(signal: NodeJS.Signals): void {
  if (shutdownRequested) return;
  shutdownRequested = true;
  shutdownSignal = signal;
  logEvent("PIPELINE_WATCHDOG_SHUTDOWN_REQUESTED", { signal }, "WARN");

  if (shutdownResolver) {
    const resolve = shutdownResolver;
    shutdownResolver = null;
    resolve();
  }
}

function sleepOrShutdown(ms: number): Promise<void> {
  if (shutdownRequested) return Promise.resolve();
  return Promise.race([
    sleep(ms),
    new Promise<void>((resolve) => {
      shutdownResolver = resolve;
    }),
  ]);
}

process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

type ClusterRow = {
  id: string;
  created_at?: string | null;
};

type PipelineEventRow = {
  id: string;
  event_type?: string | null;
  created_at?: string | null;
};

type RuntimeRow = {
  stage_name?: string | null;
  end_time?: string | null;
};

type FailureRow = {
  stage_name?: string | null;
  occurred_at?: string | null;
};

const WORKER_STAGE_NAMES = ["validation", "factor", "impact", "signal", "insight", "allocation"] as const;
const WORKER_STALE_MINUTES = 15;
const BACKLOG_SPIKE_MULTIPLIER = 2;
const BACKLOG_SPIKE_MIN_DELTA = 50;
const ALLOCATION_FAILURE_WINDOW_MINUTES = 15;
const ALLOCATION_FAILURE_ALERT_THRESHOLD = 3;

let lastBacklogSize: number | null = null;
let lastBacklogSampleAt: number | null = null;

async function getPipelineBacklogSize(): Promise<number> {
  const supabase = createSupabaseServerClient();
  const { count, error } = await supabase
    .from("pipeline_events")
    .select("id", { head: true, count: "exact" })
    .eq("processed", false);

  if (error) return 0;
  return count ?? 0;
}

async function listStuckUnvalidatedClusters(cutoffIso: string, limit = 100): Promise<string[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("event_clusters")
    .select("id")
    .eq("validated", false)
    .lt("created_at", cutoffIso)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) return [];
  const rows = (data as ClusterRow[] | null) ?? [];
  return rows.map((r) => (r.id ?? "").toString().trim()).filter(Boolean);
}

async function listValidatedClustersMissingFactors(cutoffIso: string, limit = 100): Promise<string[]> {
  const supabase = createSupabaseServerClient();

  // Validated clusters that still have no factor exposures.
  const { data, error } = await supabase
    .from("event_clusters")
    .select("id,event_factor_exposures!left(id)")
    .eq("validated", true)
    .lt("created_at", cutoffIso)
    .is("event_factor_exposures.id", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) return [];
  const rows = (data as Array<ClusterRow & { event_factor_exposures?: unknown }> | null) ?? [];
  return rows.map((r) => (r.id ?? "").toString().trim()).filter(Boolean);
}

async function listValidatedClustersMissingImpacts(cutoffIso: string, limit = 100): Promise<string[]> {
  const supabase = createSupabaseServerClient();

  // Validated clusters that still have no impact scores.
  const { data, error } = await supabase
    .from("event_clusters")
    .select("id,event_impact_scores!left(id)")
    .eq("validated", true)
    .lt("created_at", cutoffIso)
    .is("event_impact_scores.id", null)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) return [];
  const rows = (data as Array<ClusterRow & { event_impact_scores?: unknown }> | null) ?? [];
  return rows.map((r) => (r.id ?? "").toString().trim()).filter(Boolean);
}

async function listStalePipelineEvents(cutoffIso: string, limit = 200): Promise<PipelineEventRow[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("pipeline_events")
    .select("id,event_type,created_at")
    .eq("processed", false)
    .lt("created_at", cutoffIso)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) return [];
  return (data as PipelineEventRow[] | null) ?? [];
}

async function listWorkerRuntimeRows(limit = 200): Promise<RuntimeRow[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("pipeline_stage_runtime")
    .select("stage_name,end_time")
    .in("stage_name", [...WORKER_STAGE_NAMES])
    .order("end_time", { ascending: false })
    .limit(limit);

  if (error) return [];
  return (data as RuntimeRow[] | null) ?? [];
}

async function listRecentAllocationFailures(sinceIso: string, limit = 200): Promise<FailureRow[]> {
  const supabase = createSupabaseServerClient();
  const { data, error } = await supabase
    .from("pipeline_failures")
    .select("stage_name,occurred_at")
    .eq("stage_name", "allocation")
    .gte("occurred_at", sinceIso)
    .order("occurred_at", { ascending: false })
    .limit(limit);

  if (error) return [];
  return (data as FailureRow[] | null) ?? [];
}

async function tick(): Promise<void> {
  const backlog = await getPipelineBacklogSize();
  const nowMs = Date.now();

  if (
    lastBacklogSize !== null &&
    backlog >= BACKLOG_SPIKE_MIN_DELTA &&
    backlog >= lastBacklogSize * BACKLOG_SPIKE_MULTIPLIER
  ) {
    logWarn("PIPELINE_BACKLOG_SPIKE", {
      backlog,
      previousBacklog: lastBacklogSize,
      previousSampleAt: lastBacklogSampleAt ? new Date(lastBacklogSampleAt).toISOString() : null,
      delta: backlog - lastBacklogSize,
    });
  }

  lastBacklogSize = backlog;
  lastBacklogSampleAt = nowMs;

  const cutoffIso = minutesAgoIso(10);
  const stuckUnvalidated = await listStuckUnvalidatedClusters(cutoffIso, 200);

  // "Stuck after factor/impact" is interpreted as: validated clusters that have not produced
  // factor exposures and/or impact scores after enough time has passed.
  const missingFactors = await listValidatedClustersMissingFactors(cutoffIso, 200);
  const missingImpacts = await listValidatedClustersMissingImpacts(cutoffIso, 200);
  const staleEvents = await listStalePipelineEvents(minutesAgoIso(15), 200);
  const runtimeRows = await listWorkerRuntimeRows(200);
  const recentAllocationFailures = await listRecentAllocationFailures(minutesAgoIso(ALLOCATION_FAILURE_WINDOW_MINUTES), 200);

  const healthyWorkerStages = new Set<string>();
  for (const row of runtimeRows) {
    const stage = (row.stage_name ?? "").toString().trim();
    const endTime = (row.end_time ?? "").toString().trim();
    if (!stage || !endTime) continue;
    const ageMs = nowMs - Date.parse(endTime);
    if (Number.isFinite(ageMs) && ageMs <= WORKER_STALE_MINUTES * 60_000) {
      healthyWorkerStages.add(stage);
    }
  }

  if (backlog > 0 && healthyWorkerStages.size === 0) {
    logWarn("PIPELINE_WORKER_INACTIVITY", {
      backlog,
      staleMinutes: WORKER_STALE_MINUTES,
      healthyStages: Array.from(healthyWorkerStages),
      message: "No recent worker runtime and backlog remains queued",
    });
  }

  if (recentAllocationFailures.length >= ALLOCATION_FAILURE_ALERT_THRESHOLD) {
    logWarn("PIPELINE_ALLOCATION_FAILURES_REPEATED", {
      count: recentAllocationFailures.length,
      windowMinutes: ALLOCATION_FAILURE_WINDOW_MINUTES,
      oldestOccurredAt: recentAllocationFailures[recentAllocationFailures.length - 1]?.occurred_at ?? null,
    });
  }

  const hasBacklogWarning = backlog > 1000;
  const hasStuckWarning =
    stuckUnvalidated.length > 0 || missingFactors.length > 0 || missingImpacts.length > 0;

  if (hasBacklogWarning || hasStuckWarning) {
    console.warn(
      `[pipelineWatchdog] WARNING: backlog=${backlog} stuck_unvalidated=${stuckUnvalidated.length} missing_factors=${missingFactors.length} missing_impacts=${missingImpacts.length}`,
    );
  } else {
    console.log(`[pipelineWatchdog] ok backlog=${backlog}`);
  }

  if (staleEvents.length > 0) {
    logWarn("PIPELINE_STALE_EVENTS", {
      count: staleEvents.length,
      oldestCreatedAt: staleEvents[0]?.created_at ?? null,
      eventTypes: Array.from(new Set(staleEvents.map((row) => (row.event_type ?? "unknown").toString().trim() || "unknown"))),
    });
  }

  // Recovery strategy:
  // - Unvalidated > 10m: re-emit CLUSTER_CREATED (kicks validation/orchestration)
  // - Validated but missing factor/impact: re-emit CLUSTER_VALIDATED
  // This service must not mutate other tables.
  const supabase = createSupabaseServerClient();

  for (const clusterId of stuckUnvalidated.slice(0, 100)) {
    await emitClusterEventOnce({
      supabase,
      eventType: "CLUSTER_CREATED",
      clusterId,
    });
  }

  const validatedRecoveryTargets = new Set<string>([...missingFactors, ...missingImpacts]);
  for (const clusterId of Array.from(validatedRecoveryTargets).slice(0, 100)) {
    await emitClusterEventOnce({
      supabase,
      eventType: "CLUSTER_VALIDATED",
      clusterId,
    });
  }
}

/**
 * Watches pipeline health and attempts self-healing by re-emitting pipeline events.
 *
 * - Runs every 60 seconds
 * - Never modifies data directly other than emitting recovery events to pipeline_events
 */
export async function runPipelineWatchdog(): Promise<void> {
  validateEnvOrThrow({
    serviceName: "pipelineWatchdog",
    required: ["NEXT_PUBLIC_SUPABASE_URL"],
    anyOf: [
      {
        names: ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY"],
        label: "SUPABASE_SERVICE_ROLE_KEY | SUPABASE_SERVICE_KEY",
      },
    ],
  });

  logEvent("PIPELINE_WATCHDOG_START", {}, "INFO");

  while (!shutdownRequested) {
    try {
      await tick();
    } catch (err) {
      logWarn("PIPELINE_WATCHDOG_TICK_FAILED", {
        error: err instanceof Error ? err.stack ?? err.message : String(err),
      });
    }

    await sleepOrShutdown(60_000);
  }

  logEvent("PIPELINE_WATCHDOG_SHUTDOWN_COMPLETE", { signal: shutdownSignal }, "INFO");
}

// Exposed for tests/scripts.
export async function runPipelineWatchdogOnce(): Promise<void> {
  await tick();
}

function isMainModule(): boolean {
  try {
    const current = fileURLToPath(import.meta.url);
    const invoked = process.argv[1] ?? "";
    const invokedAbs = path.resolve(process.cwd(), invoked);
    return path.normalize(invokedAbs).toLowerCase() === path.normalize(current).toLowerCase();
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runPipelineWatchdog().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
