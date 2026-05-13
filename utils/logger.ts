import { getPerformanceContext } from "./performanceTracker";

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

function timestamp(): string {
  return new Date().toISOString();
}

function humanSummary(event: string, payload: any): string {
  const correlationId = payload?.correlation_id ?? payload?.correlationId ?? null;
  const runId = payload?.run_id ?? payload?.runId ?? null;
  const cluster = payload?.cluster_id ?? payload?.clusterId ?? null;
  const regime = payload?.regime ?? payload?.finalRegime ?? payload?.smoothedRegime ?? null;
  const confidence = typeof payload?.confidence === "number" ? payload.confidence.toFixed(3) : payload?.confidence ?? null;
  const allocs = payload?.allocations && typeof payload.allocations === "object"
    ? Object.entries(payload.allocations)
        .map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(3) : String(v)}`)
        .join(", ")
    : null;
  const parts = [`event=${event}`];
  if (correlationId) parts.push(`correlation=${correlationId}`);
  if (runId) parts.push(`run=${runId}`);
  if (cluster) parts.push(`cluster=${cluster}`);
  if (regime) parts.push(`regime=${regime}`);
  if (confidence !== null) parts.push(`confidence=${confidence}`);
  if (allocs) parts.push(`allocations=[${allocs}]`);
  return parts.join(" ");
}

export function logEvent(event: string, payload: Record<string, any> = {}, level: LogLevel = "INFO") {
  const context = getPerformanceContext();
  const logPayload = { ...context, ...payload };
  const logObj = {
    timestamp: timestamp(),
    level,
    event,
    ...logPayload,
  };

  // Primary structured JSON output (machine readable)
  try {
    console.log(JSON.stringify(logObj));
  } catch {
    console.log("[LOG_PARSE_ERROR]", event, payload);
  }

  // Secondary human-friendly one-line summary for quick reading
  try {
    const summary = humanSummary(event, logPayload);
    if (level === "ERROR") console.error(`[${level}] ${summary}`);
    else if (level === "WARN") console.warn(`[${level}] ${summary}`);
    else console.log(`[${level}] ${summary}`);
  } catch {
    // swallow
  }
}

export function logError(event: string, payload: Record<string, any> = {}) {
  logEvent(event, payload, "ERROR");
}

export function logWarn(event: string, payload: Record<string, any> = {}) {
  logEvent(event, payload, "WARN");
}

export function logDebug(event: string, payload: Record<string, any> = {}) {
  logEvent(event, payload, "DEBUG");
}
