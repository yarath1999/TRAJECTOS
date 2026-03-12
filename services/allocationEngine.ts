import { createSupabaseServerClient } from "./newsFetcher";
import { allocationModel, type AllocationSignal } from "@/lib/allocationModel";

type PipelineEventRow = {
  id: string;
  payload: unknown;
};

type PortfolioSignal = {
  asset: string | null;
  signal: string | null;
  confidence: number | null;
};

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

export async function runAllocationEngine(): Promise<void> {
  const supabase = createSupabaseServerClient();

  const { data: events, error } = await supabase
    .from("pipeline_events")
    .select("id,payload")
    .eq("event_type", "INSIGHT_CREATED")
    .eq("processed", false)
    .order("created_at", { ascending: true })
    .limit(20);

  if (error) {
    throw new Error(`Failed to load pipeline events: ${error.message}`);
  }

  const pending = (events as PipelineEventRow[] | null) ?? [];
  if (pending.length === 0) return;

  for (const evt of pending) {
    const clusterId = extractClusterIdFromPayload(evt.payload);

    if (!clusterId) {
      const { error: markError } = await supabase
        .from("pipeline_events")
        .update({ processed: true })
        .eq("id", evt.id);

      if (markError) {
        throw new Error(`Failed to mark pipeline event processed: ${markError.message}`);
      }

      continue;
    }

    const { data: existing, error: existingError } = await supabase
      .from("portfolio_allocations")
      .select("id")
      .eq("cluster_id", clusterId)
      .limit(1);

    if (existingError) {
      throw new Error(`Failed to check existing allocations: ${existingError.message}`);
    }

    if ((existing ?? []).length > 0) {
      const { error: markError } = await supabase
        .from("pipeline_events")
        .update({ processed: true })
        .eq("id", evt.id);

      if (markError) {
        throw new Error(`Failed to mark pipeline event processed: ${markError.message}`);
      }

      continue;
    }

    const { data: signalsRows, error: signalsError } = await supabase
      .from("portfolio_signals")
      .select("asset,signal,confidence")
      .eq("cluster_id", clusterId);

    if (signalsError) {
      throw new Error(`Failed to load portfolio signals: ${signalsError.message}`);
    }

    const rows = (signalsRows as PortfolioSignal[] | null) ?? [];
    if (rows.length === 0) {
      const { error: markError } = await supabase
        .from("pipeline_events")
        .update({ processed: true })
        .eq("id", evt.id);

      if (markError) {
        throw new Error(`Failed to mark pipeline event processed: ${markError.message}`);
      }

      continue;
    }

    const signalByAsset = new Map<string, { signal: AllocationSignal; confidence: number }>();
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

    const normalized = normalizeAllocations(rawWeights);

    const clusterConfidence = Math.min(
      0.95,
      Math.max(0.5, avg(Array.from(signalByAsset.values()).map((v) => v.confidence))),
    );

    const inserts = Object.entries(normalized).map(([asset, allocation]) => {
      const entry = signalByAsset.get(asset);
      const confidence = entry?.confidence ?? clusterConfidence;
      return {
        cluster_id: clusterId,
        asset,
        allocation,
        confidence,
      };
    });

    const { error: insertError } = await supabase
      .from("portfolio_allocations")
      .insert(inserts);

    if (insertError) {
      throw new Error(`Failed to insert portfolio allocations: ${insertError.message}`);
    }

    const { error: markEventError } = await supabase
      .from("pipeline_events")
      .update({ processed: true })
      .eq("id", evt.id);

    if (markEventError) {
      throw new Error(`Failed to mark pipeline event processed: ${markEventError.message}`);
    }

    const { error: emitError } = await supabase.from("pipeline_events").insert({
      event_type: "ALLOCATION_CREATED",
      payload: { cluster_id: clusterId },
    });

    if (emitError) {
      throw new Error(`Failed to emit ALLOCATION_CREATED event: ${emitError.message}`);
    }
  }
}
