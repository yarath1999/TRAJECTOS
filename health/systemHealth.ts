import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { analyzeRegime } from "../services/regimeEngine";
import { measureAsyncOperation } from "../utils/performanceTracker";
import { logDebug, logWarn } from "../utils/logger";

type HealthCheckName =
  | "db_connectivity"
  | "worker_status"
  | "allocation_engine_readiness"
  | "regime_engine_readiness";

export type HealthCheckResult = {
  name: HealthCheckName;
  ok: boolean;
  details: string;
  meta?: Record<string, unknown>;
};

export type SystemHealthReport = {
  ok: boolean;
  checkedAt: string;
  checks: HealthCheckResult[];
  diagnostics: string[];
};

const WORKER_STAGE_NAMES = ["validation", "factor", "impact", "signal", "insight", "allocation"] as const;
const WORKER_STALE_MINUTES = 15;
const WORKER_IDLE_GRACE_MINUTES = 60;
let healthSupabaseClient: SupabaseClient | null = null;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function createHealthSupabaseClient(): SupabaseClient {
  if (healthSupabaseClient) return healthSupabaseClient;

  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!key) {
    throw new Error(
      "Missing Supabase key. Set SUPABASE_SERVICE_ROLE_KEY (recommended) or NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }

  healthSupabaseClient = createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return healthSupabaseClient;
}

function minutesAgoIso(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function normalizeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name || "Error";
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

async function checkDbConnectivity(supabase: SupabaseClient): Promise<HealthCheckResult> {
  const { value, durationMs } = await measureAsyncOperation(() =>
    supabase.from("pipeline_events").select("id", { head: true, count: "exact" }).limit(1),
  );
  const { error } = value;
  if (durationMs > 500) {
    logWarn("HEALTHCHECK_SLOW_QUERY", { check: "db_connectivity", duration_ms: durationMs });
  } else {
    logDebug("HEALTHCHECK_QUERY_TIMING", { check: "db_connectivity", duration_ms: durationMs });
  }

  if (error) {
    return {
      name: "db_connectivity",
      ok: false,
      details: `Database query failed: ${error.message}`,
      meta: { code: (error as { code?: string }).code ?? null },
    };
  }

  return {
    name: "db_connectivity",
    ok: true,
    details: "Database connectivity verified",
  };
}

async function checkWorkerStatus(supabase: SupabaseClient): Promise<HealthCheckResult> {
  const cutoffIso = minutesAgoIso(WORKER_STALE_MINUTES);
  const graceIso = minutesAgoIso(WORKER_IDLE_GRACE_MINUTES);

  const runtimeQuery = supabase
    .from("pipeline_stage_runtime")
    .select("stage_name,end_time,status")
    .in("stage_name", [...WORKER_STAGE_NAMES])
    .order("end_time", { ascending: false })
    .limit(200);
  const { value: runtimeValue, durationMs: runtimeDurationMs } = await measureAsyncOperation(() => runtimeQuery);
  if (runtimeDurationMs > 500) {
    logWarn("HEALTHCHECK_SLOW_QUERY", { check: "worker_status.runtime", duration_ms: runtimeDurationMs });
  } else {
    logDebug("HEALTHCHECK_QUERY_TIMING", { check: "worker_status.runtime", duration_ms: runtimeDurationMs });
  }
  const { data: runtimeRows, error: runtimeError } = runtimeValue;

  if (runtimeError) {
    return {
      name: "worker_status",
      ok: false,
      details: `Failed to query worker runtime: ${runtimeError.message}`,
      meta: { cutoffIso },
    };
  }

  const rows = (runtimeRows as Array<{ stage_name?: string | null; end_time?: string | null; status?: string | null }> | null) ?? [];
  const latestByStage = new Map<string, { endTime: string; status: string | null }>();
  for (const row of rows) {
    const stage = (row.stage_name ?? "").toString().trim();
    const endTime = (row.end_time ?? "").toString().trim();
    if (!stage || !endTime || latestByStage.has(stage)) continue;
    latestByStage.set(stage, { endTime, status: (row.status ?? null) as string | null });
  }

  const staleStages: string[] = [];
  const healthyStages: string[] = [];
  for (const stage of WORKER_STAGE_NAMES) {
    const latest = latestByStage.get(stage);
    if (!latest) {
      staleStages.push(stage);
      continue;
    }

    const ageMs = Date.now() - Date.parse(latest.endTime);
    if (!Number.isFinite(ageMs) || ageMs > WORKER_STALE_MINUTES * 60_000) {
      staleStages.push(stage);
    } else {
      healthyStages.push(stage);
    }
  }

  const backlogQuery = supabase
    .from("pipeline_events")
    .select("id")
    .eq("processed", false)
    .limit(1);
  const { value: backlogValue, durationMs: backlogDurationMs } = await measureAsyncOperation(() => backlogQuery);
  if (backlogDurationMs > 500) {
    logWarn("HEALTHCHECK_SLOW_QUERY", { check: "worker_status.backlog", duration_ms: backlogDurationMs });
  } else {
    logDebug("HEALTHCHECK_QUERY_TIMING", { check: "worker_status.backlog", duration_ms: backlogDurationMs });
  }
  const { data: backlogRows, error: backlogError } = backlogValue;

  if (backlogError) {
    return {
      name: "worker_status",
      ok: false,
      details: `Failed to query pipeline backlog: ${backlogError.message}`,
      meta: { cutoffIso },
    };
  }

  const backlog = Array.isArray(backlogRows) && backlogRows.length > 0 ? 1 : 0;
  const hasRecentWorkerActivity = healthyStages.length > 0;

  if (backlog > 0 && !hasRecentWorkerActivity) {
    return {
      name: "worker_status",
      ok: false,
      details: `Workers appear stale: backlog=${backlog} and no runtime within ${WORKER_STALE_MINUTES}m`,
      meta: {
        backlog,
        staleStages,
        healthyStages,
        cutoffIso,
      },
    };
  }

  // Idle is acceptable when there is no backlog and the worker loop has been quiet.
  const recentlyIdle = backlog === 0 && healthyStages.length === 0;

  return {
    name: "worker_status",
    ok: true,
    details: recentlyIdle
      ? `Workers are idle with no backlog and no runtime in the last ${WORKER_IDLE_GRACE_MINUTES}m`
      : `Workers active: backlog=${backlog}, healthy_stages=${healthyStages.length}`,
    meta: {
      backlog,
      healthyStages,
      staleStages,
      cutoffIso,
    },
  };
}

async function checkAllocationEngineReadiness(supabase: SupabaseClient): Promise<HealthCheckResult> {
  const [insightResultTimed, allocationResultTimed] = await Promise.all([
    measureAsyncOperation(() =>
      supabase
        .from("event_insights")
        .select("cluster_id,reasoning,confidence")
        .limit(1),
    ),
    measureAsyncOperation(() =>
      supabase
        .from("event_allocations")
        .select("cluster_id,asset,action,weight,confidence")
        .limit(1),
    ),
  ]);
  const insightResult = insightResultTimed.value;
  const allocationResult = allocationResultTimed.value;
  const insightDurationMs = insightResultTimed.durationMs;
  const allocationDurationMs = allocationResultTimed.durationMs;

  for (const [check, durationMs] of [["allocation_engine_readiness.insights", insightDurationMs], ["allocation_engine_readiness.allocations", allocationDurationMs]] as const) {
    if (durationMs > 500) logWarn("HEALTHCHECK_SLOW_QUERY", { check, duration_ms: durationMs });
    else logDebug("HEALTHCHECK_QUERY_TIMING", { check, duration_ms: durationMs });
  }

  if (insightResult.error) {
    return {
      name: "allocation_engine_readiness",
      ok: false,
      details: `Failed to read event_insights: ${insightResult.error.message}`,
    };
  }

  if (allocationResult.error) {
    return {
      name: "allocation_engine_readiness",
      ok: false,
      details: `Failed to read event_allocations: ${allocationResult.error.message}`,
    };
  }

  return {
    name: "allocation_engine_readiness",
    ok: true,
    details: "Allocation engine prerequisites are readable",
    meta: {
      eventInsightsRows: Array.isArray(insightResult.data) ? insightResult.data.length : 0,
      eventAllocationsRows: Array.isArray(allocationResult.data) ? allocationResult.data.length : 0,
    },
  };
}

async function checkRegimeEngineReadiness(supabase: SupabaseClient): Promise<HealthCheckResult> {
  const sampleReasoning = {
    signals: [
      { source_factor: "equities", direction: "BUY", confidence: 0.8 },
      { source_factor: "bonds", direction: "SELL", confidence: 0.7 },
    ],
    regime: "growth",
  };

  let regimeResult;
  try {
    regimeResult = analyzeRegime(sampleReasoning);
  } catch (err) {
    return {
      name: "regime_engine_readiness",
      ok: false,
      details: `Regime engine failed to analyze sample reasoning: ${normalizeError(err)}`,
    };
  }

  if (!regimeResult.finalRegime || !Number.isFinite(regimeResult.adjustmentStrength)) {
    return {
      name: "regime_engine_readiness",
      ok: false,
      details: "Regime engine returned an invalid result for sample reasoning",
      meta: {
        result: regimeResult,
      },
    };
  }

  const regimeReadQuery = supabase
    .from("event_insights")
    .select("reasoning")
    .limit(1);
  const { value: regimeReadValue, durationMs: regimeReadDurationMs } = await measureAsyncOperation(() => regimeReadQuery);
  if (regimeReadDurationMs > 500) {
    logWarn("HEALTHCHECK_SLOW_QUERY", { check: "regime_engine_readiness", duration_ms: regimeReadDurationMs });
  } else {
    logDebug("HEALTHCHECK_QUERY_TIMING", { check: "regime_engine_readiness", duration_ms: regimeReadDurationMs });
  }
  const { error: queryError } = regimeReadValue;

  if (queryError) {
    return {
      name: "regime_engine_readiness",
      ok: false,
      details: `Unable to read event_insights.reasoning: ${queryError.message}`,
    };
  }

  return {
    name: "regime_engine_readiness",
    ok: true,
    details: "Regime engine analyzed sample reasoning successfully",
    meta: {
      finalRegime: regimeResult.finalRegime,
      smoothedRegime: regimeResult.smoothedRegime,
      confidence: regimeResult.confidence,
      adjustmentStrength: regimeResult.adjustmentStrength,
    },
  };
}

export async function runSystemHealthCheck(): Promise<SystemHealthReport> {
  const checkedAt = new Date().toISOString();
  const diagnostics: string[] = [];
  const checks: HealthCheckResult[] = [];

  let supabase: SupabaseClient | null = null;
  try {
    supabase = createHealthSupabaseClient();
  } catch (err) {
    const message = normalizeError(err);
    const failureCheck: HealthCheckResult = {
      name: "db_connectivity",
      ok: false,
      details: message,
    };

    return {
      ok: false,
      checkedAt,
      checks: [failureCheck],
      diagnostics: [message],
    };
  }

  // TODO: add cross-process worker heartbeats if these health checks need to cover horizontally scaled workers.
  const [dbConnectivity, workerStatus, allocationEngineReadiness, regimeEngineReadiness] = await Promise.all([
    checkDbConnectivity(supabase),
    checkWorkerStatus(supabase),
    checkAllocationEngineReadiness(supabase),
    checkRegimeEngineReadiness(supabase),
  ]);

  checks.push(dbConnectivity, workerStatus, allocationEngineReadiness, regimeEngineReadiness);

  for (const check of checks) {
    if (!check.ok) {
      diagnostics.push(`${check.name}: ${check.details}`);
      if (check.meta) {
        diagnostics.push(`${check.name}.meta: ${JSON.stringify(check.meta)}`);
      }
    }
  }

  const ok = checks.every((check) => check.ok);

  return {
    ok,
    checkedAt,
    checks,
    diagnostics,
  };
}