/**
 * Change Detection Engine
 *
 * Detects emerging and accelerating narratives in financial intelligence streams.
 * Uses deterministic time-series analysis to identify spikes, acceleration,
 * volatility changes, and macro regime transitions.
 *
 * Philosophy:
 * - Emerging: New or previously rare events increasing from low baseline
 * - Accelerating: Events increasing faster than recent history
 * - Stable: Events maintaining consistent frequency
 * - Declining: Events decreasing over time
 * - All scoring is deterministic, based on statistical measures (not ML)
 */

/**
 * Time-series data point for event frequency.
 */
export interface EventFrequencyDataPoint {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Event count in this period */
  count: number;
  /** Optional: entity or sector label for tracking */
  label?: string;
}

/**
 * Input for change detection analysis.
 */
export interface ChangeDetectionInput {
  /** Historical event frequency data points */
  historyData: EventFrequencyDataPoint[];
  /** Current period event frequency */
  currentCount: number;
  /** Optional: entity name for tracking (e.g., "NVDA", "Semiconductor") */
  entity?: string;
  /** Optional: sector name (e.g., "Technology") */
  sector?: string;
  /** Optional: macro regime context (e.g., "Risk-off", "Inflation") */
  macroContext?: string;
}

/**
 * Output structure for change detection.
 */
export interface ChangeDetectionOutput {
  /** Classification: Emerging | Accelerating | Stable | Declining */
  trend: "Emerging" | "Accelerating" | "Stable" | "Declining";
  /** Momentum score [0, 1]: strength of directional change */
  momentumScore: number;
  /** Volatility score [0, 1]: dispersion in recent event frequency */
  volatilityScore: number;
  /** Narrative strength [0, 1]: consistency and frequency of events */
  narrativeStrength: number;
  /** Detailed reasoning for classification */
  explanation: string[];
}

/**
 * Configuration for change detection scoring.
 */
export interface ChangeDetectionConfig {
  /** Window size for rolling calculations (in data points) */
  rollingWindowSize: number;
  /** Z-score threshold for spike detection */
  spikeThreshold: number;
  /** Momentum threshold for "Accelerating" classification */
  accelerationThreshold: number;
  /** Minimum event count to consider narrative established */
  minNarrativeThreshold: number;
  /** Volatility threshold for "high volatility" classification */
  highVolatilityThreshold: number;
}

const defaultConfig: ChangeDetectionConfig = {
  rollingWindowSize: 10,
  spikeThreshold: 2.0, // 2 standard deviations
  accelerationThreshold: 1.5, // 50% acceleration
  minNarrativeThreshold: 3,
  highVolatilityThreshold: 0.6,
};

/**
 * Calculate simple statistics for a data array.
 */
function calculateStats(data: number[]): {
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  median: number;
} {
  if (data.length === 0) {
    return { mean: 0, stdDev: 0, min: 0, max: 0, median: 0 };
  }

  const mean = data.reduce((a, b) => a + b, 0) / data.length;
  const variance = data.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / Math.max(1, data.length - 1);
  const stdDev = Math.sqrt(variance);

  const sorted = [...data].sort((a, b) => a - b);
  const median = data.length % 2 === 0 
    ? (sorted[data.length / 2 - 1] + sorted[data.length / 2]) / 2 
    : sorted[Math.floor(data.length / 2)];

  return {
    mean,
    stdDev,
    min: Math.min(...data),
    max: Math.max(...data),
    median,
  };
}

/**
 * Detect spike: sudden increase above baseline.
 * Uses Z-score: (value - mean) / stdDev
 */
function detectSpike(
  currentValue: number,
  historicalValues: number[],
  threshold: number
): { isSpike: boolean; zScore: number } {
  if (historicalValues.length === 0) {
    return { isSpike: currentValue > 0, zScore: currentValue > 0 ? 1.0 : 0 };
  }

  const stats = calculateStats(historicalValues);
  if (stats.stdDev === 0) {
    // No variation in history; any increase is a spike
    return {
      isSpike: currentValue > stats.mean,
      zScore: currentValue > stats.mean ? 1.0 : 0,
    };
  }

  const zScore = (currentValue - stats.mean) / stats.stdDev;
  return {
    isSpike: zScore > threshold,
    zScore: Math.max(0, zScore), // Clamp to [0, ∞)
  };
}

/**
 * Detect acceleration: increasing rate of change.
 * Compares recent period growth to older period growth.
 */
function detectAcceleration(
  data: number[],
  threshold: number
): { isAccelerating: boolean; accelerationRatio: number } {
  if (data.length < 4) {
    return { isAccelerating: false, accelerationRatio: 0 };
  }

  const midpoint = Math.floor(data.length / 2);

  // Older period: average change rate
  const olderPeriod = data.slice(0, midpoint);
  const olderChanges = [];
  for (let i = 1; i < olderPeriod.length; i++) {
    olderChanges.push(olderPeriod[i] - olderPeriod[i - 1]);
  }
  const olderAvgChange =
    olderChanges.length > 0 ? olderChanges.reduce((a, b) => a + b, 0) / olderChanges.length : 0;

  // Recent period: average change rate
  const recentPeriod = data.slice(midpoint);
  const recentChanges = [];
  for (let i = 1; i < recentPeriod.length; i++) {
    recentChanges.push(recentPeriod[i] - recentPeriod[i - 1]);
  }
  const recentAvgChange =
    recentChanges.length > 0 ? recentChanges.reduce((a, b) => a + b, 0) / recentChanges.length : 0;

  // Avoid division by zero
  const baselineChange = Math.max(Math.abs(olderAvgChange), 0.1);
  const accelerationRatio = recentAvgChange / baselineChange;

  return {
    isAccelerating: accelerationRatio > threshold,
    accelerationRatio: Math.max(0, accelerationRatio),
  };
}

/**
 * Calculate volatility: coefficient of variation.
 * stdDev / mean (normalized measure of dispersion)
 */
function calculateVolatility(data: number[]): number {
  if (data.length < 2) return 0;

  const stats = calculateStats(data);
  if (stats.mean === 0) return 0;

  const cv = stats.stdDev / stats.mean;
  return Math.min(1.0, cv); // Clamp to [0, 1]
}

/**
 * Calculate narrative strength: consistency and frequency.
 * Based on: how many periods had events, stability of frequency, absolute level
 */
function calculateNarrativeStrength(
  data: number[],
  currentValue: number,
  minThreshold: number
): number {
  if (data.length === 0) return 0;

  // Component 1: Frequency (% of periods with events)
  const periodsWithEvents = data.filter((count) => count > 0).length;
  const frequencyRatio = periodsWithEvents / data.length;

  // Component 2: Consistency (inverse of coefficient of variation)
  const volatility = calculateVolatility(data);
  const consistency = Math.max(0, 1.0 - volatility);

  // Component 3: Absolute level (current vs minimum threshold)
  const stats = calculateStats(data);
  const levelScore = Math.min(1.0, (currentValue + stats.mean) / (2 * Math.max(minThreshold, 1)));

  // Weighted combination
  const strength = frequencyRatio * 0.4 + consistency * 0.35 + levelScore * 0.25;
  return Math.min(1.0, strength);
}

/**
 * Calculate momentum score: rate of change strength.
 * Combines spike magnitude and acceleration.
 */
function calculateMomentum(
  currentValue: number,
  historicalValues: number[],
  spikeZScore: number,
  accelerationRatio: number
): number {
  if (historicalValues.length === 0) return currentValue > 0 ? 0.5 : 0;

  const stats = calculateStats(historicalValues);

  // Normalize spike Z-score to [0, 1]
  const normalizedSpike = Math.min(1.0, spikeZScore / 3.0); // 3 sigma = 1.0

  // Normalize acceleration ratio to [0, 1]
  const normalizedAccel = Math.min(1.0, accelerationRatio / 3.0); // 3x = 1.0

  // Baseline change from mean
  const baselineChange = Math.max(stats.mean, 1);
  const changeFromMean = (currentValue - stats.mean) / Math.max(baselineChange, 1);
  const normalizedChange = Math.min(1.0, Math.max(0, changeFromMean));

  return normalizedSpike * 0.4 + normalizedAccel * 0.35 + normalizedChange * 0.25;
}

/**
 * Classify trend based on multiple signals.
 */
function classifyTrend(
  isSpike: boolean,
  isAccelerating: boolean,
  zScore: number,
  accelerationRatio: number,
  currentValue: number,
  historicalMean: number,
  volatilityScore: number
): "Emerging" | "Accelerating" | "Stable" | "Declining" {
  // Declining: below historical mean with negative acceleration
  if (currentValue < historicalMean && accelerationRatio < 0.8) {
    return "Declining";
  }

  // Accelerating: strong positive acceleration with growth
  if (isAccelerating && accelerationRatio > 1.5 && currentValue >= historicalMean) {
    return "Accelerating";
  }

  // Emerging: spike but not accelerating (new event type)
  if (isSpike && !isAccelerating && zScore > 1.5) {
    return "Emerging";
  }

  // Stable: normal variation around mean
  if (Math.abs(currentValue - historicalMean) < historicalMean * 0.5 && !isSpike) {
    return "Stable";
  }

  // Default to Emerging if conditions are ambiguous but event is above mean
  if (currentValue > historicalMean) {
    return "Emerging";
  }

  return "Stable";
}

/**
 * Detect macro regime transitions: large sustained changes.
 */
function detectMacroTransition(
  data: number[],
  currentValue: number
): { isTransition: boolean; transitionType: string } {
  if (data.length < 6) return { isTransition: false, transitionType: "" };

  const olderData = data.slice(0, Math.floor(data.length / 2));
  const recentData = data.slice(Math.floor(data.length / 2));

  const olderMean = olderData.reduce((a, b) => a + b, 0) / olderData.length;
  const recentMean = recentData.reduce((a, b) => a + b, 0) / recentData.length;

  // Check if there's a persistent level shift
  if (olderMean > 0 && recentMean / olderMean > 2) {
    return { isTransition: true, transitionType: "Elevated Baseline" };
  }

  if (olderMean > 0 && recentMean / olderMean < 0.5) {
    return { isTransition: true, transitionType: "Reduced Baseline" };
  }

  // Check volatility shift
  const olderVolatility = calculateVolatility(olderData);
  const recentVolatility = calculateVolatility(recentData);

  if (recentVolatility > olderVolatility * 2) {
    return { isTransition: true, transitionType: "Increased Volatility Regime" };
  }

  if (recentVolatility < olderVolatility * 0.5) {
    return { isTransition: true, transitionType: "Decreased Volatility Regime" };
  }

  return { isTransition: false, transitionType: "" };
}

/**
 * Main function: compute change detection for event stream.
 */
export function computeChangeDetection(
  input: ChangeDetectionInput,
  config?: Partial<ChangeDetectionConfig>
): ChangeDetectionOutput {
  const mergedConfig: ChangeDetectionConfig = { ...defaultConfig, ...config };

  // Extract historical counts
  const historicalCounts = input.historyData.map((d) => d.count);

  // Apply rolling window
  let windowData = historicalCounts;
  if (historicalCounts.length > mergedConfig.rollingWindowSize) {
    windowData = historicalCounts.slice(-mergedConfig.rollingWindowSize);
  }

  // Calculate statistics
  const historicalStats = calculateStats(windowData);

  // Detect spike
  const { isSpike, zScore } = detectSpike(
    input.currentCount,
    windowData,
    mergedConfig.spikeThreshold
  );

  // Detect acceleration
  const { isAccelerating, accelerationRatio } = detectAcceleration(
    windowData,
    mergedConfig.accelerationThreshold
  );

  // Calculate volatility
  const volatilityScore = calculateVolatility(windowData);

  // Calculate narrative strength
  const narrativeStrength = calculateNarrativeStrength(
    windowData,
    input.currentCount,
    mergedConfig.minNarrativeThreshold
  );

  // Calculate momentum
  const momentumScore = calculateMomentum(
    input.currentCount,
    windowData,
    zScore,
    accelerationRatio
  );

  // Classify trend
  const trend = classifyTrend(
    isSpike,
    isAccelerating,
    zScore,
    accelerationRatio,
    input.currentCount,
    historicalStats.mean,
    volatilityScore
  );

  // Detect macro transitions
  const { isTransition, transitionType } = detectMacroTransition(
    historicalCounts,
    input.currentCount
  );

  // Build explanation
  const explanation: string[] = [];

  explanation.push(`Trend classification: ${trend}`);

  if (isSpike) {
    explanation.push(
      `Spike detected: ${input.currentCount} events vs. historical mean of ${historicalStats.mean.toFixed(1)} (Z-score: ${zScore.toFixed(2)})`
    );
  }

  if (isAccelerating) {
    explanation.push(
      `Acceleration detected: Recent change rate is ${accelerationRatio.toFixed(2)}x historical rate`
    );
  }

  if (volatilityScore > mergedConfig.highVolatilityThreshold) {
    explanation.push(
      `High volatility: Coefficient of variation is ${(volatilityScore * 100).toFixed(1)}%`
    );
  }

  if (narrativeStrength >= 0.7) {
    explanation.push(
      `Strong narrative: Events appearing consistently; narrative strength ${(narrativeStrength * 100).toFixed(1)}%`
    );
  } else if (narrativeStrength < 0.3) {
    explanation.push(
      `Weak narrative: Inconsistent event frequency; narrative strength ${(narrativeStrength * 100).toFixed(1)}%`
    );
  }

  if (input.entity) {
    explanation.push(`Entity tracking: ${input.entity}`);
  }

  if (input.sector) {
    explanation.push(`Sector context: ${input.sector}`);
  }

  if (isTransition) {
    explanation.push(`Macro regime shift detected: ${transitionType}`);
  }

  if (input.macroContext) {
    explanation.push(`Macro context: ${input.macroContext}`);
  }

  // Historical context
  if (historicalStats.mean > 0) {
    const changePercent = ((input.currentCount - historicalStats.mean) / historicalStats.mean) * 100;
    explanation.push(`Change from historical mean: ${changePercent.toFixed(1)}%`);
  }

  return {
    trend,
    momentumScore,
    volatilityScore,
    narrativeStrength,
    explanation,
  };
}

/**
 * Helper: Track change detection across multiple entities.
 */
export interface EntityChangeTracker {
  entity: string;
  sector?: string;
  latest: ChangeDetectionOutput;
  trendSequence: Array<"Emerging" | "Accelerating" | "Stable" | "Declining">;
}

/**
 * Helper: Analyze multiple entity streams.
 */
export function trackMultipleEntities(
  entityInputs: Array<ChangeDetectionInput>,
  config?: Partial<ChangeDetectionConfig>
): EntityChangeTracker[] {
  const trackers: EntityChangeTracker[] = [];

  for (const input of entityInputs) {
    const changeDetection = computeChangeDetection(input, config);
    const label = input.entity || input.sector || "Unknown";

    trackers.push({
      entity: label,
      sector: input.sector,
      latest: changeDetection,
      trendSequence: [changeDetection.trend],
    });
  }

  return trackers;
}

/**
 * Helper: Get trend momentum strength [0, 1].
 * High momentum = strong directional confidence.
 */
export function getTrendMomentumStrength(output: ChangeDetectionOutput): number {
  // Emerging and Accelerating have inherently higher momentum
  let baseScore = 0;
  if (output.trend === "Accelerating") {
    baseScore = 0.85;
  } else if (output.trend === "Emerging") {
    baseScore = 0.7;
  } else if (output.trend === "Declining") {
    baseScore = 0.6;
  } else {
    baseScore = 0.3;
  }

  // Weight by actual momentum and narrative strength
  return baseScore * 0.6 + output.momentumScore * 0.4;
}

/**
 * Helper: Compare two change detection outputs for relative strength.
 */
export function compareTrends(
  trend1: ChangeDetectionOutput,
  trend2: ChangeDetectionOutput
): { stronger: number; score: number; reason: string } {
  let trend1Score = 0;
  let trend2Score = 0;

  // Trend strength
  const trendRanks: Record<string, number> = {
    Accelerating: 4,
    Emerging: 3,
    Stable: 2,
    Declining: 1,
  };

  trend1Score += trendRanks[trend1.trend] * 0.3;
  trend2Score += trendRanks[trend2.trend] * 0.3;

  // Momentum
  trend1Score += trend1.momentumScore * 0.4;
  trend2Score += trend2.momentumScore * 0.4;

  // Narrative strength
  trend1Score += trend1.narrativeStrength * 0.3;
  trend2Score += trend2.narrativeStrength * 0.3;

  const difference = trend1Score - trend2Score;
  let reason = "";

  if (Math.abs(difference) < 0.1) {
    reason = "Trends are comparable in strength";
  } else if (trend1Score > trend2Score) {
    reason = `Trend 1 is ${(Math.abs(difference) * 100).toFixed(1)}% stronger`;
  } else {
    reason = `Trend 2 is ${(Math.abs(difference) * 100).toFixed(1)}% stronger`;
  }

  return {
    stronger: trend1Score > trend2Score ? 1 : trend2Score > trend1Score ? 2 : 0,
    score: Math.abs(difference),
    reason,
  };
}

/**
 * Helper: Get default configuration.
 */
export function getDefaultChangeDetectionConfig(): ChangeDetectionConfig {
  return { ...defaultConfig };
}
