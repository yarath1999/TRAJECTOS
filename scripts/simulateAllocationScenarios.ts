/* eslint-disable @typescript-eslint/no-explicit-any */
import { analyzeRegime } from "../services/regimeEngine";
import { allocationModel } from "../lib/allocationModel";

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
  for (const asset of Object.keys(out)) out[asset] = out[asset] / sum;
  return out;
}

function buildSignalMapFromReasoning(reasoning: unknown) {
  let v: unknown = reasoning;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return new Map<string, { signal: keyof typeof allocationModel; confidence: number }>();
    }
  }
  if (!v || typeof v !== "object") return new Map();
  const signals = (v as any).signals ?? [];
  const out = new Map<string, { signal: keyof typeof allocationModel; confidence: number }>();
  for (const row of signals) {
    if (!row) continue;
    const source = (row.source_factor ?? "").toString().trim().toLowerCase();
    if (!source) continue;
    const dir = (row.direction ?? "").toString().trim().toUpperCase();
    const signal = dir === "BUY" || dir === "SELL" ? dir : "NEUTRAL";
    const conf = Number(row.confidence);
    const confidence = Number.isFinite(conf) ? clamp01(conf) : 0.6;
    out.set(source, { signal: signal as any, confidence });
  }
  return out;
}

const baseWeights: Record<string, number> = { equities: 0.4, bonds: 0.3, commodities: 0.2, usd: 0.1, cash: 0 };

const scenarios: Array<{ label: string; reasoning: string }> = [];

// Helper to create reasoning JSON
function makeReasoning(regime?: string, signalRows?: Array<any>) {
  const obj: any = {};
  if (regime !== undefined) obj.regime = regime;
  obj.signals = signalRows ?? [];
  return JSON.stringify(obj);
}

// strong risk_off: equities SELL, usd BUY
scenarios.push({ label: "risk_off_strong", reasoning: makeReasoning("risk_off", [
  { source_factor: "equities", direction: "SELL", confidence: 0.9 },
  { source_factor: "usd", direction: "BUY", confidence: 0.85 },
]) });

// weak risk_off: equities SELL only
scenarios.push({ label: "risk_off_weak", reasoning: makeReasoning(undefined, [
  { source_factor: "equities", direction: "SELL", confidence: 0.45 },
]) });

// conflicting risk_off: equities SELL but usd neutral
scenarios.push({ label: "risk_off_conflicting", reasoning: makeReasoning(undefined, [
  { source_factor: "equities", direction: "SELL", confidence: 0.6 },
  { source_factor: "usd", direction: "NEUTRAL", confidence: 0.5 },
]) });

// strong inflationary: bonds SELL, commodities BUY
scenarios.push({ label: "inflationary_strong", reasoning: makeReasoning("inflationary", [
  { source_factor: "bonds", direction: "SELL", confidence: 0.9 },
  { source_factor: "commodities", direction: "BUY", confidence: 0.9 },
]) });

// weak inflationary: commodities BUY only
scenarios.push({ label: "inflationary_weak", reasoning: makeReasoning(undefined, [
  { source_factor: "commodities", direction: "BUY", confidence: 0.35 },
]) });

// growth strong: equities BUY, commodities BUY
scenarios.push({ label: "growth_strong", reasoning: makeReasoning("growth", [
  { source_factor: "equities", direction: "BUY", confidence: 0.9 },
  { source_factor: "commodities", direction: "BUY", confidence: 0.8 },
]) });

// growth weak: equities BUY small confidence
scenarios.push({ label: "growth_weak", reasoning: makeReasoning(undefined, [
  { source_factor: "equities", direction: "BUY", confidence: 0.4 },
]) });

// deflationary strong: bonds BUY, equities SELL
scenarios.push({ label: "deflationary_strong", reasoning: makeReasoning("deflationary", [
  { source_factor: "bonds", direction: "BUY", confidence: 0.9 },
  { source_factor: "equities", direction: "SELL", confidence: 0.9 },
]) });

// deflationary weak
scenarios.push({ label: "deflationary_weak", reasoning: makeReasoning(undefined, [
  { source_factor: "bonds", direction: "BUY", confidence: 0.3 },
]) });

// conflicting signals -- tie across regimes
scenarios.push({ label: "conflicting_signals_1", reasoning: makeReasoning(undefined, [
  { source_factor: "bonds", direction: "BUY", confidence: 0.6 },
  { source_factor: "commodities", direction: "BUY", confidence: 0.6 },
  { source_factor: "equities", direction: "SELL", confidence: 0.6 },
  { source_factor: "usd", direction: "BUY", confidence: 0.6 },
]) });

scenarios.push({ label: "conflicting_signals_2", reasoning: makeReasoning(undefined, [
  { source_factor: "bonds", direction: "SELL", confidence: 0.6 },
  { source_factor: "commodities", direction: "SELL", confidence: 0.6 },
  { source_factor: "equities", direction: "BUY", confidence: 0.6 },
]) });

// null regime / empty reasoning
scenarios.push({ label: "null_regime_empty", reasoning: "{}" });
scenarios.push({ label: "null_regime_null", reasoning: "null" });

// noisy reasoning: malformed JSON
scenarios.push({ label: "noisy_malformed", reasoning: "{\"signals\":[{source_factor: 'equities', direction: BUY}]" });

// noisy reasoning: random extra fields
scenarios.push({ label: "noisy_extra_fields", reasoning: makeReasoning(undefined, [
  { source_factor: "equities", direction: "BUY", confidence: 0.7, extra: "x" },
  { source_factor: "usd", direction: "BUY", confidence: 0.2, noise: 123 },
]) });

// repeated patterns to reach 20 scenarios (variations)
scenarios.push({ label: "risk_off_variant_A", reasoning: makeReasoning(undefined, [
  { source_factor: "equities", direction: "SELL", confidence: 0.8 },
  { source_factor: "usd", direction: "BUY", confidence: 0.2 },
]) });

scenarios.push({ label: "inflationary_variant_A", reasoning: makeReasoning(undefined, [
  { source_factor: "commodities", direction: "BUY", confidence: 0.75 },
  { source_factor: "bonds", direction: "SELL", confidence: 0.4 },
]) });

scenarios.push({ label: "growth_variant_A", reasoning: makeReasoning(undefined, [
  { source_factor: "equities", direction: "BUY", confidence: 0.6 },
  { source_factor: "commodities", direction: "NEUTRAL", confidence: 0.6 },
]) });

scenarios.push({ label: "deflationary_variant_A", reasoning: makeReasoning(undefined, [
  { source_factor: "bonds", direction: "BUY", confidence: 0.8 },
  { source_factor: "equities", direction: "SELL", confidence: 0.2 },
]) });

// final filler
scenarios.push({ label: "mixed_low_confidence", reasoning: makeReasoning(undefined, [
  { source_factor: "bonds", direction: "SELL", confidence: 0.2 },
  { source_factor: "commodities", direction: "BUY", confidence: 0.3 },
]) });

// Ensure exactly 20
if (scenarios.length > 20) scenarios.splice(20);

async function runScenario(label: string, reasoningStr: string) {
  console.log("============================================");
  console.log(`Scenario: ${label}`);
  // Call regime analysis
  let reasoning: unknown = reasoningStr;
  try {
    reasoning = JSON.parse(reasoningStr);
  } catch {
    // keep string if malformed
  }
  const res = analyzeRegime(reasoning);
  console.log("Detected (raw):", res.rawRegime);
  console.log("Smoothed:", res.smoothedRegime);
  console.log("Confidence:", res.confidence.toFixed(3));
  console.log("Adjustment strength:", res.adjustmentStrength.toFixed(3));

  // Build signals and compute allocations locally (no DB)
  const signalMap = buildSignalMapFromReasoning(reasoning);
  const rawWeights: Record<string, number> = { ...baseWeights };
  for (const asset of Object.keys(baseWeights)) {
    if (asset === "cash") continue;
    const entry = signalMap.get(asset);
    if (!entry) continue;
    rawWeights[asset] = (rawWeights[asset] ?? 0) + (allocationModel as any)[entry.signal];
  }

  // Apply regime adjustments using res.finalRegime and res.adjustmentStrength
  const str = res.adjustmentStrength;
  switch (res.finalRegime) {
    case "inflationary":
      rawWeights["commodities"] = (rawWeights["commodities"] ?? 0) + str;
      rawWeights["bonds"] = (rawWeights["bonds"] ?? 0) - str;
      break;
    case "risk_off":
      rawWeights["bonds"] = (rawWeights["bonds"] ?? 0) + str;
      rawWeights["equities"] = (rawWeights["equities"] ?? 0) - str;
      break;
    case "growth":
      rawWeights["equities"] = (rawWeights["equities"] ?? 0) + str;
      rawWeights["commodities"] = (rawWeights["commodities"] ?? 0) + str;
      break;
    case "deflationary":
      rawWeights["bonds"] = (rawWeights["bonds"] ?? 0) + str;
      rawWeights["equities"] = (rawWeights["equities"] ?? 0) - str;
      break;
  }

  const final = normalizeAllocations(rawWeights);
  console.log("Final allocations:");
  for (const [k, v] of Object.entries(final)) console.log(`  ${k}: ${v.toFixed(3)}`);
}

async function main() {
  for (const s of scenarios) {
    await runScenario(s.label, s.reasoning);
  }
  console.log("============================================");
  console.log("Simulation complete");
}

void main();
/* eslint-enable @typescript-eslint/no-explicit-any */