export type RankingWeights = {
  relevance: number;
  recency: number;
  impactStrength: number;
  confidence: number;
  factorExposureStrength: number;
};

export type RankingConfig = {
  weights: RankingWeights;

  /**
   * Recency term decays with age using an exponential half-life.
   * recency = exp(-ln(2) * ageDays / recencyHalfLifeDays)
   */
  recencyHalfLifeDays: number;

  /**
   * Normalizes absolute impact score into [0,1] via: clamp(|impact| / impactScoreScale).
   */
  impactScoreScale: number;

  /**
   * Normalizes factor exposure strength into [0,1] via: clamp(exposureStrength / factorExposureScale).
   */
  factorExposureScale: number;

  /**
   * If true, confidence uses signal confidence first, otherwise insight confidence.
   */
  preferSignalConfidence: boolean;

  now?: () => Date;
};

export const rankingConfig: RankingConfig = {
  weights: {
    relevance: 0.5,
    recency: 0.2,
    impactStrength: 0.2,
    confidence: 0.1,
    factorExposureStrength: 0.1,
  },
  recencyHalfLifeDays: 7,
  impactScoreScale: 1,
  factorExposureScale: 1,
  preferSignalConfidence: true,
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function safeNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function computeRecencyWeight(createdAtIso: string | null | undefined, config: RankingConfig = rankingConfig): number {
  if (!createdAtIso) return 0;
  const createdMs = Date.parse(createdAtIso);
  if (!Number.isFinite(createdMs)) return 0;

  const now = config.now ? config.now() : new Date();
  const ageMs = Math.max(0, now.getTime() - createdMs);
  const ageDays = ageMs / (24 * 60 * 60 * 1000);

  const halfLife = config.recencyHalfLifeDays;
  if (!Number.isFinite(halfLife) || halfLife <= 0) return 0;

  const recency = Math.exp((-Math.LN2 * ageDays) / halfLife);
  return clamp01(recency);
}

export type RankingInputs = {
  relevanceScore: number;
  createdAt: string | null;
  impactScore: number;
  signalConfidence: number | null;
  insightConfidence: number | null;
  factorExposureStrength: number;
};

export type RankingBreakdown = {
  relevance: number;
  recency: number;
  impactStrength: number;
  confidence: number;
  factorExposureStrength: number;
  score: number;
};

export function computeInsightRanking(
  inputs: RankingInputs,
  config: RankingConfig = rankingConfig,
): RankingBreakdown {
  const relevance = clamp01(safeNumber(inputs.relevanceScore));
  const recency = computeRecencyWeight(inputs.createdAt, config);

  const rawImpact = safeNumber(inputs.impactScore);
  const impactStrength = clamp01(Math.abs(rawImpact) / Math.max(1e-9, config.impactScoreScale));

  const rawExposure = safeNumber(inputs.factorExposureStrength);
  const factorExposureStrength = clamp01(rawExposure / Math.max(1e-9, config.factorExposureScale));

  const signalConf = clamp01(safeNumber(inputs.signalConfidence));
  const insightConf = clamp01(safeNumber(inputs.insightConfidence));
  const hasSignal = inputs.signalConfidence !== null && inputs.signalConfidence !== undefined;
  const hasInsight = inputs.insightConfidence !== null && inputs.insightConfidence !== undefined;
  const confidence = config.preferSignalConfidence
    ? (hasSignal ? signalConf : hasInsight ? insightConf : 0)
    : (hasInsight ? insightConf : hasSignal ? signalConf : 0);

  const w = config.weights;
  const score =
    relevance * w.relevance +
    recency * w.recency +
    impactStrength * w.impactStrength +
    confidence * w.confidence +
    factorExposureStrength * w.factorExposureStrength;

  return {
    relevance,
    recency,
    impactStrength,
    confidence,
    factorExposureStrength,
    score,
  };
}

export function computeInsightRankingScore(inputs: RankingInputs, config: RankingConfig = rankingConfig): number {
  return computeInsightRanking(inputs, config).score;
}
