import { Suspense, type ReactNode } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { runSystemHealthCheck } from "@/health/systemHealth";
import { validateEnvOrThrow } from "@/utils/validateEnv";
import { scoreRegimeSignals, type MacroRegime } from "@/services/regimeEngine";
import { createMemoryCache, measureAsyncOperation } from "@/utils/performanceTracker";
import { logDebug, logWarn } from "@/utils/logger";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type PipelineMetricRow = {
  processed_count: number | null;
  failure_count: number | null;
  backlog_size: number | null;
  window_start: string | null;
  stage_name: string | null;
};

type InsightRow = {
  cluster_id: string | null;
  reasoning: unknown;
  confidence: number | null;
  created_at: string | null;
};

type AllocationRow = {
  cluster_id: string | null;
  asset: string | null;
  action: string | null;
  weight: number | null;
  confidence: number | null;
  created_at: string | null;
};

type RuntimeRow = {
  stage_name: string | null;
  status: string | null;
  duration_ms: number | null;
  cluster_id: string | null;
  end_time: string | null;
};

type FailureRow = {
  stage_name: string | null;
  cluster_id: string | null;
  error_message: string | null;
  occurred_at: string | null;
};

type ClusterRow = {
  id: string | null;
  validated: boolean | null;
  created_at: string | null;
};

type HealthSummary = {
  health: string;
  worker: string;
  monitor: string;
  watchdog: string;
  healthDetail: string;
  workerDetail: string;
  monitorDetail: string;
  watchdogDetail: string;
};

type MetricSummary = {
  pendingEvents: number;
  processedEvents: number;
  failedEvents: number;
  queueBacklog: number;
  pendingError?: string | null;
  processedError?: string | null;
  failedError?: string | null;
};

type RegimeSnapshot = {
  currentRegime: MacroRegime | null;
  currentConfidence: number | null;
  smoothingResult: MacroRegime | null;
  history: Array<{
    regime: MacroRegime | null;
    confidence: number | null;
    createdAt: string;
  }>;
  transitions: Array<{
    from: MacroRegime;
    to: MacroRegime;
    createdAt: string;
  }>;
  distribution: Record<string, number>;
  averageConfidence: number | null;
};

type AllocationSnapshot = {
  clusterId: string | null;
  allocations: AllocationRow[];
  topAssets: AllocationRow[];
  timestamps: { first: string | null; latest: string | null };
};

type LogSnapshot = {
  runtime: RuntimeRow[];
  failures: FailureRow[];
};

type DashboardData = {
  health: HealthSummary;
  metrics: MetricSummary;
  regime: RegimeSnapshot;
  allocation: AllocationSnapshot;
  analytics: {
    regimeDistribution: Record<string, number>;
    averageConfidence: number | null;
    recentTransitions: Array<{ from: MacroRegime; to: MacroRegime; createdAt: string }>;
  };
  logs: LogSnapshot;
  errors: string[];
};

const regimeParseCache = createMemoryCache<string, ReturnType<typeof regimeFromReasoning>>(200);
type CachedHealthReport = {
  data: Awaited<ReturnType<typeof runSystemHealthCheck>>;
  createdAt: number;
};

const dashboardHealthCache =
  createMemoryCache<string, CachedHealthReport>(1);
let adminSupabaseClient: SupabaseClient | null = null;

function fmtNumber(value: number | null | undefined, fractionDigits = 2): string {
  if (!Number.isFinite(Number(value))) return "—";
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(Number(value));
}

function fmtTimestamp(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function badgeClass(state: "healthy" | "warning" | "degraded" | "neutral"): string {
  switch (state) {
    case "healthy":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
    case "warning":
      return "border-amber-500/30 bg-amber-500/10 text-amber-300";
    case "degraded":
      return "border-rose-500/30 bg-rose-500/10 text-rose-300";
    default:
      return "border-slate-500/30 bg-slate-500/10 text-slate-300";
  }
}

function statusFromBoolean(ok: boolean): { label: string; state: "healthy" | "warning" | "degraded" } {
  return ok ? { label: "Healthy", state: "healthy" } : { label: "Degraded", state: "degraded" };
}

function parseReasoningSignals(reasoning: unknown): Array<{ source_factor?: unknown; direction?: unknown; confidence?: unknown }> {
  let value: unknown = reasoning;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const signals = (value as { signals?: unknown }).signals;
  return Array.isArray(signals) ? (signals as Array<{ source_factor?: unknown; direction?: unknown; confidence?: unknown }>) : [];
}

function cachedRegimeFromReasoning(reasoning: unknown): ReturnType<typeof regimeFromReasoning> {
  const cacheKey = typeof reasoning === "string" ? reasoning : (() => {
    try {
      return JSON.stringify(reasoning);
    } catch {
      return null;
    }
  })();

  if (cacheKey) {
    const cached = regimeParseCache.get(cacheKey);
    if (cached) return cached;
  }

  const derived = regimeFromReasoning(reasoning);
  if (cacheKey) {
    regimeParseCache.set(cacheKey, derived);
  }
  return derived;
}

function regimeFromReasoning(reasoning: unknown): {
  regime: MacroRegime | null;
  confidence: number | null;
  topScore: number;
  secondScore: number;
} {
  const signals = parseReasoningSignals(reasoning);
  if (signals.length === 0) {
    return { regime: null, confidence: null, topScore: 0, secondScore: 0 };
  }

  const scored = scoreRegimeSignals(signals);
  const totalScore = Object.values(scored.scores).reduce((sum, score) => sum + score, 0);
  const confidence = totalScore > 0 ? scored.topScore / totalScore : null;
  return {
    regime: scored.regime,
    confidence,
    topScore: scored.topScore,
    secondScore: scored.secondScore,
  };
}

function computeSmoothing(history: Array<{ regime: MacroRegime | null }>): MacroRegime | null {
  const recent = history.map((item) => item.regime).filter(Boolean) as MacroRegime[];
  if (recent.length === 0) return null;

  const counts: Record<MacroRegime, number> = {
    inflationary: 0,
    risk_off: 0,
    growth: 0,
    deflationary: 0,
  };

  for (const regime of recent) {
    counts[regime] += 1;
  }

  const maxCount = Math.max(...Object.values(counts));
  const tied = (Object.keys(counts) as MacroRegime[]).filter((regime) => counts[regime] === maxCount);
  if (tied.length === 1) return tied[0];

  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const regime = recent[index];
    if (tied.includes(regime)) return regime;
  }

  return tied[0] ?? null;
}

function createAdminSupabaseClient(): SupabaseClient {
  if (adminSupabaseClient) return adminSupabaseClient;

  validateEnvOrThrow({
    serviceName: "adminDashboard",
    required: ["NEXT_PUBLIC_SUPABASE_URL"],
    anyOf: [
      {
        names: ["SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY"],
        label: "SUPABASE_SERVICE_ROLE_KEY | SUPABASE_SERVICE_KEY",
      },
    ],
  });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY;

  adminSupabaseClient = createClient(url, key as string, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return adminSupabaseClient;
}
/* eslint-disable @typescript-eslint/no-explicit-any */
async function queryCount(
  supabase: SupabaseClient,
  table: string,
  filter?: (query: any) => any
): Promise<number> {
  let query = supabase.from(table).select("id", { head: true, count: "exact" });
  if (filter) query = filter(query);
  const { value, durationMs } = await measureAsyncOperation(() => query);
  if (durationMs > 1500) {
    logWarn("DASHBOARD_SLOW_QUERY", { table, operation: "count", duration_ms: durationMs });
  } else {
    if (process.env.NODE_ENV === "development") {
      logDebug("DASHBOARD_QUERY_TIMING", { table, operation: "count", duration_ms: durationMs });
    }
  }
  const { count, error } = value as {
  count: number | null;
  error: { message: string } | null;
};
  if (error) throw new Error(`${table}: ${error.message}`);
  return Number(count ?? 0);
}
/* eslint-enable @typescript-eslint/no-explicit-any */
async function safeQuery<T>(query: unknown): Promise<{ data: T[]; error: string | null }> {
  try {
    const { value, durationMs } = await measureAsyncOperation(() => query);
    if (durationMs > 1500) {
      logWarn("DASHBOARD_SLOW_QUERY", { operation: "select", duration_ms: durationMs });
    } else {
      if (process.env.NODE_ENV === "development") {
        logDebug("DASHBOARD_QUERY_TIMING", { operation: "select", duration_ms: durationMs });
      }
    }
    const { data, error } = value as {
  data: T[] | null;
  error: { message?: string } | null;
};
    if (error) return { data: [], error: error.message ?? "Query failed" };
    return { data: (data as T[] | null) ?? [], error: null };
  } catch (err) {
    return { data: [], error: err instanceof Error ? err.message : String(err) };
  }
}

async function loadDashboardData(): Promise<DashboardData> {
  const supabase = createAdminSupabaseClient();
  const since24hIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const recentWindowIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  // Fetch the latest pipeline_metrics first (cheap aggregated row). If present,
  // use its precomputed counters to avoid expensive full-table counts.
  const pipelineMetricsPromise = safeQuery<PipelineMetricRow>(
    supabase.from("pipeline_metrics").select("processed_count,failure_count,backlog_size,window_start,stage_name").order("window_start", { ascending: false }).limit(1),
  );

let cachedHealth = dashboardHealthCache.get("latest");

let healthReport;

if (
  cachedHealth &&
  Date.now() - cachedHealth.createdAt < 30000
) {
  healthReport = cachedHealth.data;
} else {
  healthReport = await runSystemHealthCheck();

  dashboardHealthCache.set("latest", {
    data: healthReport,
    createdAt: Date.now(),
  });
}

const [
  pipelineMetrics,
  insights,
  allocations,
  runtimeLogs,
  failureLogs,
  clusterRows,
] = await Promise.all([
  pipelineMetricsPromise,
  safeQuery<InsightRow>(
    supabase
      .from("event_insights")
      .select("cluster_id,reasoning,confidence,created_at")
      .order("created_at", { ascending: false })
      .limit(5)
  ),
  safeQuery<AllocationRow>(
    supabase
      .from("event_allocations")
      .select("cluster_id,asset,action,weight,confidence,created_at")
      .order("created_at", { ascending: false })
      .limit(20)
  ),
  safeQuery<RuntimeRow>(
    supabase
      .from("pipeline_stage_runtime")
      .select("stage_name,status,duration_ms,cluster_id,end_time")
      .gte("end_time", recentWindowIso)
      .order("end_time", { ascending: false })
      .limit(10)
  ),
  safeQuery<FailureRow>(
    supabase
      .from("pipeline_failures")
      .select("stage_name,cluster_id,error_message,occurred_at")
      .gte("occurred_at", recentWindowIso)
      .order("occurred_at", { ascending: false })
      .limit(10)
  ),
  safeQuery<ClusterRow>(
    supabase
      .from("event_clusters")
      .select("id,validated,created_at")
      .order("created_at", { ascending: false })
      .limit(15)
  ),
]);

  const latestMetric = pipelineMetrics.data[0] ?? null;
  const latestMetricAgeMs = latestMetric?.window_start ? Date.now() - new Date(latestMetric.window_start).getTime() : Number.POSITIVE_INFINITY;
  const monitorHealthy = Number.isFinite(latestMetricAgeMs) && latestMetricAgeMs < 5 * 60 * 1000;

  // Compute counts: prefer aggregated snapshot, otherwise run targeted counts in parallel.
  let pendingCount: number;
  let processedCount: number;
  let failedCount: number;

  if (
    latestMetric &&
    Number.isFinite(Number(latestMetric.backlog_size)) &&
    Number.isFinite(Number(latestMetric.processed_count)) &&
    Number.isFinite(Number(latestMetric.failure_count))
  ) {
    pendingCount = Number(latestMetric.backlog_size ?? 0);
    processedCount = Number(latestMetric.processed_count ?? 0);
    failedCount = Number(latestMetric.failure_count ?? 0);
  } else {
    const [pPending, pProcessed, pFailed] = await Promise.all([
      queryCount(supabase, "pipeline_events", (query) => query.eq("processed", false)),
      queryCount(supabase, "pipeline_stage_runtime", (query) => query.gte("end_time", since24hIso).eq("status", "success")),
      queryCount(supabase, "pipeline_failures", (query) => query.gte("occurred_at", since24hIso)),
    ]);
    pendingCount = pPending;
    processedCount = pProcessed;
    failedCount = pFailed;
  }

  const stuckUnvalidated = clusterRows.data.filter((row) => row.validated === false && row.created_at && new Date(row.created_at).getTime() < Date.now() - 10 * 60 * 1000);
  const watchdogProblemCount = new Set(stuckUnvalidated.map((row) => row.id ?? "").filter(Boolean)).size;
  const watchdogHealthy = watchdogProblemCount === 0 && pendingCount < 1000;

  const healthCheck = healthReport.ok ? statusFromBoolean(true) : statusFromBoolean(false);
  const workerStatus = healthReport.checks.find((check) => check.name === "worker_status");
  const workerHealthy = workerStatus?.ok ?? false;

  // Avoid repeated parsing of `reasoning` by deriving once per insight row.
  const insightsDerived = insights.data.map((row) => ({
    row,
    derived: cachedRegimeFromReasoning(row.reasoning),
  }));

  const regimeHistory = insightsDerived.slice(0, 5).map(({ row, derived }) => ({
    regime: derived.regime,
    confidence: derived.confidence,
    createdAt: row.created_at ?? "",
  }));

  const smoothingResult = computeSmoothing(regimeHistory);
  const currentRegime = regimeHistory[0]?.regime ?? null;
  const currentConfidence = regimeHistory[0]?.confidence ?? null;

  const regimeDistribution = insightsDerived.reduce<Record<string, number>>((acc, item) => {
    const key = item.derived.regime ?? "unclassified";
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});

  const scoredInsights = insightsDerived.map((it) => it.derived).filter((d) => d.regime);
  const averageConfidence = scoredInsights.length > 0
    ? scoredInsights.reduce((sum, d) => sum + Number(d.confidence ?? 0), 0) / scoredInsights.length
    : null;

  const transitions: Array<{ from: MacroRegime; to: MacroRegime; createdAt: string }> = [];
  for (let index = 1; index < regimeHistory.length; index += 1) {
    const prev = regimeHistory[index - 1]?.regime;
    const next = regimeHistory[index]?.regime;
    if (prev && next && prev !== next) {
      transitions.push({ from: prev, to: next, createdAt: regimeHistory[index].createdAt });
    }
  }

  const latestClusterId = allocations.data[0]?.cluster_id ?? null;
  const latestClusterAllocations = latestClusterId
    ? allocations.data.filter((row) => row.cluster_id === latestClusterId)
    : [];
  const topAssets = [...latestClusterAllocations].sort((a, b) => Number(b.weight ?? 0) - Number(a.weight ?? 0)).slice(0, 5);

  const allocationTimestamps = latestClusterAllocations.length > 0
    ? {
        first: latestClusterAllocations[latestClusterAllocations.length - 1]?.created_at ?? null,
        latest: latestClusterAllocations[0]?.created_at ?? null,
      }
    : { first: null, latest: null };

  const errors: string[] = [];
  for (const item of [pipelineMetrics.error, insights.error, allocations.error, runtimeLogs.error, failureLogs.error, clusterRows.error]) {
    if (item) errors.push(item);
  }

  return {
    health: {
      health: healthCheck.label,
      worker: workerHealthy ? "Healthy" : "Degraded",
      monitor: monitorHealthy ? "Healthy" : "Stale",
      watchdog: watchdogHealthy ? "Healthy" : "Warning",
      healthDetail: healthReport.diagnostics[0] ?? "Health checks completed",
      workerDetail: workerStatus?.details ?? "No worker check available",
      monitorDetail: monitorHealthy
        ? `Latest pipeline_metrics at ${fmtTimestamp(latestMetric?.window_start ?? null)}`
        : "pipeline_metrics snapshot is stale or missing",
      watchdogDetail: watchdogHealthy
        ? "No stuck clusters detected"
        : `${watchdogProblemCount} stuck clusters or missing downstream outputs`,
    },
    metrics: {
      pendingEvents: pendingCount,
      processedEvents: processedCount,
      failedEvents: failedCount,
      queueBacklog: pendingCount,
      pendingError: null,
      processedError: null,
      failedError: null,
    },
    regime: {
      currentRegime,
      currentConfidence,
      smoothingResult,
      history: regimeHistory,
      transitions,
      distribution: regimeDistribution,
      averageConfidence,
    },
    allocation: {
      clusterId: latestClusterId,
      allocations: latestClusterAllocations,
      topAssets,
      timestamps: allocationTimestamps,
    },
    analytics: {
      regimeDistribution,
      averageConfidence,
      recentTransitions: transitions,
    },
    logs: {
      runtime: runtimeLogs.data,
      failures: failureLogs.data,
    },
    errors,
  };
}

function LoadingState() {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-8">
        <div className="rounded-3xl border border-slate-800 bg-slate-900/70 p-6">
          <div className="h-6 w-48 animate-pulse rounded bg-slate-800" />
          <div className="mt-3 h-4 w-72 animate-pulse rounded bg-slate-800" />
        </div>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-28 animate-pulse rounded-2xl border border-slate-800 bg-slate-900/60" />
          ))}
        </div>
      </main>
    </div>
  );
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-slate-800 bg-slate-900/70 p-5 shadow-lg shadow-black/10">
      <div className="mb-4">
        <h2 className="text-sm font-semibold uppercase tracking-[0.24em] text-slate-300">{title}</h2>
        {subtitle ? <p className="mt-1 text-sm text-slate-400">{subtitle}</p> : null}
      </div>
      {children}
    </section>
  );
}

function StatusPill({ label, state }: { label: string; state: "healthy" | "warning" | "degraded" | "neutral" }) {
  return <span className={`inline-flex rounded-full border px-2.5 py-1 text-xs font-medium ${badgeClass(state)}`}>{label}</span>;
}

function MetricTile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
      <div className="text-xs uppercase tracking-[0.2em] text-slate-400">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-slate-50">{value}</div>
      {note ? <div className="mt-1 text-xs text-slate-500">{note}</div> : null}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/30 p-4 text-sm text-slate-400">{message}</div>;
}

function ErrorState({ message }: { message: string }) {
  return <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200">{message}</div>;
}

function StructuredLogLine({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-3 text-sm text-slate-200">{children}</div>;
}

async function AdminDashboard() {
  let data: DashboardData | null = null;
  let errorMessage: string | null = null;

  try {
    data = await loadDashboardData();
  } catch (error) {
    errorMessage =
      error instanceof Error ? error.message : String(error);
  }

  if (!data) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-8">
          <Card
            title="Operations Dashboard"
            subtitle="Unable to load dashboard data"
          >
            <ErrorState message={errorMessage ?? "Unknown error"} />

            <div className="mt-4 rounded-xl border border-slate-800 bg-slate-950/40 p-4 text-sm text-slate-300">
              Verify the Supabase env vars, database connectivity,
              and table migrations, then reload the page.
            </div>
          </Card>
        </main>
      </div>
    );
  }

  return (
      <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(30,41,59,0.9),_rgba(2,6,23,1)_58%)] text-slate-100">
        <main className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-8">
          <header className="rounded-3xl border border-slate-800 bg-slate-950/60 p-6 backdrop-blur">
            <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="text-xs uppercase tracking-[0.3em] text-cyan-300/80">Trajectos V1 Operations</p>
                <h1 className="mt-2 text-3xl font-semibold text-white">Operations Dashboard</h1>
                <p className="mt-2 max-w-3xl text-sm text-slate-300">
                  Read-only operational view over health, pipeline progress, regime behavior, allocations, analytics, and persisted observability events.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <StatusPill label={`System: ${data.health.health}`} state={data.health.health === "Healthy" ? "healthy" : "degraded"} />
                <StatusPill label={`Worker: ${data.health.worker}`} state={data.health.worker === "Healthy" ? "healthy" : "degraded"} />
                <StatusPill label={`Monitor: ${data.health.monitor}`} state={data.health.monitor === "Healthy" ? "healthy" : data.health.monitor === "Stale" ? "warning" : "neutral"} />
                <StatusPill label={`Watchdog: ${data.health.watchdog}`} state={data.health.watchdog === "Healthy" ? "healthy" : "warning"} />
              </div>
            </div>
            {data.errors.length > 0 ? (
              <div className="mt-4">
                <ErrorState message={`Some dashboard sections could not load: ${data.errors.join(" | ")}`} />
              </div>
            ) : null}
          </header>

          <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricTile label="Pending events" value={fmtNumber(data.metrics.pendingEvents, 0)} note="pipeline_events where processed = false" />
            <MetricTile label="Processed events" value={fmtNumber(data.metrics.processedEvents, 0)} note="pipeline_stage_runtime successes in last 24h" />
            <MetricTile label="Failed events" value={fmtNumber(data.metrics.failedEvents, 0)} note="pipeline_failures in last 24h" />
            <MetricTile label="Queue backlog" value={fmtNumber(data.metrics.queueBacklog, 0)} note="current backlog from pipeline_events" />
          </section>

          <section className="grid gap-6 xl:grid-cols-2">
            <Card title="SYSTEM STATUS" subtitle="Health checks and worker/monitor/watchdog state">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Health check result</div>
                  <div className="mt-2 flex items-center gap-2">
                    <StatusPill label={data.health.health} state={data.health.health === "Healthy" ? "healthy" : "degraded"} />
                  </div>
                  <p className="mt-2 text-sm text-slate-300">{data.health.healthDetail}</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Worker status</div>
                  <div className="mt-2 flex items-center gap-2"><StatusPill label={data.health.worker} state={data.health.worker === "Healthy" ? "healthy" : "degraded"} /></div>
                  <p className="mt-2 text-sm text-slate-300">{data.health.workerDetail}</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Monitor status</div>
                  <div className="mt-2 flex items-center gap-2"><StatusPill label={data.health.monitor} state={data.health.monitor === "Healthy" ? "healthy" : data.health.monitor === "Stale" ? "warning" : "neutral"} /></div>
                  <p className="mt-2 text-sm text-slate-300">{data.health.monitorDetail}</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Watchdog status</div>
                  <div className="mt-2 flex items-center gap-2"><StatusPill label={data.health.watchdog} state={data.health.watchdog === "Healthy" ? "healthy" : "warning"} /></div>
                  <p className="mt-2 text-sm text-slate-300">{data.health.watchdogDetail}</p>
                </div>
              </div>
            </Card>

            <Card title="REGIME STATUS" subtitle="Current regime derived from recent insight reasoning">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Current regime</div>
                  <div className="mt-2 text-lg font-semibold text-white">{data.regime.currentRegime ?? "Unclassified"}</div>
                  <p className="mt-2 text-sm text-slate-300">Sourced from the latest `event_insights.reasoning` row.</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Regime confidence</div>
                  <div className="mt-2 text-lg font-semibold text-white">{fmtNumber(data.regime.currentConfidence, 3)}</div>
                  <p className="mt-2 text-sm text-slate-300">Score ratio from the current reasoning payload.</p>
                </div>
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div>
                  <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-300">Regime history</h3>
                  <div className="mt-3 space-y-2">
                    {data.regime.history.length > 0 ? data.regime.history.map((row, index) => (
                      <div key={`${row.createdAt}-${index}`} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-sm">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-slate-100">{row.regime ?? "Unclassified"}</span>
                          <span className="text-xs text-slate-500">{fmtTimestamp(row.createdAt)}</span>
                        </div>
                        <div className="mt-1 text-xs text-slate-400">confidence {fmtNumber(row.confidence, 3)}</div>
                      </div>
                    )) : <EmptyState message="No regime history available yet." />}
                  </div>
                </div>
                <div>
                  <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-300">Smoothing result</h3>
                  <div className="mt-3 rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                    <div className="text-lg font-semibold text-white">{data.regime.smoothingResult ?? "Unclassified"}</div>
                    <p className="mt-2 text-sm text-slate-300">
                      Derived from the recent regime window using the same tie-breaking rules as the engine.
                    </p>
                  </div>
                </div>
              </div>
            </Card>
          </section>

          <section className="grid gap-6 xl:grid-cols-2">
            <Card title="ALLOCATION STATUS" subtitle="Latest cluster allocations and timestamps">
              {data.allocation.clusterId ? (
                <div className="space-y-4">
                  <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                    <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Latest cluster</div>
                    <div className="mt-2 text-sm text-slate-200">{data.allocation.clusterId}</div>
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-300">Top weighted assets</h3>
                    <div className="mt-3 space-y-2">
                      {data.allocation.topAssets.length > 0 ? data.allocation.topAssets.map((row) => (
                        <div key={`${row.cluster_id}-${row.asset}`} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-sm">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-medium text-white">{row.asset ?? "Unknown"}</span>
                            <span className="text-slate-300">{fmtNumber(row.weight, 4)}</span>
                          </div>
                          <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-400">
                            <span>{row.action ?? "—"}</span>
                            <span>confidence {fmtNumber(row.confidence, 3)}</span>
                            <span>{fmtTimestamp(row.created_at)}</span>
                          </div>
                        </div>
                      )) : <EmptyState message="No allocations found for the latest cluster." />}
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                      <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Latest allocation timestamp</div>
                      <div className="mt-2 text-sm text-slate-100">{fmtTimestamp(data.allocation.timestamps.latest)}</div>
                    </div>
                    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                      <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Allocation span start</div>
                      <div className="mt-2 text-sm text-slate-100">{fmtTimestamp(data.allocation.timestamps.first)}</div>
                    </div>
                  </div>
                </div>
              ) : (
                <EmptyState message="No allocation rows available yet." />
              )}
            </Card>

            <Card title="ANALYTICS" subtitle="Regime distribution, confidence, and transitions">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Average confidence</div>
                  <div className="mt-2 text-lg font-semibold text-white">{fmtNumber(data.analytics.averageConfidence, 3)}</div>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
                  <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Recent transitions</div>
                  <div className="mt-2 text-lg font-semibold text-white">{fmtNumber(data.analytics.recentTransitions.length, 0)}</div>
                </div>
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div>
                  <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-300">Regime distribution</h3>
                  <div className="mt-3 space-y-2">
                    {Object.keys(data.analytics.regimeDistribution).length > 0 ? Object.entries(data.analytics.regimeDistribution).map(([regime, count]) => (
                      <div key={regime} className="flex items-center justify-between rounded-xl border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm">
                        <span className="text-slate-100">{regime}</span>
                        <span className="text-slate-300">{count}</span>
                      </div>
                    )) : <EmptyState message="No regime analytics yet." />}
                  </div>
                </div>
                <div>
                  <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-300">Recent transitions</h3>
                  <div className="mt-3 space-y-2">
                    {data.analytics.recentTransitions.length > 0 ? data.analytics.recentTransitions.map((transition, index) => (
                      <div key={`${transition.createdAt}-${index}`} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-sm text-slate-200">
                        <div className="font-medium">{transition.from} → {transition.to}</div>
                        <div className="mt-1 text-xs text-slate-500">{fmtTimestamp(transition.createdAt)}</div>
                      </div>
                    )) : <EmptyState message="No recent regime transitions recorded." />}
                  </div>
                </div>
              </div>
            </Card>
          </section>

          <section className="grid gap-6 xl:grid-cols-2">
            <Card title="LOGS" subtitle="Recent structured runtime records and latest errors/warnings">
              <div className="grid gap-4 lg:grid-cols-2">
                <div>
                  <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-300">Recent structured logs</h3>
                  <div className="mt-3 space-y-2">
                    {data.logs.runtime.length > 0 ? data.logs.runtime.map((row, index) => (
                      <StructuredLogLine key={`${row.end_time}-${index}`}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-slate-50">{row.stage_name ?? "unknown"}</span>
                          <span className="text-xs text-slate-500">{fmtTimestamp(row.end_time)}</span>
                        </div>
                        <div className="mt-2 text-xs text-slate-400">
                          status={row.status ?? "unknown"} duration_ms={fmtNumber(row.duration_ms, 0)} cluster={row.cluster_id ?? "—"}
                        </div>
                      </StructuredLogLine>
                    )) : <EmptyState message="No recent structured runtime logs available." />}
                  </div>
                </div>
                <div>
                  <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-300">Latest errors / warnings</h3>
                  <div className="mt-3 space-y-2">
                    {data.logs.failures.length > 0 ? data.logs.failures.map((row, index) => (
                      <div key={`${row.occurred_at}-${index}`} className="rounded-xl border border-rose-500/20 bg-rose-500/10 p-3 text-sm text-rose-100">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium">{row.stage_name ?? "unknown"}</span>
                          <span className="text-xs text-rose-200/70">{fmtTimestamp(row.occurred_at)}</span>
                        </div>
                        <div className="mt-2 text-xs text-rose-100/80">{row.error_message ?? "No error message"}</div>
                        <div className="mt-2 text-[11px] text-rose-100/60">cluster={row.cluster_id ?? "—"}</div>
                      </div>
                    )) : <EmptyState message="No recent failures or warnings recorded." />}
                  </div>
                </div>
              </div>
            </Card>
          </section>
        </main>
      </div>
    );
  } 
export default function AdminPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <AdminDashboard />
    </Suspense>
  );
}
