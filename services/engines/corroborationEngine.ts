/**
 * Corroboration Engine
 *
 * Determines how strongly an event is confirmed across multiple independent sources.
 * Applies source credibility weighting, narrative clustering, time decay, and
 * contradiction detection to produce institutional-grade corroboration signals.
 *
 * Philosophy:
 * - Independent sources increase confidence exponentially (first confirmation worth more)
 * - Different narratives (e.g., bullish vs bearish) reduce overall confidence
 * - Older reports decay in influence; recent confirmation is valued highly
 * - Source tier provides significant weight adjustment
 */

import { computeIndependenceScore, getOwnershipGroup, getSourceCredibility } from "./sourceCredibility";

/**
 * Single corroborating report from a source.
 */
export interface CorroboratingReport {
  /** Source domain or identifier */
  source: string;
  /** Report title or headline */
  title: string;
  /** ISO 8601 publication timestamp */
  published_at: string;
  /** Semantic similarity to primary event [0, 1] */
  similarity_score: number;
}

/**
 * Output structure for corroboration assessment.
 */
export interface CorroborationOutput {
  /** Overall corroboration strength [0, 1] */
  corroborationScore: number;
  /** Count of independent sources confirming the event */
  independentConfirmations: number;
  /** Count of sources reporting contradictory narratives */
  conflictingNarratives: number;
  /** How well narratives align [0, 1] */
  narrativeAgreementScore: number;
  /** Confidence adjustment multiplier [0, 1.5] for use in scoring engines */
  confidenceAdjustment: number;
}

/**
 * Internal narrative cluster.
 */
interface NarrativeCluster {
  narrativeId: string;
  sources: Array<{
    source: string;
    tier: 1 | 2 | 3 | 4 | 5;
    credibilityScore: number;
    publishedAt: Date;
  }>;
  avgSimilarity: number;
  isContradictory: boolean;
}

/**
 * Configuration for corroboration scoring.
 */
export interface CorroborationConfig {
  /** Weight for tier 1 sources [0, 1] */
  tier1Weight: number;
  /** Weight for tier 2 sources [0, 1] */
  tier2Weight: number;
  /** Weight for tier 3 sources [0, 1] */
  tier3Weight: number;
  /** Weight for tier 4 sources [0, 1] */
  tier4Weight: number;
  /** Freshness window in hours; reports older than this decay quickly */
  freshnessWindowHours: number;
  /** Similarity threshold for grouping narratives [0, 1] */
  narrativeSimilarityThreshold: number;
  /** Time decay function: exp(-ln(2) * hoursOld / decayHalfLife) */
  timeDecayHalfLifeHours: number;
  /** Bonus for having multiple independent Tier 1 sources */
  multiSourceTier1Bonus: number;
}

/**
 * Default production configuration.
 * Tier 1 sources are heavily weighted; time decay half-life is 48 hours.
 */
const defaultConfig: CorroborationConfig = {
  tier1Weight: 1.0,
  tier2Weight: 0.85,
  tier3Weight: 0.65,
  tier4Weight: 0.4,
  freshnessWindowHours: 168, // 7 days
  narrativeSimilarityThreshold: 0.72,
  timeDecayHalfLifeHours: 48,
  multiSourceTier1Bonus: 0.15,
};

/**
 * Extract base domain from source identifier.
 */
function getSourceDomain(source: string): string {
  return source.toLowerCase().split("/")[0];
}

/**
 * Compute time decay: exponential with half-life.
 * Reports from 48 hours ago get 50% weight; older reports get progressively less.
 */
function computeTimeDecay(publishedAt: Date, referenceTime: Date, halfLifeHours: number): number {
  const hoursOld = (referenceTime.getTime() - publishedAt.getTime()) / (1000 * 60 * 60);
  if (hoursOld < 0) return 1.0; // Future reports get full weight (shouldn't happen)
  return Math.exp((-Math.LN2 * hoursOld) / halfLifeHours);
}

/**
 * Detect if a narrative is likely contradictory to the main event.
 * Simple heuristics: keywords like "denied", "false", "hoax", "rejects", etc.
 */
function isContradictoryNarrative(title: string): boolean {
  const contradictoryKeywords = [
    "deny",
    "denied",
    "deny",
    "denies",
    "false",
    "hoax",
    "reject",
    "rejects",
    "wrong",
    "not true",
    "debunk",
    "disprove",
    "contradiction",
    "contradicts",
    "cannot confirm",
    "no evidence",
    "unsubstantiated",
    "unfounded",
    "opposes",
    "disputes",
  ];

  const lowerTitle = title.toLowerCase();
  return contradictoryKeywords.some((keyword) => lowerTitle.includes(keyword));
}

/**
 * Group reports into narrative clusters based on similarity and contradictions.
 * Reports with high similarity and same contradiction status are grouped.
 */
function clusterNarratives(
  reports: CorroboratingReport[],
  config: CorroborationConfig
): Map<string, NarrativeCluster> {
  const clusters = new Map<string, NarrativeCluster>();
  let clusterCounter = 0;

  const now = new Date();

  for (const report of reports) {
    const sourceCredibility = getSourceCredibility(report.source);
    const tier = parseInt(sourceCredibility.tier.split(" ")[1]) as 1 | 2 | 3 | 4 | 5;
    const tierWeight = getTierWeight(tier, config);
    const publishedAt = new Date(report.published_at);
    const timeDecay = computeTimeDecay(publishedAt, now, config.timeDecayHalfLifeHours);
    const credibilityScore = sourceCredibility.score * timeDecay;

    // Try to find matching cluster
    let foundCluster = false;

    for (const [clusterId, cluster] of clusters.entries()) {
      // Check if narrative aligns (similar similarity score and contradiction status)
      const isReportContradictory = isContradictoryNarrative(report.title);
      const isClusterContradictory = cluster.isContradictory;

      if (isReportContradictory === isClusterContradictory) {
        // Similar narrative status; check similarity threshold
        if (report.similarity_score >= config.narrativeSimilarityThreshold) {
          // Add to this cluster
          cluster.sources.push({
            source: getSourceDomain(report.source),
            tier,
            credibilityScore,
            publishedAt,
          });

          // Update average similarity
          cluster.avgSimilarity =
            (cluster.avgSimilarity * (cluster.sources.length - 1) + report.similarity_score) /
            cluster.sources.length;

          foundCluster = true;
          break;
        }
      }
    }

    // Create new cluster if no match
    if (!foundCluster) {
      const narrativeId = `narrative_${clusterCounter++}`;
      clusters.set(narrativeId, {
        narrativeId,
        sources: [
          {
            source: getSourceDomain(report.source),
            tier,
            credibilityScore,
            publishedAt,
          },
        ],
        avgSimilarity: report.similarity_score,
        isContradictory: isContradictoryNarrative(report.title),
      });
    }
  }

  return clusters;
}

/**
 * Get tier weight multiplier from config.
 */
function getTierWeight(tier: 1 | 2 | 3 | 4 | 5, config: CorroborationConfig): number {
  const weights = {
    1: config.tier1Weight,
    2: config.tier2Weight,
    3: config.tier3Weight,
    4: config.tier4Weight,
    5: 0.2, // Tier 5 unknown sources get minimal weight
  };
  return weights[tier];
}

interface IndependenceProfile {
  effectiveConfirmations: number;
  independenceScore: number;
  uniqueDomains: number;
  uniqueOwnershipGroups: number;
  sameDomainReposts: number;
  sameOwnershipGroupReposts: number;
}

/**
 * Identify source independence using both domain and ownership-group normalization.
 * Same-domain repeats contribute minimal additional independence.
 * Same-ownership repeats contribute only partial independence.
 */
function calculateIndependenceProfile(reports: CorroboratingReport[]): IndependenceProfile {
  const seenDomains = new Set<string>();
  const seenOwnershipGroups = new Set<string>();
  let effectiveConfirmations = 0;
  let sameDomainReposts = 0;
  let sameOwnershipGroupReposts = 0;

  for (const report of reports) {
    const domain = getSourceDomain(report.source);
    const ownershipGroup = getOwnershipGroup(report.source) ?? domain;

    let contribution = 1.0;
    if (seenDomains.has(domain)) {
      contribution = 0.05;
      sameDomainReposts += 1;
    } else if (ownershipGroup && seenOwnershipGroups.has(ownershipGroup)) {
      contribution = 0.12;
      sameOwnershipGroupReposts += 1;
    }

    effectiveConfirmations += contribution;
    seenDomains.add(domain);
    if (ownershipGroup) {
      seenOwnershipGroups.add(ownershipGroup);
    }
  }

  const independenceScore = computeIndependenceScore(reports.map((report) => report.source));

  return {
    effectiveConfirmations,
    independenceScore,
    uniqueDomains: seenDomains.size,
    uniqueOwnershipGroups: seenOwnershipGroups.size,
    sameDomainReposts,
    sameOwnershipGroupReposts,
  };
}

/**
 * Calculate independent confirmation score.
 * Diminishing returns: 1st source = 1.0, 2nd = 0.8, 3rd = 0.6, etc.
 */
function calculateIndependentConfirmationBonus(
  effectiveIndependentCount: number,
  independenceScore: number,
  tier1Count: number
): number {
  if (effectiveIndependentCount <= 0) return 0;

  const countCurve = 1 - Math.exp(-effectiveIndependentCount / 1.8);
  let score = countCurve * 0.7 + independenceScore * 0.3;

  // Bonus for multiple Tier 1 sources
  if (tier1Count >= 2) {
    score += 0.1 * Math.min(tier1Count - 1, 2); // Up to +0.2 for 3+ Tier 1
  }

  return Math.min(1.0, score);
}

/**
 * Calculate narrative agreement score.
 * If all narratives are aligned (same direction), score is high.
 * If contradictory narratives exist, score is reduced.
 */
function calculateNarrativeAgreement(clusters: Map<string, NarrativeCluster>): number {
  if (clusters.size === 0) return 0.5;
  if (clusters.size === 1) return 0.95; // All aligned

  let contradictoryCount = 0;
  let totalConfirmations = 0;

  for (const cluster of clusters.values()) {
    const clusterSize = cluster.sources.length;
    totalConfirmations += clusterSize;

    if (cluster.isContradictory) {
      contradictoryCount += clusterSize;
    }
  }

  // Calculate agreement: (totalConfirmations - contradictoryCount) / totalConfirmations
  const agreementRatio = (totalConfirmations - contradictoryCount) / Math.max(1, totalConfirmations);

  // If we have both main and contradictory clusters, reduce agreement
  const hasConflict = clusters.size > 1 && contradictoryCount > 0;
  const conflictPenalty = hasConflict ? 0.2 : 0;

  return Math.max(0, agreementRatio - conflictPenalty);
}

/**
 * Calculate weighted corroboration score using:
 * 1. Number of independent sources (diminishing returns)
 * 2. Source credibility weighting
 * 3. Narrative agreement
 * 4. Time-decay adjustment
 */
function calculateCorroborationScore(
  reports: CorroboratingReport[],
  clusters: Map<string, NarrativeCluster>,
  independenceProfile: IndependenceProfile,
  config: CorroborationConfig
): number {
  if (reports.length === 0) return 0;

  // Count Tier 1 sources and weighted credibility across non-contradictory clusters.
  let tier1Count = 0;
  let weightedCredibilitySum = 0;
  let totalWeight = 0;

  for (const cluster of clusters.values()) {
    if (!cluster.isContradictory) {
      for (const src of cluster.sources) {
        const tierWeight = getTierWeight(src.tier, config);
        weightedCredibilitySum += src.credibilityScore * tierWeight;
        totalWeight += tierWeight;

        if (src.tier === 1) {
          tier1Count++;
        }
      }
    }
  }

  if (totalWeight === 0) return 0;

  // Weighted average credibility of confirming sources, reduced by low source independence.
  const avgWeightedCredibility = weightedCredibilitySum / totalWeight;
  const independenceMultiplier = 0.55 + independenceProfile.independenceScore * 0.45;
  const adjustedCredibility = avgWeightedCredibility * independenceMultiplier;

  // Independence bonus accounts for same-domain and same-ownership decay.
  const independentBonus = calculateIndependentConfirmationBonus(
    independenceProfile.effectiveConfirmations,
    independenceProfile.independenceScore,
    tier1Count
  );

  // Narrative agreement component
  const narrativeAgreement = calculateNarrativeAgreement(clusters);

  // Combine components
  const baseScore = adjustedCredibility * 0.5 + independentBonus * 0.3 + narrativeAgreement * 0.2;

  return Math.min(1.0, baseScore);
}

/**
 * Calculate confidence adjustment multiplier.
 * Range [0.5, 1.5]:
 * - 0.5: Major contradictions, single weak source
 * - 1.0: Neutral (baseline)
 * - 1.5: Multiple strong independent Tier 1 sources, high agreement
 */
function calculateConfidenceAdjustment(
  corroborationScore: number,
  effectiveIndependentCount: number,
  independenceScore: number,
  conflictingCount: number,
  narrativeAgreement: number,
  tier1Count: number
): number {
  let adjustment = 1.0;

  // Corroboration score drives adjustment
  adjustment += corroborationScore * 0.4; // Up to +0.4

  // Independent sources drive adjustment, but ownership-group duplicates count less.
  adjustment += Math.min(0.2, effectiveIndependentCount * 0.05); // Up to +0.2 for 4+ effective sources
  adjustment += (independenceScore - 0.5) * 0.15;

  // Tier 1 sources boost adjustment
  adjustment += Math.min(0.15, tier1Count * 0.05); // Up to +0.15 for 3+ Tier 1

  // Narrative agreement drives adjustment
  adjustment += (narrativeAgreement - 0.5) * 0.2; // -0.1 to +0.1

  // Conflicting narratives reduce adjustment
  adjustment -= Math.min(0.25, conflictingCount * 0.15); // Up to -0.25

  return Math.max(0.5, Math.min(1.5, adjustment));
}

/**
 * Compute corroboration score for a set of reports.
 * Uses production default config if none provided.
 */
export function computeCorroborationScore(
  reports: CorroboratingReport[],
  config?: Partial<CorroborationConfig>
): CorroborationOutput {
  const mergedConfig: CorroborationConfig = { ...defaultConfig, ...config };

  if (reports.length === 0) {
    return {
      corroborationScore: 0,
      independentConfirmations: 0,
      conflictingNarratives: 0,
      narrativeAgreementScore: 0,
      confidenceAdjustment: 0.5,
    };
  }

  // Cluster narratives
  const clusters = clusterNarratives(reports, mergedConfig);

  // Measure source independence using ownership-group and domain normalization.
  const independenceProfile = calculateIndependenceProfile(reports);

  // Calculate main metrics
  const corroborationScore = calculateCorroborationScore(
    reports,
    clusters,
    independenceProfile,
    mergedConfig
  );
  const narrativeAgreement = calculateNarrativeAgreement(clusters);

  // Count Tier 1 sources and conflicting narratives.
  let tier1Count = 0;
  let conflictingNarratives = 0;
  for (const cluster of clusters.values()) {
    if (cluster.isContradictory) {
      conflictingNarratives += cluster.sources.length;
    } else {
      for (const src of cluster.sources) {
        if (src.tier === 1) {
          tier1Count++;
        }
      }
    }
  }

  // Calculate confidence adjustment
  const confidenceAdjustment = calculateConfidenceAdjustment(
    corroborationScore,
    independenceProfile.effectiveConfirmations,
    independenceProfile.independenceScore,
    conflictingNarratives,
    narrativeAgreement,
    tier1Count
  );

  return {
    corroborationScore,
    independentConfirmations: Number(independenceProfile.effectiveConfirmations.toFixed(2)),
    conflictingNarratives,
    narrativeAgreementScore: narrativeAgreement,
    confidenceAdjustment,
  };
}

/**
 * Helper: Get default configuration.
 */
export function getDefaultCorroborationConfig(): CorroborationConfig {
  return { ...defaultConfig };
}

/**
 * Helper: Analyze corroboration with detailed breakdown.
 * Useful for debugging and understanding why corroboration was high/low.
 */
export interface DetailedCorroborationAnalysis extends CorroborationOutput {
  narrativeClusters: Array<{
    clusterId: string;
    sourceCount: number;
    avgSimilarity: number;
    isContradictory: boolean;
    sources: string[];
  }>;
  processingNotes: string[];
}

export function analyzeCorroborationDetailed(
  reports: CorroboratingReport[],
  config?: Partial<CorroborationConfig>
): DetailedCorroborationAnalysis {
  const mergedConfig: CorroborationConfig = { ...defaultConfig, ...config };
  const baseOutput = computeCorroborationScore(reports, config);

  const clusters = clusterNarratives(reports, mergedConfig);

  const narrativeClusters = Array.from(clusters.values()).map((cluster) => ({
    clusterId: cluster.narrativeId,
    sourceCount: cluster.sources.length,
    avgSimilarity: cluster.avgSimilarity,
    isContradictory: cluster.isContradictory,
    sources: cluster.sources.map((s) => s.source),
  }));

  const processingNotes: string[] = [];
  if (reports.length === 1) {
    processingNotes.push("Single report: limited corroboration value");
  }
  if (reports.length >= 3) {
    processingNotes.push("Multiple independent sources increase confidence significantly");
  }
  if (baseOutput.conflictingNarratives > 0) {
    processingNotes.push(
      `${baseOutput.conflictingNarratives} conflicting narratives detected; agreement is partial`
    );
  }

  return {
    ...baseOutput,
    narrativeClusters,
    processingNotes,
  };
}

/**
 * Helper: Get tier statistics for reports.
 */
export function getTierDistribution(reports: CorroboratingReport[]): Record<string, number> {
  const distribution: Record<string, number> = {
    "Tier 1 Institutional": 0,
    "Tier 2 Professional": 0,
    "Tier 3 Specialized": 0,
    "Tier 4 Retail": 0,
    "Tier 5 Unknown": 0,
  };

  for (const report of reports) {
    const credibility = getSourceCredibility(report.source);
    distribution[credibility.tier]++;
  }

  return distribution;
}
