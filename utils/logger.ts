import { getPerformanceContext } from "./performanceTracker";

export type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY_PATTERN = /authorization|auth[-_]?header|token|secret|password|api[-_]?key|cookie|set-cookie/i;

function redactValue(value: unknown, keyPath = "", seen = new WeakSet<object>()): unknown {
  if (keyPath && SENSITIVE_KEY_PATTERN.test(keyPath)) {
    return REDACTED;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, "", seen));
  }

  if (value && typeof value === "object") {
    if (seen.has(value as object)) {
      return "[CIRCULAR]";
    }
    seen.add(value as object);

    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(input)) {
      output[key] = redactValue(entry, key, seen);
    }
    return output;
  }

  return value;
}

function timestamp(): string {
  return new Date().toISOString();
}

function humanSummary(
  event: string,
  payload: Record<string, unknown>
): string {
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

export function logEvent(event: string, payload: Record<string, unknown> = {}, level: LogLevel = "INFO") {
  const context = getPerformanceContext();
  const logPayload = redactValue({ ...context, ...payload }) as Record<string, unknown>;
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
    console.error("[LOG_PARSE_ERROR]", { event });
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

export function logError(event: string, payload: Record<string, unknown> = {}) {
  logEvent(event, payload, "ERROR");
}

export function logWarn(event: string, payload: Record<string, unknown> = {}) {
  logEvent(event, payload, "WARN");
}

export function logDebug(event: string, payload: Record<string, unknown> = {}) {
  if (process.env.NODE_ENV !== "development") {
    return;
  }
  logEvent(event, payload, "DEBUG");
}
