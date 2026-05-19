export type SignalLabel = "Weak Signal" | "Mixed Signal" | "Strong Signal";

export type EventConfidenceInput = {
  source: string;
  corroborationCount: number;
  entityConfidence: number;
  impactConfidence: number;
  freshnessHours: number;
  contradictionScore: number;
  eventTypeConfidence: number;
};

export type EventConfidenceOutput = {
  confidence: number;
  signal: SignalLabel;
  breakdown: {
    source: number;
    corroboration: number;
    entities: number;
    impact: number;
    freshness: number;
    contradictionPenalty: number;
  };
  reasoning: string[];
};

export type ConfidenceWeights = {
  source: number;
  corroboration: number;
  entities: number;
  impact: number;
  freshness: number;
  eventType: number;
  contradiction: number;
};

export type ConfidenceEngineConfig = {
  weights: ConfidenceWeights;
  freshnessHalfLifeHours: number;
  corroborationScale: number;
  corroborationCurve: number;
  sourceCeiling: number;
  signalThresholds: {
    strong: number;
    mixed: number;
  };
};

export const defaultConfidenceEngineConfig: ConfidenceEngineConfig = {
  weights: {
    source: 0.16,
    corroboration: 0.19,
    entities: 0.15,
    impact: 0.15,
    freshness: 0.13,
    eventType: 0.12,
    contradiction: 0.10,
  },
  freshnessHalfLifeHours: 24,
  corroborationScale: 4,
  corroborationCurve: 1.15,
  sourceCeiling: 1,
  signalThresholds: {
    strong: 0.7,
    mixed: 0.45,
  },
};

const KNOWN_SOURCE_RELIABILITY: Array<{ pattern: RegExp; score: number; reason: string }> = [
  { pattern: /\b(federal reserve|ecb|boj|boe|bank of england|bank of japan)\b/i, score: 0.96, reason: "Central bank source." },
  { pattern: /\b(imf|international monetary fund|world bank)\b/i, score: 0.95, reason: "Multilateral institutional source." },
  { pattern: /\b(reuters)\b/i, score: 0.92, reason: "Tier-1 wire source." },
  { pattern: /\b(bloomberg)\b/i, score: 0.91, reason: "Tier-1 financial wire source." },
  { pattern: /\b(financial times|ft\.com|wsj|wall street journal)\b/i, score: 0.88, reason: "Top-tier financial publication." },
  { pattern: /\b(sec|cftc|fca|doj|eu commission|ftc|ny fed|treasury)\b/i, score: 0.9, reason: "Official regulatory or government source." },
  { pattern: /\b(cnbc|bbc|ap|associated press)\b/i, score: 0.8, reason: "Mainstream newswire or broadcaster." },
  { pattern: /\b(company filing|8-k|10-k|10-q|earnings release|press release)\b/i, score: 0.78, reason: "Primary issuer disclosure." },
];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function clamp(min: number, value: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(value: string): string {
  return value.toLowerCase().trim();
}

function normalizeSourceSource(source: string): { score: number; reason: string } {
  const normalized = normalizeText(source);
  if (!normalized) {
    return { score: 0.45, reason: "No source name supplied; using conservative baseline reliability." };
  }

  for (const entry of KNOWN_SOURCE_RELIABILITY) {
    if (entry.pattern.test(normalized)) {
      return { score: entry.score, reason: entry.reason };
    }
  }

  const hasUrlSignals = /\.(com|org|gov|co|net)\b/i.test(normalized) || /\b(news|wire|media|desk)\b/i.test(normalized);
  if (hasUrlSignals) {
    return { score: 0.62, reason: "Named publication or wire-style source detected." };
  }

  return { score: 0.5, reason: "Unknown source with neutral baseline reliability." };
}

function computeCorroborationScore(count: number, config: ConfidenceEngineConfig): number {
  const n = Math.max(0, Number.isFinite(count) ? Math.floor(count) : 0);
  if (n <= 0) return 0;

  const scale = Math.max(1, config.corroborationScale);
  const normalized = 1 - Math.exp(-Math.pow(n / scale, config.corroborationCurve));
  return clamp01(normalized);
}

function computeFreshnessScore(hours: number, halfLifeHours: number): number {
  const age = Math.max(0, Number.isFinite(hours) ? hours : 0);
  const halfLife = Math.max(0.1, Number.isFinite(halfLifeHours) ? halfLifeHours : 24);
  const score = Math.exp((-Math.LN2 * age) / halfLife);
  return clamp01(score);
}

function computeContradictionPenalty(contradictionScore: number): number {
  const normalized = clamp01(Number.isFinite(contradictionScore) ? contradictionScore : 0);
  return clamp01(Math.pow(normalized, 1.1));
}

function validateConfidenceInput(input: EventConfidenceInput): void {
  if (!input.source || !input.source.toString().trim()) {
    throw new Error("event confidence scoring requires a non-empty source");
  }
}

function normalizeSignal(confidence: number, thresholds: ConfidenceEngineConfig["signalThresholds"]): SignalLabel {
  if (confidence >= thresholds.strong) return "Strong Signal";
  if (confidence >= thresholds.mixed) return "Mixed Signal";
  return "Weak Signal";
}

export function scoreEventConfidence(
  input: EventConfidenceInput,
  config: ConfidenceEngineConfig = defaultConfidenceEngineConfig,
): EventConfidenceOutput {
  validateConfidenceInput(input);

  const source = normalizeSourceSource(input.source);
  const corroboration = computeCorroborationScore(input.corroborationCount, config);
  const entities = clamp01(Number.isFinite(input.entityConfidence) ? input.entityConfidence : 0);
  const impact = clamp01(Number.isFinite(input.impactConfidence) ? input.impactConfidence : 0);
  const freshness = computeFreshnessScore(input.freshnessHours, config.freshnessHalfLifeHours);
  const eventType = clamp01(Number.isFinite(input.eventTypeConfidence) ? input.eventTypeConfidence : 0);
  const contradictionPenalty = computeContradictionPenalty(input.contradictionScore);

  const weights = config.weights;
  const positiveWeightTotal = weights.source + weights.corroboration + weights.entities + weights.impact + weights.freshness + weights.eventType;
  const weightedNumerator =
    source.score * weights.source +
    corroboration * weights.corroboration +
    entities * weights.entities +
    impact * weights.impact +
    freshness * weights.freshness +
    eventType * weights.eventType;

  const normalizedPositive = positiveWeightTotal > 0 ? weightedNumerator / positiveWeightTotal : 0;
  const penaltyWeight = clamp(0, weights.contradiction, 1);
  const adjusted = clamp01(normalizedPositive * (1 - penaltyWeight * contradictionPenalty));

  const sourceWeightInfo = source.reason;
  const reasoning: string[] = [
    `Source reliability scored ${source.score.toFixed(3)}. ${sourceWeightInfo}`,
    `Corroboration count ${Math.max(0, Math.floor(Number.isFinite(input.corroborationCount) ? input.corroborationCount : 0))} normalized to ${corroboration.toFixed(3)} using a saturating curve.`,
    `Entity confidence contributed ${entities.toFixed(3)} to the score.`,
    `Impact confidence contributed ${impact.toFixed(3)} to the score.`,
    `Freshness decayed to ${freshness.toFixed(3)} using a ${config.freshnessHalfLifeHours}h half-life.`,
    `Event-type confidence contributed ${eventType.toFixed(3)} to the score.`,
    `Contradiction score ${clamp01(Number.isFinite(input.contradictionScore) ? input.contradictionScore : 0).toFixed(3)} applied a penalty of ${contradictionPenalty.toFixed(3)}.`,
  ];

  if (adjusted >= config.signalThresholds.strong) {
    reasoning.push("Composite score cleared the strong-signal threshold after normalization and penalty adjustment.");
  } else if (adjusted >= config.signalThresholds.mixed) {
    reasoning.push("Composite score cleared the mixed-signal threshold but did not reach strong-signal strength.");
  } else {
    reasoning.push("Composite score remained below the mixed-signal threshold after penalties and decay.");
  }

  return {
    confidence: Number(adjusted.toFixed(3)),
    signal: normalizeSignal(adjusted, config.signalThresholds),
    breakdown: {
      source: Number(source.score.toFixed(3)),
      corroboration: Number(corroboration.toFixed(3)),
      entities: Number(entities.toFixed(3)),
      impact: Number(impact.toFixed(3)),
      freshness: Number(freshness.toFixed(3)),
      contradictionPenalty: Number(contradictionPenalty.toFixed(3)),
    },
    reasoning,
  };
}

export function scoreEventConfidenceFromParts(
  source: string,
  corroborationCount: number,
  entityConfidence: number,
  impactConfidence: number,
  freshnessHours: number,
  contradictionScore: number,
  eventTypeConfidence: number,
  config: ConfidenceEngineConfig = defaultConfidenceEngineConfig,
): EventConfidenceOutput {
  return scoreEventConfidence(
    {
      source,
      corroborationCount,
      entityConfidence,
      impactConfidence,
      freshnessHours,
      contradictionScore,
      eventTypeConfidence,
    },
    config,
  );
}

export function computeFreshnessDecay(hours: number, halfLifeHours = defaultConfidenceEngineConfig.freshnessHalfLifeHours): number {
  return computeFreshnessScore(hours, halfLifeHours);
}

export function computeCorroborationNormalization(count: number, config: ConfidenceEngineConfig = defaultConfidenceEngineConfig): number {
  return computeCorroborationScore(count, config);
}

export function computeContradictionPenaltyValue(contradictionScore: number): number {
  return computeContradictionPenalty(contradictionScore);
}

export function getSourceReliabilityScore(source: string): number {
  return normalizeSourceSource(source).score;
}

export function getSourceReliabilityReason(source: string): string {
  return normalizeSourceSource(source).reason;
}
