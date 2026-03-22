import type { SupabaseClient } from "@supabase/supabase-js";

export type StageStatus = "success" | "failure" | "skipped";

type StageRuntimeInsert = {
  stage_name: string;
  event_id?: string | null;
  cluster_id?: string | null;
  start_time: string;
  end_time: string;
  duration_ms: number;
  status: StageStatus;
};

type FailureInsert = {
  stage_name: string;
  event_id?: string | null;
  cluster_id?: string | null;
  error_message: string;
  error_stack?: string | null;
  occurred_at: string;
};

function nowIso(): string {
  return new Date().toISOString();
}

function toErrorMessage(err: unknown): { message: string; stack: string | null } {
  if (err instanceof Error) {
    return {
      message: err.message || "Error",
      stack: typeof err.stack === "string" ? err.stack : null,
    };
  }

  if (typeof err === "string") {
    return { message: err, stack: null };
  }

  try {
    return { message: JSON.stringify(err), stack: null };
  } catch {
    return { message: "Unknown error", stack: null };
  }
}

export async function recordStageRuntime(
  supabase: SupabaseClient,
  row: StageRuntimeInsert,
): Promise<void> {
  const { error } = await supabase.from("pipeline_stage_runtime").insert(row);
  if (error) {
    // Observability must never block the pipeline.
    return;
  }
}

export async function recordFailure(
  supabase: SupabaseClient,
  row: FailureInsert,
): Promise<void> {
  const { error } = await supabase.from("pipeline_failures").insert(row);
  if (error) {
    return;
  }
}

export async function withStageSpan<T>(params: {
  supabase: SupabaseClient;
  stageName: string;
  clusterId?: string | null;
  eventId?: string | null;
  fn: () => Promise<T>;
  statusOnSuccess?: StageStatus;
}): Promise<T> {
  const startMs = Date.now();
  const startIso = nowIso();

  try {
    const result = await params.fn();

    const endIso = nowIso();
    await recordStageRuntime(params.supabase, {
      stage_name: params.stageName,
      event_id: params.eventId ?? null,
      cluster_id: params.clusterId ?? null,
      start_time: startIso,
      end_time: endIso,
      duration_ms: Math.max(0, Date.now() - startMs),
      status: params.statusOnSuccess ?? "success",
    });

    return result;
  } catch (err) {
    const endIso = nowIso();
    const info = toErrorMessage(err);

    await recordStageRuntime(params.supabase, {
      stage_name: params.stageName,
      event_id: params.eventId ?? null,
      cluster_id: params.clusterId ?? null,
      start_time: startIso,
      end_time: endIso,
      duration_ms: Math.max(0, Date.now() - startMs),
      status: "failure",
    });

    await recordFailure(params.supabase, {
      stage_name: params.stageName,
      event_id: params.eventId ?? null,
      cluster_id: params.clusterId ?? null,
      error_message: info.message,
      error_stack: info.stack,
      occurred_at: endIso,
    });

    throw err;
  }
}
