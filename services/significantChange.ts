export type SignalDirection = "BUY" | "SELL" | "NEUTRAL";

export type SignalState = Record<string, { direction: SignalDirection; strength: number }>;

export type InsightState = {
  net_bias: string;
  regime: string | null;
  confidence: number;
};

export type AllocationState = Record<string, number>;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function signWithEpsilon(value: number, epsilon: number): -1 | 0 | 1 {
  if (!Number.isFinite(value)) return 0;
  if (value > epsilon) return 1;
  if (value < -epsilon) return -1;
  return 0;
}

/**
 * Significant change rules (SIGNAL stage):
 * - direction changed (BUY ↔ SELL ↔ NEUTRAL), OR
 * - strength change > 0.25 (after smoothing)
 *
 * Safe fallback: if prev is missing/incomplete -> emit.
 */
export function hasSignificantSignalChange(
  prev: SignalState | null,
  current: SignalState,
): boolean {
  if (!prev) return true;

  const assets = new Set<string>([...Object.keys(prev), ...Object.keys(current)]);
  for (const asset of assets) {
    const p = prev[asset];
    const c = current[asset];
    if (!p || !c) return true;

    if (p.direction !== c.direction) return true;

    const ps = clamp01(Number(p.strength));
    const cs = clamp01(Number(c.strength));
    if (Math.abs(ps - cs) > 0.25) return true;
  }

  return false;
}

/**
 * Significant change rules (INSIGHT stage):
 * - net_bias changed (including regime change), OR
 * - confidence change > 0.15 (after smoothing)
 *
 * Safe fallback: if prev is missing -> emit.
 */
export function hasSignificantInsightChange(
  prev: InsightState | null,
  current: InsightState,
): boolean {
  if (!prev) return true;

  const prevNetBias = (prev.net_bias ?? "").toString();
  const currNetBias = (current.net_bias ?? "").toString();
  if (prevNetBias !== currNetBias) return true;

  const prevRegime = prev.regime == null ? null : prev.regime.toString();
  const currRegime = current.regime == null ? null : current.regime.toString();
  if (prevRegime !== currRegime) return true;

  const pc = Number(prev.confidence);
  const cc = Number(current.confidence);
  if (!Number.isFinite(pc) || !Number.isFinite(cc)) return true;
  if (Math.abs(pc - cc) > 0.15) return true;

  return false;
}

/**
 * Significant change rules (ALLOCATION stage):
 * - allocation direction changed (tilt vs base weight), OR
 * - allocation weight change > 10 percentage points
 *
 * Safe fallback: if prev is missing/incomplete -> emit.
 */
export function hasSignificantAllocationChange(params: {
  prev: AllocationState | null;
  current: AllocationState;
  baseWeights: Record<string, number>;
}): boolean {
  const { prev, current, baseWeights } = params;
  if (!prev) return true;

  const assets = new Set<string>([
    ...Object.keys(prev),
    ...Object.keys(current),
    ...Object.keys(baseWeights),
  ]);

  for (const asset of assets) {
    const p = prev[asset];
    const c = current[asset];
    if (!Number.isFinite(Number(p)) || !Number.isFinite(Number(c))) return true;

    const prevWeight = clamp01(Number(p));
    const currWeight = clamp01(Number(c));

    if (Math.abs(prevWeight - currWeight) > 0.10) return true;

    const base = clamp01(Number(baseWeights[asset] ?? 0));
    const prevDir = signWithEpsilon(prevWeight - base, 1e-6);
    const currDir = signWithEpsilon(currWeight - base, 1e-6);
    if (prevDir !== currDir) return true;
  }

  return false;
}
