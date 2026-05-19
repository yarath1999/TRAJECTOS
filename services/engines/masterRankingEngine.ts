/**
 * Master Ranking Engine
 *
 * Combines intelligence outputs from multiple engines to produce deterministic,
 * explainable institutional rankings. Separates importance (objective severity)
 * from relevance (user-specific interest), with confidence-aware constraints and
 * causal depth amplification.
 *
 * Philosophy:
 * - Importance is signal-driven and regime-aware
 * - Relevance is user-driven but importance-constrained
 * - Weak confidence caps maximum rank (no false confidence)
 * - Causal depth and narrative strength amplify underlying signals
 * - Recency decays exponentially but doesn't dominate
 * - All scoring is deterministic, bounded [0,1], and traceable
 */

/**
 * Input combining outputs from all intelligence engines.
 */
export interface RankingInput {
  /** Unique identifier (e.g., cluster_id, feed_item_id) */
  id: string;
  /** Event title or summary */
  title: string;

  /** Confidence score from eventConfidenceEngine [0, 1] */
  confidence: number;
  /** Corroboration score from corroborationEngine [0, 1] */
  corroborationScore: number;

  /** Narrative strength from narrativeIntelligenceEngine [0, 1], optional */
  narrativeStrength?: number;

  /** Macro regime importance weighting [0, 1], optional */
  regimeImportance?: number;

  /** Depth of causal chain from causalGraphEngine, optional */
  causalChainDepth?: number;

  /** Affected assets from assetLinkageEngine, optional */
  affectedAssets?: string[];

  /** User relevance score [0, 1], optional */
  relevanceScore?: number;

  /** ISO 8601 publication timestamp, optional */
  published_at?: string;

  /** Manual importance override [0, 1], optional (overrides computed importance) */
  importance_override?: number;
}

/**
 * Detailed ranking output with component scores and classification.
 */
export interface RankingOutput {
  /** Original identifier */
  id: string;
  /** Final blended score [0, 1] */
  finalScore: number;

  /** Component score breakdown */
  breakdown: {
    /** Confidence score contribution */
    confidence: number;
    /** Corroboration score contribution */
    corroboration: number;
    /** Narrative strength contribution */
    narrative: number;
    /** Regime importance contribution */
    regime: number;
    /** Causal depth contribution */
    causal: number;
    /** Asset breadth contribution */
    assetBreadth: number;
    /** User relevance contribution */
    relevance: number;
    /** Recency score contribution */
    recency: number;
  };

  /** Rank classification */
  classification: "Critical" | "High Priority" | "Important" | "Background";

  /** Detailed reasoning for classification */
  reasoning: string[];
}

/**
 * Configuration for ranking engine.
 */
export interface RankingEngineConfig {
  /** Weight for confidence [0, 1] */
  confidenceWeight: number;
  /** Weight for corroboration [0, 1] */
  corroborationWeight: number;
  /** Weight for narrative strength [0, 1] */
  narrativeWeight: number;
  /** Weight for regime importance [0, 1] */
  regimeWeight: number;
  /** Weight for causal depth [0, 1] */
  causalWeight: number;
  /** Weight for asset breadth [0, 1] */
  assetBreadthWeight: number;
  /** Weight for user relevance [0, 1] */
  relevanceWeight: number;
  /** Weight for recency [0, 1] */
  recencyWeight: number;

  /** Confidence threshold: scores below this cap rank to Background */
  minConfidenceForHighRank: number;
  /** Corroboration multiplier: increases importance when high */
  corroborationAmplifier: number;
  /** Causal depth multiplier: increases importance with chain depth */
  causalDepthMultiplier: number;
  /** Narrative multiplier: amplifies importance when narrative is strong */
  narrativeAmplifier: number;
  /** Recency half-life in hours for exponential decay */
  recencyHalfLifeHours: number;

  /** Score thresholds for classification */
  classificationThresholds: {
    critical: number;
    highPriority: number;
    important: number;
  };
}

const defaultConfig: RankingEngineConfig = {
  confidenceWeight: 0.2,
  corroborationWeight: 0.15,
  narrativeWeight: 0.15,
  regimeWeight: 0.1,
  causalWeight: 0.1,
  assetBreadthWeight: 0.1,
  relevanceWeight: 0.1,
  recencyWeight: 0.1,

  minConfidenceForHighRank: 0.25,
  corroborationAmplifier: 1.3,
  causalDepthMultiplier: 1.2,
  narrativeAmplifier: 1.15,
  recencyHalfLifeHours: 48,

  classificationThresholds: {
    critical: 0.85,
    highPriority: 0.65,
    important: 0.45,
  },
};

/**
 * Clamp value to [0, 1].
 */
function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Compute recency score: exponential decay from publication time.
 * Most recent events score ~1.0; stale events decay toward 0.
 */
export function computeRecencyScore(publishedAt: string | undefined, now: Date = new Date(), halfLifeHours: number = 48): number {
  if (!publishedAt) return 0.15; // Default to neutral if unknown

  try {
    const pubTime = new Date(publishedAt).getTime();
    const nowTime = now.getTime();

    if (pubTime > nowTime) return 1.0; // Future events get max score
    if (pubTime <= 0) return 0.15; // Invalid timestamp defaults to neutral

    const hoursOld = (nowTime - pubTime) / (1000 * 60 * 60);
    if (hoursOld < 0) return 1.0;

    // Exponential decay: half-life model
    const decayFactor = Math.pow(0.5, hoursOld / halfLifeHours);
    return clamp01(decayFactor);
  } catch {
    return 0.15; // Default on parse error
  }
}

/**
 * Compute asset breadth score: normalized count and diversity of affected assets.
 * More assets = higher breadth (up to ~7 assets for max score).
 */
export function computeAssetBreadth(
  affectedAssets: string[] | undefined
): number {
  if (!affectedAssets || affectedAssets.length === 0) {
    return 0.2;
  }

  const unique = new Set(
    affectedAssets.map((a) => a.toUpperCase())
  );

  const countScore = Math.min(1, unique.size / 10);

  const systemicAssets = [
    "SPY",
    "QQQ",
    "TLT",
    "GLD",
    "DXY",
    "BTC",
    "ETH",
    "XLE",
    "SMH",
  ];

  const systemicBoost =
    affectedAssets.filter((a) =>
      systemicAssets.includes(a.toUpperCase())
    ).length * 0.08;

  return clamp01(countScore + systemicBoost);
}


/**
 * Normalize a score to [0, 1], handling edge cases.
 */
export function normalizeScore(value: number | undefined, defaultValue: number = 0.5): number {
  if (value === undefined || value === null) return defaultValue;
  const num = Number(value);
  return Number.isFinite(num) ? clamp01(num) : defaultValue;
}

/**
 * Classify rank based on final score.
 */
export function classifyRank(score: number): "Critical" | "High Priority" | "Important" | "Background" {
  const config = defaultConfig;
  if (score >= config.classificationThresholds.critical) return "Critical";
  if (score >= config.classificationThresholds.highPriority) return "High Priority";
  if (score >= config.classificationThresholds.important) return "Important";
  return "Background";
}

/**
 * Compute narrative score contribution: narrative strength with diminishing returns.
 */
function computeNarrativeScore(narrativeStrength: number | undefined): number {
  const strength = normalizeScore(narrativeStrength, 0);
  // Diminishing returns: sqrt dampens very high values
  return Math.sqrt(strength);
}

/**
 * Compute regime score contribution: regime importance with institutional weighting.
 */
function computeRegimeScore(regimeImportance: number | undefined): number {
  const importance = normalizeScore(regimeImportance, 0.5);
  // Regime importance is institutional signal, keep linear
  return importance;
}

/**
 * Compute causal score contribution: depth of causal chain (1-3 levels).
 */
function computeCausalScore(causalChainDepth: number | undefined): number {
  if (!Number.isFinite(causalChainDepth) || causalChainDepth === undefined) return 0.4; // Default: modest causal weight

  const depth = Math.max(0, Math.min(3, Math.floor(causalChainDepth)));
  // Depth 0: 0.3, Depth 1: 0.5, Depth 2: 0.68, Depth 3: 0.8
  const scores = [0.3, 0.5, 0.68, 0.8];
  return scores[depth] ?? 0.3;
}

/**
 * Compute importance amplification from corroboration and narrative strength.
 */
function computeImportanceAmplifier(
  corroborationScore: number,
  narrativeStrength: number | undefined,
  config: RankingEngineConfig,
): number {
  const corrobMultiplier = 1 + Math.max(0, corroborationScore - 0.5) * (config.corroborationAmplifier - 1);
  const narrativeMultiplier = 1 + computeNarrativeScore(narrativeStrength) * (config.narrativeAmplifier - 1);
  return Math.min(
  1.35,
  corrobMultiplier * narrativeMultiplier
);
}

/**
 * Build reasoning explanation from component scores and constraints.
 */
export function explainRanking(input: RankingInput, output: RankingOutput, config: RankingEngineConfig): string[] {
  const reasoning: string[] = [];

  const { breakdown, finalScore, classification } = output;

  // Confidence explanation
  const confidenceRating = input.confidence < 0.25 ? "weak (caps rank)" : input.confidence < 0.5 ? "moderate" : input.confidence < 0.75 ? "strong" : "very strong";
  reasoning.push(`Confidence: ${confidenceRating} (${(input.confidence * 100).toFixed(0)}%)`);

  // Corroboration explanation
  if (input.corroborationScore > 0.5) {
    reasoning.push(`Corroboration: strong cross-source confirmation amplifies importance`);
  } else if (input.corroborationScore > 0) {
    reasoning.push(`Corroboration: limited source confirmation`);
  }

  // Narrative explanation
  if (input.narrativeStrength && input.narrativeStrength > 0.5) {
    reasoning.push(`Narrative: strong macro theme reinforces signal`);
  }

  // Regime explanation
  if (input.regimeImportance && input.regimeImportance > 0.5) {
    reasoning.push(`Regime: aligned with current macro regime`);
  }

  // Causal depth explanation
  if (input.causalChainDepth && input.causalChainDepth >= 2) {
    reasoning.push(`Causal: multi-level market transmission expected`);
  }

  // Asset breadth explanation
  if (input.affectedAssets && input.affectedAssets.length >= 5) {
    reasoning.push(`Asset breadth: ${input.affectedAssets.length} assets affected (systemic)`);
  } else if (input.affectedAssets && input.affectedAssets.length > 0) {
    reasoning.push(`Asset breadth: ${input.affectedAssets.length} asset(s) affected`);
  }

  // Relevance explanation
  if (input.relevanceScore && input.relevanceScore > 0.5) {
    reasoning.push(`User relevance: directly matches portfolio interests`);
  }

  // Recency explanation
  if (breakdown.recency < 0.5) {
    reasoning.push(`Recency: stale event (historical context)`);
  } else if (breakdown.recency > 0.8) {
    reasoning.push(`Recency: fresh event (high timeliness)`);
  }

  // Classification reasoning
  if (input.confidence < config.minConfidenceForHighRank && classification === "Background") {
    reasoning.push(`Confidence constraint: weak signal limits institutional priority`);
  }

  if (input.importance_override !== undefined) {
    reasoning.push(`Manual override: institutional judgment applied`);
  }

  // Final rank explanation
  reasoning.push(`Final rank: ${classification} (score: ${(finalScore * 100).toFixed(1)}%)`);

  return reasoning;
}

/**
 * Compute final score from all components for a single item.
 */
export function rankSingleItem(input: RankingInput, config?: Partial<RankingEngineConfig>): RankingOutput {
  const resolvedConfig = { ...defaultConfig, ...config };

  // Normalize inputs
  const confidence = normalizeScore(input.confidence, 0.5);
  const corroboration = normalizeScore(input.corroborationScore, 0.5);
  const narrativeStrength = normalizeScore(input.narrativeStrength, 0);
  const regimeImportance = normalizeScore(input.regimeImportance, 0.5);
  const assetBreadth = computeAssetBreadth(input.affectedAssets);
  const userRelevance = normalizeScore(input.relevanceScore, 0.5);
  const recency = computeRecencyScore(input.published_at, new Date(), resolvedConfig.recencyHalfLifeHours);

  // Causal depth score
  const causalScore = computeCausalScore(input.causalChainDepth);

  // Build component breakdown
  const breakdown = {
    confidence: confidence * resolvedConfig.confidenceWeight,
    corroboration: corroboration * resolvedConfig.corroborationWeight,
    narrative: computeNarrativeScore(input.narrativeStrength) * resolvedConfig.narrativeWeight,
    regime: regimeImportance * resolvedConfig.regimeWeight,
    causal: causalScore * resolvedConfig.causalWeight,
    assetBreadth: assetBreadth * resolvedConfig.assetBreadthWeight,
    relevance: userRelevance * resolvedConfig.relevanceWeight,
    recency: recency * resolvedConfig.recencyWeight,
  };

  // Compute base importance score (excluding user relevance and recency)
  const importanceBase =
    breakdown.confidence + breakdown.corroboration + breakdown.narrative + breakdown.regime + breakdown.causal + breakdown.assetBreadth;

  // Apply amplification from corroboration and narrative
  const importanceAmplifier = computeImportanceAmplifier(corroboration, input.narrativeStrength, resolvedConfig);
  const amplifiedImportance = importanceBase * importanceAmplifier;

  // Apply manual override if provided
  const finalImportance = input.importance_override !== undefined ? normalizeScore(input.importance_override, amplifiedImportance) : amplifiedImportance;

  // Combine importance, relevance, and recency
  const baseScore =
    finalImportance * 0.65 + // Importance drives 65% of final score
    breakdown.relevance * 0.25 + // Relevance adds 25%
    breakdown.recency * 0.1; // Recency adds 10%

  // Apply confidence constraint: weak confidence caps maximum rank
  let finalScore = baseScore;
  if (confidence < resolvedConfig.minConfidenceForHighRank) {
    // Cap score to Background-level
    finalScore = Math.min(finalScore, 0.35);
  }

  finalScore = clamp01(finalScore);

  const classification = classifyRank(finalScore);
  const reasoning = explainRanking(input, { id: input.id, finalScore, breakdown, classification, reasoning: [] }, resolvedConfig);

  return {
    id: input.id,
    finalScore,
    breakdown,
    classification,
    reasoning,
  };
}

/**
 * Rank multiple items and return sorted by score.
 */
export function rankIntelligenceItems(inputs: RankingInput[], config?: Partial<RankingEngineConfig>): RankingOutput[] {
  const ranked = inputs.map((input) => rankSingleItem(input, config));
  return ranked.sort((a, b) => b.finalScore - a.finalScore);
}

/**
 * Compare two ranking outputs by various criteria.
 */
export function compareRankingOutputs(
  a: RankingOutput,
  b: RankingOutput,
): {
  scoreGap: number;
  classificationDifference: "same" | "one_tier_higher" | "one_tier_lower" | "two_or_more_tiers";
  dominating: "a" | "b" | "none";
} {
  const scoreGap = a.finalScore - b.finalScore;

  const classificationOrder = ["Background", "Important", "High Priority", "Critical"];
  const aRank = classificationOrder.indexOf(a.classification);
  const bRank = classificationOrder.indexOf(b.classification);
  const rankDiff = aRank - bRank;

  let classificationDifference: "same" | "one_tier_higher" | "one_tier_lower" | "two_or_more_tiers";
  if (rankDiff === 0) {
    classificationDifference = "same";
  } else if (rankDiff === 1) {
    classificationDifference = "one_tier_higher";
  } else if (rankDiff === -1) {
    classificationDifference = "one_tier_lower";
  } else {
    classificationDifference = "two_or_more_tiers";
  }

  let dominating: "a" | "b" | "none";
  if (scoreGap > 0.15) {
    dominating = "a";
  } else if (scoreGap < -0.15) {
    dominating = "b";
  } else {
    dominating = "none";
  }

  return {
    scoreGap,
    classificationDifference,
    dominating,
  };
}

/**
 * Get default configuration.
 */
export function getDefaultRankingConfig(): RankingEngineConfig {
  return { ...defaultConfig };
}

/**
 * Helper: create ranking input from partial data (fills in sensible defaults).
 */
export function createRankingInput(
  id: string,
  title: string,
  confidence: number,
  corroborationScore: number,
  partial?: Partial<RankingInput>,
): RankingInput {
  return {
    id,
    title,
    confidence: clamp01(confidence),
    corroborationScore: clamp01(corroborationScore),
    ...partial,
  };
}

/**
 * Helper: check if a ranking output meets a threshold.
 */
export function meetsThreshold(output: RankingOutput, threshold: "critical" | "high" | "important" | "background"): boolean {
  const thresholdMap = {
    critical: defaultConfig.classificationThresholds.critical,
    high: defaultConfig.classificationThresholds.highPriority,
    important: defaultConfig.classificationThresholds.important,
    background: 0,
  };

  return output.finalScore >= thresholdMap[threshold];
}
