import assert from "node:assert/strict";
import test from "node:test";

import { allocationModel, type AllocationSignal } from "../lib/allocationModel";
import {
  DEFAULT_REGIME_ADJUSTMENT,
  MAX_REGIME_ADJUSTMENT,
  MIN_REGIME_ADJUSTMENT,
  REGIME_CONFIDENCE_STRONG_MIN,
  REGIME_CONFIDENCE_WEAK_MAX,
} from "../config/allocationConfig";
import { scoreRegimeSignals, type MacroRegime } from "../services/regimeEngine";

type ReasoningSignal = {
  source_factor: string;
  direction: AllocationSignal;
  confidence?: number;
};

type ReasoningExample = {
  name: string;
  reasoning: {
    signals: ReasoningSignal[];
  } & Record<string, unknown>;
};

type AllocationSnapshot = {
  name: string;
  detectedRegime: MacroRegime | null;
  confidence: number;
  finalAllocations: Record<string, number>;
};

const BASE_WEIGHTS: Record<string, number> = {
  equities: 0.4,
  bonds: 0.3,
  commodities: 0.2,
  usd: 0.1,
  cash: 0,
};

const SNAPSHOT_ASSET_ORDER = ["equities", "bonds", "commodities", "usd", "cash"] as const;

const EXAMPLES: ReasoningExample[] = [
  {
    name: "growth_pure",
    reasoning: {
      signals: [
        { source_factor: "equities", direction: "BUY", confidence: 0.91 },
        { source_factor: "commodities", direction: "BUY", confidence: 0.89 },
      ],
      context: "baseline growth reading",
    },
  },
  {
    name: "growth_with_usd_buy",
    reasoning: {
      signals: [
        { source_factor: "equities", direction: "BUY", confidence: 0.9 },
        { source_factor: "commodities", direction: "BUY", confidence: 0.85 },
        { source_factor: "usd", direction: "BUY", confidence: 0.7 },
      ],
      context: "growth with a USD tailwind",
    },
  },
  {
    name: "growth_with_metadata_noise",
    reasoning: {
      signals: [
        { source_factor: "equities", direction: "BUY", confidence: 0.88 },
        { source_factor: "commodities", direction: "BUY", confidence: 0.84 },
      ],
      context: "extra metadata should not affect output",
      notes: { source: "ignored" },
    },
  },
  {
    name: "inflationary_pure",
    reasoning: {
      signals: [
        { source_factor: "bonds", direction: "SELL", confidence: 0.92 },
        { source_factor: "commodities", direction: "BUY", confidence: 0.88 },
      ],
      context: "baseline inflationary reading",
    },
  },
  {
    name: "inflationary_with_usd_buy",
    reasoning: {
      signals: [
        { source_factor: "bonds", direction: "SELL", confidence: 0.93 },
        { source_factor: "commodities", direction: "BUY", confidence: 0.83 },
        { source_factor: "usd", direction: "BUY", confidence: 0.64 },
      ],
      context: "inflationary with risk-off support",
    },
  },
  {
    name: "inflationary_with_metadata_noise",
    reasoning: {
      signals: [
        { source_factor: "bonds", direction: "SELL", confidence: 0.9 },
        { source_factor: "commodities", direction: "BUY", confidence: 0.82 },
      ],
      context: "extra metadata should not affect output",
      notes: { source: "ignored" },
    },
  },
  {
    name: "risk_off_pure",
    reasoning: {
      signals: [
        { source_factor: "equities", direction: "SELL", confidence: 0.95 },
        { source_factor: "usd", direction: "BUY", confidence: 0.87 },
      ],
      context: "baseline risk-off reading",
    },
  },
  {
    name: "risk_off_with_metadata_noise",
    reasoning: {
      signals: [
        { source_factor: "equities", direction: "SELL", confidence: 0.93 },
        { source_factor: "usd", direction: "BUY", confidence: 0.88 },
      ],
      context: "extra metadata should not affect output",
      notes: { source: "ignored" },
    },
  },
  {
    name: "deflationary_pure",
    reasoning: {
      signals: [
        { source_factor: "bonds", direction: "BUY", confidence: 0.96 },
        { source_factor: "equities", direction: "SELL", confidence: 0.86 },
      ],
      context: "baseline deflationary reading",
    },
  },
  {
    name: "deflationary_with_commodities_buy",
    reasoning: {
      signals: [
        { source_factor: "bonds", direction: "BUY", confidence: 0.94 },
        { source_factor: "equities", direction: "SELL", confidence: 0.83 },
        { source_factor: "commodities", direction: "BUY", confidence: 0.67 },
      ],
      context: "deflationary with a growth overlap",
    },
  },
];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function normalizeAllocations(weights: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};

  for (const [asset, weight] of Object.entries(weights)) {
    out[asset] = clamp01(weight);
  }

  const sum = Object.values(out).reduce((total, weight) => total + weight, 0);
  if (sum <= 0) {
    return { ...Object.fromEntries(Object.keys(out).map((asset) => [asset, 0])), cash: 1 };
  }

  for (const asset of Object.keys(out)) {
    out[asset] = out[asset] / sum;
  }

  return out;
}

function confidenceFromScores(topScore: number, scores: Record<string, number>): number {
  const totalScore = Object.values(scores).reduce((total, score) => total + score, 0);
  return totalScore > 0 ? topScore / totalScore : 0;
}

function regimeAdjustmentStrength(confidence: number): number {
  let strength = DEFAULT_REGIME_ADJUSTMENT;

  if (confidence <= REGIME_CONFIDENCE_WEAK_MAX) {
    const ratio = confidence / Math.max(0.000001, REGIME_CONFIDENCE_WEAK_MAX);
    strength = MIN_REGIME_ADJUSTMENT + ratio * (0.04 - MIN_REGIME_ADJUSTMENT);
  } else if (confidence < REGIME_CONFIDENCE_STRONG_MIN) {
    strength = DEFAULT_REGIME_ADJUSTMENT;
  } else {
    const ratio = (confidence - REGIME_CONFIDENCE_STRONG_MIN) / Math.max(0.000001, 1 - REGIME_CONFIDENCE_STRONG_MIN);
    strength = 0.06 + Math.max(0, Math.min(1, ratio)) * (MAX_REGIME_ADJUSTMENT - 0.06);
  }

  if (strength < MIN_REGIME_ADJUSTMENT) strength = MIN_REGIME_ADJUSTMENT;
  if (strength > MAX_REGIME_ADJUSTMENT) strength = MAX_REGIME_ADJUSTMENT;
  if (!Number.isFinite(strength)) strength = DEFAULT_REGIME_ADJUSTMENT;
  return strength;
}

function parseSignals(reasoning: { signals: ReasoningSignal[] }): Map<string, AllocationSignal> {
  const signalByAsset = new Map<string, AllocationSignal>();

  for (const row of reasoning.signals) {
    const asset = row.source_factor.trim().toLowerCase();
    if (!asset) continue;
    signalByAsset.set(asset, row.direction);
  }

  return signalByAsset;
}

function computeAllocations(reasoning: { signals: ReasoningSignal[] }): AllocationSnapshot {
  const scored = scoreRegimeSignals(reasoning.signals);
  const detectedRegime = scored.regime;
  const confidence = confidenceFromScores(scored.topScore, scored.scores);
  const adjustmentStrength = regimeAdjustmentStrength(confidence);
  const signalByAsset = parseSignals(reasoning);

  const rawWeights: Record<string, number> = { ...BASE_WEIGHTS };
  for (const asset of Object.keys(BASE_WEIGHTS)) {
    if (asset === "cash") continue;
    const signal = signalByAsset.get(asset);
    if (!signal) continue;
    rawWeights[asset] = (rawWeights[asset] ?? 0) + allocationModel[signal];
  }

  switch (detectedRegime) {
    case "inflationary":
      rawWeights.commodities = (rawWeights.commodities ?? 0) + adjustmentStrength;
      rawWeights.bonds = (rawWeights.bonds ?? 0) - adjustmentStrength;
      break;
    case "risk_off":
      rawWeights.bonds = (rawWeights.bonds ?? 0) + adjustmentStrength;
      rawWeights.equities = (rawWeights.equities ?? 0) - adjustmentStrength;
      break;
    case "growth":
      rawWeights.equities = (rawWeights.equities ?? 0) + adjustmentStrength;
      rawWeights.commodities = (rawWeights.commodities ?? 0) + adjustmentStrength;
      break;
    case "deflationary":
      rawWeights.bonds = (rawWeights.bonds ?? 0) + adjustmentStrength;
      rawWeights.equities = (rawWeights.equities ?? 0) - adjustmentStrength;
      break;
  }

  return {
    name: "",
    detectedRegime,
    confidence,
    finalAllocations: normalizeAllocations(rawWeights),
  };
}

function formatSnapshot(snapshot: AllocationSnapshot): string {
  const lines = [
    `${snapshot.name}`,
    `  detected regime: ${snapshot.detectedRegime ?? "null"}`,
    `  confidence: ${snapshot.confidence.toFixed(3)}`,
    `  final allocations:`,
  ];

  for (const asset of SNAPSHOT_ASSET_ORDER) {
    lines.push(`    ${asset}: ${snapshot.finalAllocations[asset].toFixed(4)}`);
  }

  return lines.join("\n");
}

test("allocation output snapshots stay stable", () => {
  const snapshots = EXAMPLES.map((example) => {
    const computed = computeAllocations(example.reasoning);
    return formatSnapshot({ ...computed, name: example.name });
  });

  const actual = snapshots.join("\n\n");

  const expected = [
    [
      "growth_pure",
      "  detected regime: growth",
      "  confidence: 0.667",
      "  final allocations:",
      "    equities: 0.4412",
      "    bonds: 0.1765",
      "    commodities: 0.3235",
      "    usd: 0.0588",
      "    cash: 0.0000",
    ].join("\n"),
    [
      "growth_with_usd_buy",
      "  detected regime: growth",
      "  confidence: 0.500",
      "  final allocations:",
      "    equities: 0.3750",
      "    bonds: 0.1500",
      "    commodities: 0.2750",
      "    usd: 0.2000",
      "    cash: 0.0000",
    ].join("\n"),
    [
      "growth_with_metadata_noise",
      "  detected regime: growth",
      "  confidence: 0.667",
      "  final allocations:",
      "    equities: 0.4412",
      "    bonds: 0.1765",
      "    commodities: 0.3235",
      "    usd: 0.0588",
      "    cash: 0.0000",
    ].join("\n"),
    [
      "inflationary_pure",
      "  detected regime: inflationary",
      "  confidence: 0.667",
      "  final allocations:",
      "    equities: 0.3810",
      "    bonds: 0.0000",
      "    commodities: 0.5238",
      "    usd: 0.0952",
      "    cash: 0.0000",
    ].join("\n"),
    [
      "inflationary_with_usd_buy",
      "  detected regime: inflationary",
      "  confidence: 0.500",
      "  final allocations:",
      "    equities: 0.2963",
      "    bonds: 0.0000",
      "    commodities: 0.4074",
      "    usd: 0.2963",
      "    cash: 0.0000",
    ].join("\n"),
    [
      "inflationary_with_metadata_noise",
      "  detected regime: inflationary",
      "  confidence: 0.667",
      "  final allocations:",
      "    equities: 0.3810",
      "    bonds: 0.0000",
      "    commodities: 0.5238",
      "    usd: 0.0952",
      "    cash: 0.0000",
    ].join("\n"),
    [
      "risk_off_pure",
      "  detected regime: risk_off",
      "  confidence: 0.667",
      "  final allocations:",
      "    equities: 0.0500",
      "    bonds: 0.3500",
      "    commodities: 0.2000",
      "    usd: 0.4000",
      "    cash: 0.0000",
    ].join("\n"),
    [
      "risk_off_with_metadata_noise",
      "  detected regime: risk_off",
      "  confidence: 0.667",
      "  final allocations:",
      "    equities: 0.0500",
      "    bonds: 0.3500",
      "    commodities: 0.2000",
      "    usd: 0.4000",
      "    cash: 0.0000",
    ].join("\n"),
    [
      "deflationary_pure",
      "  detected regime: deflationary",
      "  confidence: 0.667",
      "  final allocations:",
      "    equities: 0.0500",
      "    bonds: 0.6500",
      "    commodities: 0.2000",
      "    usd: 0.1000",
      "    cash: 0.0000",
    ].join("\n"),
    [
      "deflationary_with_commodities_buy",
      "  detected regime: deflationary",
      "  confidence: 0.400",
      "  final allocations:",
      "    equities: 0.0462",
      "    bonds: 0.4923",
      "    commodities: 0.3846",
      "    usd: 0.0769",
      "    cash: 0.0000",
    ].join("\n"),
  ].join("\n\n");

  assert.equal(actual, expected);
});