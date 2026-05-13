import type { SupabaseClient } from "@supabase/supabase-js";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type DeadLetterRow = {
  id: string;
  event_type?: string | null;
  payload?: unknown;
  retry_after?: string | null;
  retry_count?: number | null;
};

export type DeadLetterFailureReason =
  | "transient_failure"
  | "permanent_failure"
  | "malformed_payload_failure";

type DeadLetterDiagnostics = {
  failure_reason: DeadLetterFailureReason;
  failed_stage: string;
  retry_count: number;
  last_attempt_at: string;
};

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 250;
const FALLBACK_DIR = path.join(process.cwd(), "logs");
const FALLBACK_FILE = path.join(FALLBACK_DIR, "dead-letter-fallback.ndjson");
const FALLBACK_RECOVERY_BATCH_SIZE = 100;
const UUID_V4_LIKE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

function nowPlusSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function computeBackoffSeconds(retryCount: unknown): number {
  const n = Number(retryCount);
  const safe = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  const schedule = [1, 5, 15, 30];
  return schedule[Math.min(safe, schedule.length - 1)] ?? 30;
}

function isUniqueViolation(message: string): boolean {
  const m = (message ?? "").toLowerCase();
  return m.includes("duplicate key value") || m.includes("unique constraint");
}

function isMissingFileError(err: unknown): boolean {
  const e = err as { code?: unknown } | null;
  return (e?.code ?? "").toString() === "ENOENT";
}

function normalizeUuid(value: unknown): string | null {
  const id = (value ?? "").toString().trim();
  if (!id) return null;
  return UUID_V4_LIKE.test(id) ? id : null;
}

function toNonEmptyString(value: unknown): string | null {
  const text = (value ?? "").toString().trim();
  return text ? text : null;
}

function toErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message || "Error";
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return "Unknown error";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractStatusCode(err: unknown): number | null {
  const value = err as { status?: unknown; code?: unknown; message?: unknown } | null;

  const status = Number(value?.status);
  if (Number.isFinite(status) && status >= 100 && status <= 599) {
    return status;
  }

  const code = (value?.code ?? "").toString().trim();
  if (/^5\d\d$/.test(code)) return Number(code);

  const message = (value?.message ?? "").toString();
  const match = message.match(/\b(5\d\d)\b/);
  if (match) return Number(match[1]);

  return null;
}

function isRetryableExternalError(err: unknown): boolean {
  const status = extractStatusCode(err);
  if (status != null) {
    return status >= 500 && status <= 599;
  }

  // Network-level failures may not have HTTP status but are commonly transient.
  const message = toErrorMessage(err).toLowerCase();
  return (
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("fetch failed") ||
    message.includes("network")
  );
}

function isMalformedPayloadError(err: unknown): boolean {
  const message = toErrorMessage(err).toLowerCase();
  return (
    message.includes("invalid json") ||
    message.includes("unexpected token") ||
    message.includes("malformed") ||
    message.includes("cannot read properties") ||
    message.includes("cannot destructure") ||
    message.includes("undefined") ||
    message.includes("null")
  );
}

export function classifyDeadLetterFailure(err: unknown): DeadLetterFailureReason {
  if (isMalformedPayloadError(err)) {
    return "malformed_payload_failure";
  }

  if (isRetryableExternalError(err)) {
    return "transient_failure";
  }

  return "permanent_failure";
}

function buildDeadLetterDiagnostics(params: {
  stageName: string;
  retryCount?: number | null;
  failureReason: DeadLetterFailureReason;
  lastAttemptAt?: string;
}): DeadLetterDiagnostics {
  return {
    failure_reason: params.failureReason,
    failed_stage: params.stageName,
    retry_count: Number.isFinite(Number(params.retryCount)) ? Math.max(0, Math.floor(Number(params.retryCount ?? 0))) : 0,
    last_attempt_at: params.lastAttemptAt ?? new Date().toISOString(),
  };
}

async function runWithExternalRetries<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
    try {
      const value = await fn();
      return { ok: true, value };
    } catch (err) {
      lastError = err;
      const retryable = isRetryableExternalError(err);
      const isLast = attempt >= RETRY_ATTEMPTS;

      if (!retryable || isLast) {
        break;
      }

      const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn("[pipelineDeadLetterService] transient external failure; retrying", {
        label,
        attempt,
        delayMs,
        status: extractStatusCode(err),
        error: toErrorMessage(err),
      });
      await sleep(delayMs);
    }
  }

  return { ok: false, error: lastError };
}

async function appendFallbackRecord(record: Record<string, unknown>): Promise<void> {
  await mkdir(FALLBACK_DIR, { recursive: true });
  await appendFile(FALLBACK_FILE, `${JSON.stringify(record)}\n`, "utf8");
}

async function persistMinimalFallbackError(params: {
  source: string;
  stageName?: string;
  clusterId?: string | null;
  id?: string;
  error: unknown;
  extra?: Record<string, unknown>;
  diagnostics?: DeadLetterDiagnostics;
}): Promise<void> {
  const diagnostics = params.diagnostics ?? buildDeadLetterDiagnostics({
    stageName: params.stageName ?? params.source,
    failureReason: classifyDeadLetterFailure(params.error),
    retryCount: typeof params.extra?.retry_count === "number" ? params.extra.retry_count : null,
    lastAttemptAt: typeof params.extra?.last_attempt_at === "string" ? params.extra.last_attempt_at : undefined,
  });

  const fallback = {
    ts: new Date().toISOString(),
    source: params.source,
    stage_name: params.stageName ?? null,
    cluster_id: params.clusterId ?? null,
    id: params.id ?? null,
    status: extractStatusCode(params.error),
    error_message: toErrorMessage(params.error),
    failure_reason: diagnostics.failure_reason,
    failed_stage: diagnostics.failed_stage,
    retry_count: diagnostics.retry_count,
    last_attempt_at: diagnostics.last_attempt_at,
    ...(params.extra ?? {}),
  };

  try {
    await appendFallbackRecord(fallback);
  } catch (fallbackErr) {
    // Final safety net: never swallow dead-letter write failures.
    console.error("[pipelineDeadLetterService] failed to persist fallback dead-letter record", {
      fallbackFile: FALLBACK_FILE,
      error: toErrorMessage(fallbackErr),
      original: fallback,
    });
  }
}

/**
 * Replays locally persisted fallback dead-letter records into pipeline_dead_letters.
 * - Processes a bounded batch per run
 * - Removes successfully recovered lines from the local NDJSON file
 * - Keeps failed/corrupt lines for future retry
 * - Never throws on missing/corrupt file
 */
export async function replayFallbackDeadLetters(params: {
  supabase: SupabaseClient;
  batchSize?: number;
}): Promise<void> {
  const supabase = params.supabase;
  const configured = Number(params.batchSize ?? process.env.DEAD_LETTER_FALLBACK_REPLAY_BATCH_SIZE);
  const batchSize = Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : FALLBACK_RECOVERY_BATCH_SIZE;

  let content = "";
  try {
    content = await readFile(FALLBACK_FILE, "utf8");
  } catch (err) {
    if (isMissingFileError(err)) {
      return;
    }
    console.error("[pipelineDeadLetterService] failed to read fallback dead-letter file", {
      fallbackFile: FALLBACK_FILE,
      error: toErrorMessage(err),
    });
    return;
  }

  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) return;

  const kept: string[] = [];
  let attempted = 0;
  let recovered = 0;
  let failed = 0;
  let corrupted = 0;

  for (const line of lines) {
    if (attempted >= batchSize) {
      kept.push(line);
      continue;
    }

    attempted += 1;

    let parsed: Record<string, unknown> | null = null;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
      }
    } catch {
      parsed = null;
    }

    if (!parsed) {
      corrupted += 1;
      kept.push(line);
      continue;
    }

    const row: Record<string, unknown> = {
      cluster_id: toNonEmptyString(parsed.cluster_id),
      stage_name: toNonEmptyString(parsed.stage_name) ?? toNonEmptyString(parsed.source) ?? "fallback_recovery",
      error_message: toNonEmptyString(parsed.error_message) ?? "Recovered fallback dead-letter record",
      payload: { fallback_record: parsed },
    };

    const eventType = toNonEmptyString(parsed.event_type);
    if (eventType) row.event_type = eventType;

    const retryAfter = toNonEmptyString(parsed.retry_after);
    if (retryAfter) row.retry_after = retryAfter;

    const retryCount = Number(parsed.retry_count);
    if (Number.isFinite(retryCount) && retryCount >= 0) {
      row.retry_count = Math.floor(retryCount);
    }

    const failureReason = toNonEmptyString(parsed.failure_reason);
    const failedStage = toNonEmptyString(parsed.failed_stage) ?? toNonEmptyString(parsed.stage_name) ?? null;
    const lastAttemptAt = toNonEmptyString(parsed.last_attempt_at) ?? null;
    if (failureReason || failedStage || lastAttemptAt) {
      row.payload = {
        fallback_record: parsed,
        diagnostics: {
          failure_reason: failureReason ?? null,
          failed_stage: failedStage,
          retry_count: Number.isFinite(retryCount) && retryCount >= 0 ? Math.floor(retryCount) : 0,
          last_attempt_at: lastAttemptAt,
        },
      };
    }

    const explicitId = normalizeUuid(parsed.id);
    if (explicitId) row.id = explicitId;

    const writeResult = await runWithExternalRetries("replayFallbackDeadLetters", async () => {
      if (explicitId) {
        const { error } = await supabase
          .from("pipeline_dead_letters")
          .upsert(row, { onConflict: "id" });
        if (error) throw error;
        return;
      }

      const { error } = await supabase
        .from("pipeline_dead_letters")
        .insert(row);
      if (error) throw error;
    });

    if (!writeResult.ok) {
      const maybeUnique = isUniqueViolation(toErrorMessage(writeResult.error));
      if (!maybeUnique) {
        failed += 1;
        console.error("[pipelineDeadLetterService] fallback replay failed", {
          status: extractStatusCode(writeResult.error),
          error: toErrorMessage(writeResult.error),
          id: explicitId,
        });
      }
      kept.push(line);
      continue;
    }

    recovered += 1;
  }

  try {
    await mkdir(FALLBACK_DIR, { recursive: true });
    const next = kept.length > 0 ? `${kept.join("\n")}\n` : "";
    await writeFile(FALLBACK_FILE, next, "utf8");
  } catch (err) {
    console.error("[pipelineDeadLetterService] failed to rewrite fallback dead-letter file", {
      fallbackFile: FALLBACK_FILE,
      error: toErrorMessage(err),
    });
    return;
  }

  if (attempted > 0 || corrupted > 0) {
    console.log("[pipelineDeadLetterService] fallback recovery summary", {
      attempted,
      recovered,
      failed,
      corrupted,
      remaining: kept.length,
      batchSize,
    });
  }
}

export async function recordPipelineDeadLetter(params: {
  supabase: SupabaseClient;
  id?: string;
  clusterId?: string | null;
  stageName: string;
  err: unknown;
  failureReason?: DeadLetterFailureReason;
  retryCount?: number | null;
  lastAttemptAt?: string;
}): Promise<void> {
  const clusterId = (params.clusterId ?? "").toString().trim();
  const failureReason = params.failureReason ?? classifyDeadLetterFailure(params.err);
  const diagnostics = buildDeadLetterDiagnostics({
    stageName: params.stageName,
    retryCount: params.retryCount ?? 0,
    failureReason,
    lastAttemptAt: params.lastAttemptAt,
  });

  const row: Record<string, unknown> = {
    cluster_id: clusterId || null,
    stage_name: params.stageName,
    error_message: toErrorMessage(params.err),
    retry_count: diagnostics.retry_count,
    retry_after: failureReason === "transient_failure" ? nowPlusSeconds(computeBackoffSeconds(diagnostics.retry_count)) : null,
    payload: {
      failure_reason: diagnostics.failure_reason,
      failed_stage: diagnostics.failed_stage,
      retry_count: diagnostics.retry_count,
      last_attempt_at: diagnostics.last_attempt_at,
      error_message: toErrorMessage(params.err),
      original_error: params.err instanceof Error ? params.err.message : toErrorMessage(params.err),
    },
  };

  if (params.id) {
    row.id = params.id;
  }

  const result = await runWithExternalRetries("recordPipelineDeadLetter", async () => {
    const { error } = params.id
      ? await params.supabase
          .from("pipeline_dead_letters")
          .upsert(row, { onConflict: "id" })
      : await params.supabase.from("pipeline_dead_letters").insert(row);

    if (error) {
      throw error;
    }
  });

  if (!result.ok) {
    // Dead-lettering must never stop the pipeline, but must also never fail silently.
    console.error("[pipelineDeadLetterService] failed to record dead letter after retries", {
      stageName: params.stageName,
      clusterId: clusterId || null,
      id: params.id ?? null,
      failureReason,
      retryCount: diagnostics.retry_count,
      failedStage: diagnostics.failed_stage,
      lastAttemptAt: diagnostics.last_attempt_at,
      status: extractStatusCode(result.error),
      error: toErrorMessage(result.error),
    });

    await persistMinimalFallbackError({
      source: "recordPipelineDeadLetter",
      stageName: params.stageName,
      clusterId: clusterId || null,
      id: params.id,
      error: result.error,
      diagnostics,
    });
  }
}

/**
 * Retries due dead-lettered events by re-inserting them into pipeline_events.
 *
 * Behavior:
 * - Selects up to 50 dead letters where retry_after <= now()
 * - Reinserts { event_type, payload } into pipeline_events
 * - Deletes the dead letter row on success (or if uniqueness indicates it already exists)
 * - On failure, schedules the next retry using 1s / 5s / 15s / 30s backoff
 */
export async function runDeadLetterRetry(params: { supabase: SupabaseClient }): Promise<void> {
  const supabase = params.supabase;
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from("pipeline_dead_letters")
    .select("id,event_type,payload,retry_after,retry_count")
    .lte("retry_after", nowIso)
    .order("retry_after", { ascending: true })
    .limit(50);

  if (error) {
    throw new Error(`Failed to load pipeline dead letters: ${error.message}`);
  }

  const rows = (data as DeadLetterRow[] | null) ?? [];
  if (rows.length === 0) return;

  async function scheduleRetry(id: string, currentRetryCount: unknown): Promise<void> {
    const seconds = computeBackoffSeconds(currentRetryCount);
    const nextRetryCount = (() => {
      const n = Number(currentRetryCount);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) + 1 : 1;
    })();

    const result = await runWithExternalRetries("scheduleDeadLetterRetry", async () => {
      const { error: updateError } = await supabase
        .from("pipeline_dead_letters")
        .update({
          retry_after: nowPlusSeconds(seconds),
          retry_count: nextRetryCount,
          payload: {
            retry_count: nextRetryCount,
            last_attempt_at: new Date().toISOString(),
          },
        })
        .eq("id", id);

      if (updateError) {
        throw updateError;
      }
    });

    if (!result.ok) {
      console.error("[pipelineDeadLetterService] failed to schedule dead-letter retry", {
        id,
        retryCount: nextRetryCount,
        status: extractStatusCode(result.error),
        error: toErrorMessage(result.error),
      });

      await persistMinimalFallbackError({
        source: "scheduleDeadLetterRetry",
        stageName: "dead_letter_retry",
        id,
        error: result.error,
        extra: {
          retry_count: nextRetryCount,
          retry_after: nowPlusSeconds(seconds),
          last_attempt_at: new Date().toISOString(),
        },
        diagnostics: buildDeadLetterDiagnostics({
          stageName: "dead_letter_retry",
          retryCount: nextRetryCount,
          failureReason: "transient_failure",
        }),
      });
    }
  }

  for (const row of rows) {
    try {
      let eventType = (row.event_type ?? "").toString().trim();
      let payload = row.payload;

      // Backward-compat for older DLQ rows that only stored id.
      if (!eventType || !payload) {
        const { data: evt, error: evtError } = await supabase
          .from("pipeline_events")
          .select("event_type,payload")
          .eq("id", row.id)
          .maybeSingle();

        if (evtError) {
          throw new Error(`Failed to load original pipeline event: ${evtError.message}`);
        }

        if (evt) {
          eventType = (evt as { event_type?: unknown }).event_type?.toString?.() ?? eventType;
          payload = (evt as { payload?: unknown }).payload ?? payload;
        }
      }

      eventType = (eventType ?? "").toString().trim();
      if (!eventType || !payload) {
        // Not enough data to retry; mark the row as non-retryable and stop looping forever.
        const { error: updateError } = await supabase
          .from("pipeline_dead_letters")
          .update({ retry_after: null })
          .eq("id", row.id);

        if (updateError) {
          throw new Error(`Failed to mark malformed dead-letter row as non-retryable: ${updateError.message}`);
        }

        console.warn("[pipelineDeadLetterService] malformed dead-letter payload; skipping retry", {
          id: row.id,
          failureReason: "malformed_payload_failure",
          failedStage: "unknown",
        });
        continue;
      }

      const { error: insertError } = await supabase.from("pipeline_events").insert({
        event_type: eventType,
        payload,
      });

      if (insertError) {
        if (isUniqueViolation(insertError.message)) {
          // Already re-enqueued by another worker.
          const { error: deleteError } = await supabase
            .from("pipeline_dead_letters")
            .delete()
            .eq("id", row.id);
          if (deleteError) {
            throw new Error(`Failed to delete dead-letter row after unique requeue: ${deleteError.message}`);
          }
          continue;
        }
        throw new Error(`Failed to reinsert pipeline event: ${insertError.message}`);
      }

      const { error: deleteError } = await supabase
        .from("pipeline_dead_letters")
        .delete()
        .eq("id", row.id);
      if (deleteError) {
        throw new Error(`Failed to delete dead-letter row after successful requeue: ${deleteError.message}`);
      }
    } catch (err) {
      const failureReason = classifyDeadLetterFailure(err);
      console.error("[pipelineDeadLetterService] dead-letter retry failed", {
        id: row.id,
        status: extractStatusCode(err),
        error: toErrorMessage(err),
        failureReason,
      });

      if (failureReason === "permanent_failure" || failureReason === "malformed_payload_failure") {
        const { error: updateError } = await supabase
          .from("pipeline_dead_letters")
          .update({ retry_after: null })
          .eq("id", row.id);

        if (updateError) {
          throw new Error(`Failed to mark dead-letter row as non-retryable: ${updateError.message}`);
        }

        continue;
      }

      // Exponential backoff for transient errors.
      await scheduleRetry(row.id, row.retry_count);
    }
  }
}
