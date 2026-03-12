import { createSupabaseServerClient } from "./newsFetcher";

type PipelineEventRow = {
  id: string;
  payload: unknown;
};

function extractClusterIdFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const clusterId = (payload as { cluster_id?: unknown }).cluster_id;
  if (typeof clusterId !== "string" && typeof clusterId !== "number") return null;
  const trimmed = clusterId.toString().trim();
  return trimmed ? trimmed : null;
}

type PortfolioSignalRow = {
  cluster_id: string | null;
  asset: string | null;
  signal: string | null;
  confidence: number | null;
};

type FactorExposureRow = {
  factor: string | null;
  exposure: number | null;
};

type ExposureMap = {
  inflation: number;
  liquidity: number;
  growth: number;
  currency: number;
  risk_sentiment: number;
  commodity_pressure: number;
  [key: string]: number;
};

function clamp(min: number, value: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function normalizeSignal(signal: string | null | undefined): "BUY" | "SELL" | "NEUTRAL" {
  const s = (signal ?? "").toString().trim().toUpperCase();
  if (s === "BUY" || s === "SELL" || s === "NEUTRAL") return s;
  return "NEUTRAL";
}

function toExposureMap(rows: FactorExposureRow[]): ExposureMap {
  const base: ExposureMap = {
    inflation: 0,
    liquidity: 0,
    growth: 0,
    currency: 0,
    risk_sentiment: 0,
    commodity_pressure: 0,
  };

  for (const row of rows) {
    const factor = (row.factor ?? "").toString().trim();
    const exposure = Number(row.exposure);
    if (!factor || !Number.isFinite(exposure)) continue;
    base[factor] = (base[factor] ?? 0) + exposure;
  }

  return base;
}

function buildInsightText(
  exposures: ExposureMap,
  signals: Record<string, { signal: "BUY" | "SELL" | "NEUTRAL"; confidence: number }>,
): string {
  const lines: string[] = [];

  const inflation = exposures.inflation ?? 0;
  const liquidity = exposures.liquidity ?? 0;
  const growth = exposures.growth ?? 0;
  const risk = exposures.risk_sentiment ?? 0;
  const commodity = exposures.commodity_pressure ?? 0;

  const bonds = signals.bonds?.signal;
  const equities = signals.equities?.signal;
  const commoditiesSig = signals.commodities?.signal;
  const usd = signals.usd?.signal;

  // Examples requested in spec.
  if (inflation > 0.5 && bonds === "SELL") {
    lines.push(
      "Rising inflation pressure may weaken bond prices due to expectations of higher interest rates.",
    );
  }

  if (liquidity < -0.5 && equities === "SELL") {
    lines.push(
      "Tighter liquidity conditions may create downside pressure for equity markets.",
    );
  }

  // Additional lightweight synthesis (still simple, no extra architecture).
  if (inflation > 0.5 && commoditiesSig === "BUY") {
    lines.push(
      "Elevated inflation tends to support real assets, which can provide a tailwind for commodities.",
    );
  }

  if (risk < -0.5 && equities === "SELL") {
    lines.push(
      "Deteriorating risk sentiment often drives a defensive shift, weighing on equities and favoring safer exposures.",
    );
  }

  if (growth < -0.5 && equities === "SELL") {
    lines.push(
      "Slowing growth expectations can compress earnings outlooks and reduce risk appetite in equity markets.",
    );
  }

  if (liquidity < -0.5 && usd === "BUY") {
    lines.push(
      "Tighter global liquidity can strengthen demand for USD funding, supporting the US dollar.",
    );
  }

  if (commodity > 0.5 && commoditiesSig === "BUY") {
    lines.push(
      "Commodity supply pressure can lift spot prices and reinforce upside skew in commodities.",
    );
  }

  // Fallback if none of the rules fired.
  if (lines.length === 0) {
    const parts: string[] = [];
    if (inflation !== 0) parts.push(`inflation exposure ${inflation.toFixed(2)}`);
    if (liquidity !== 0) parts.push(`liquidity exposure ${liquidity.toFixed(2)}`);
    if (growth !== 0) parts.push(`growth exposure ${growth.toFixed(2)}`);

    const signalParts: string[] = [];
    for (const [asset, v] of Object.entries(signals)) {
      signalParts.push(`${asset} ${v.signal}`);
    }

    const exposureText = parts.length ? parts.join(", ") : "mixed macro exposures";
    const signalText = signalParts.length ? signalParts.join(", ") : "neutral positioning";

    lines.push(
      `This cluster reflects ${exposureText} and maps to portfolio signals: ${signalText}.`,
    );
  }

  // Join into a single paragraph.
  return lines.join(" ");
}

async function loadSignalsForCluster(clusterId: string): Promise<PortfolioSignalRow[]> {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from("portfolio_signals")
    .select("cluster_id,asset,signal,confidence")
    .eq("cluster_id", clusterId);

  if (error) {
    throw new Error(`Failed to load portfolio signals: ${error.message}`);
  }

  return (data as PortfolioSignalRow[] | null) ?? [];
}

async function loadExposuresForCluster(clusterId: string): Promise<FactorExposureRow[]> {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from("event_factor_exposures")
    .select("factor,exposure")
    .eq("cluster_id", clusterId);

  if (error) {
    throw new Error(`Failed to load factor exposures: ${error.message}`);
  }

  return (data as FactorExposureRow[] | null) ?? [];
}

export async function runInsightEngine(): Promise<void> {
  const supabase = createSupabaseServerClient();

  const { data: events, error } = await supabase
    .from("pipeline_events")
    .select("id,payload")
    .eq("event_type", "INSIGHT_REQUIRED")
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

    const { data: existingInsight, error: existingError } = await supabase
      .from("event_insights")
      .select("id")
      .eq("cluster_id", clusterId)
      .limit(1);

    if (existingError) {
      throw new Error(`Failed to check existing insights: ${existingError.message}`);
    }

    if ((existingInsight ?? []).length === 0) {
      const signalsRows = await loadSignalsForCluster(clusterId);
      if (signalsRows.length > 0) {
        const exposuresRows = await loadExposuresForCluster(clusterId);
        const exposures = toExposureMap(exposuresRows);

        const signals: Record<
          string,
          { signal: "BUY" | "SELL" | "NEUTRAL"; confidence: number }
        > = {};

        for (const row of signalsRows) {
          const asset = (row.asset ?? "").toString().trim().toLowerCase();
          if (!asset) continue;
          const signal = normalizeSignal(row.signal);
          const confidence = Number(row.confidence);
          signals[asset] = {
            signal,
            confidence: Number.isFinite(confidence) ? confidence : 0.6,
          };
        }

        const insight = buildInsightText(exposures, signals);

        const conf = clamp(
          0.5,
          avg(Object.values(signals).map((s) => s.confidence)),
          0.95,
        );

        const { error: insertError } = await supabase.from("event_insights").insert({
          cluster_id: clusterId,
          insight,
          confidence: conf,
        });

        if (insertError) {
          throw new Error(
            `Failed to insert event insight: ${insertError.message} (cluster_id=${clusterId})`,
          );
        }
      }
    }

    const { error: markEventError } = await supabase
      .from("pipeline_events")
      .update({ processed: true })
      .eq("id", evt.id);

    if (markEventError) {
      throw new Error(`Failed to mark pipeline event processed: ${markEventError.message}`);
    }
  }
}
