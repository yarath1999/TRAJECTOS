/**
 * Narrative Intelligence Engine
 *
 * Tracks evolving macro and thematic narratives across event clusters.
 * Supports narrative persistence, evolution, merging, and decay to provide
 * institutional-grade narrative analysis for portfolio decisions.
 *
 * Philosophy:
 * - Narratives emerge from clusters of related events
 * - Narratives strengthen with supporting evidence and weaken without it
 * - Related narratives can merge to consolidate themes
 * - Narratives decay when unsupported by new events
 * - Narratives have direction: Bullish (positive), Bearish (negative), Neutral
 */

/**
 * Input event cluster from clustering engine.
 */
export interface EventCluster {
  /** Cluster ID */
  cluster_id: string;
  /** Cluster label or theme */
  label: string;
  /** Number of events in cluster */
  event_count: number;
  /** Average sentiment of events ([-1, 1]) */
  sentiment: number;
  /** Event type keywords in cluster */
  event_types: string[];
  /** Affected entities */
  entities: string[];
  /** Affected sectors */
  sectors: string[];
  /** Timestamp of cluster creation */
  created_at: string;
  /** Timestamp of most recent event in cluster */
  last_event_at: string;
}

/**
 * Output structure for narrative intelligence.
 */
export interface NarrativeIntelligence {
  /** Unique narrative identifier (e.g., "NARRATIVE_AI_CAPEX_001") */
  narrative_id: string;
  /** Human-readable narrative name (e.g., "AI CapEx Boom") */
  narrative_name: string;
  /** Narrative strength [0, 1] */
  strength: number;
  /** Narrative direction: Bullish (positive), Bearish (negative), Neutral */
  direction: "Bullish" | "Bearish" | "Neutral";
  /** Acceleration of narrative strength [-1, 1] */
  acceleration: number;
  /** Supporting cluster IDs */
  supporting_clusters: string[];
  /** Affected asset tickers */
  affected_assets: string[];
  /** Narrative description */
  description: string;
  /** Narrative age in days */
  age_days: number;
  /** Timestamp narrative was created */
  created_at: string;
  /** Timestamp narrative was last updated */
  updated_at: string;
}

/**
 * Configuration for narrative intelligence engine.
 */
export interface NarrativeIntelligenceConfig {
  /** Minimum similarity [0, 1] to merge narratives */
  mergeSimilarityThreshold: number;
  /** Maximum age in days before decay begins */
  maxNarrativeAgeDays: number;
  /** Decay rate per day without supporting events [0, 1] */
  dailyDecayRate: number;
  /** Minimum strength [0, 1] to keep narrative alive */
  minStrengthThreshold: number;
  /** Minimum clusters to form a new narrative */
  minClusterThreshold: number;
  /** Maximum narratives to track */
  maxNarratives: number;
}

const defaultConfig: NarrativeIntelligenceConfig = {
  mergeSimilarityThreshold: 0.75,
  maxNarrativeAgeDays: 60,
  dailyDecayRate: 0.05,
  minStrengthThreshold: 0.15,
  minClusterThreshold: 2,
  maxNarratives: 50,
};

/**
 * Internal narrative tracking state.
 */
interface NarrativeState {
  narrative_id: string;
  narrative_name: string;
  description: string;
  keywords: string[];
  direction: "Bullish" | "Bearish" | "Neutral";
  strength: number;
  supporting_clusters: Set<string>;
  affected_sectors: Set<string>;
  affected_entities: Set<string>;
  related_assets: Set<string>;
  created_at: Date;
  updated_at: Date;
  last_cluster_update: Date;
  strengthHistory: number[];
}

/**
 * Known narrative patterns: keywords/themes that identify macroeconomic narratives.
 */
const narrativePatterns: Array<{
  pattern_id: string;
  pattern_name: string;
  keywords: string[];
  direction: "Bullish" | "Bearish" | "Neutral";
  description: string;
  sectors: string[];
  assets: string[];
}> = [
  {
    pattern_id: "AI_CAPEX_BOOM",
    pattern_name: "AI CapEx Boom",
    keywords: ["ai", "artificial intelligence", "gpu", "nvidia", "data center", "capex", "infrastructure", "training"],
    direction: "Bullish",
    description: "Massive capital expenditures in AI infrastructure and chip production",
    sectors: ["Technology", "Semiconductors"],
    assets: ["NVDA", "AMD", "INTC", "ASML", "AMAT", "TSM", "QCOM"],
  },
  {
    pattern_id: "CHINA_SEMI_RESTRICTIONS",
    pattern_name: "China Semiconductor Restrictions",
    keywords: ["china", "semiconductor", "export", "restrict", "ban", "taiwan", "tsmc", "advanced chip"],
    direction: "Bearish",
    description: "Geopolitical tensions leading to semiconductor export restrictions affecting China",
    sectors: ["Semiconductors", "Technology"],
    assets: ["TSM", "ASML", "SMH", "SOXX", "NVDA", "AMD"],
  },
  {
    pattern_id: "ENERGY_SUPPLY_STRESS",
    pattern_name: "Energy Supply Stress",
    keywords: ["energy", "oil", "natural gas", "supply", "shortage", "crisis", "opec", "production"],
    direction: "Bearish",
    description: "Energy supply disruptions driving price spikes and economic concerns",
    sectors: ["Energy", "Utilities"],
    assets: ["XLE", "XOM", "CVX", "COP", "EQNR", "CL=F", "NG=F"],
  },
  {
    pattern_id: "CRE_WEAKNESS",
    pattern_name: "Commercial Real Estate Weakness",
    keywords: ["commercial real estate", "cre", "office", "vacancy", "default", "reit", "mortgage", "stress"],
    direction: "Bearish",
    description: "Commercial real estate market deterioration impacting real estate and banking sectors",
    sectors: ["Real Estate", "Financials"],
    assets: ["XLRE", "VNQ", "JPM", "BAC", "GS", "XLF"],
  },
  {
    pattern_id: "INFLATION_PERSISTENCE",
    pattern_name: "Inflation Persistence",
    keywords: ["inflation", "prices", "cpi", "wage", "monetary policy", "rate hike", "fed"],
    direction: "Bearish",
    description: "Persistent inflation driving central bank tightening and economic concerns",
    sectors: ["Financials", "Utilities"],
    assets: ["TLT", "BND", "XLF", "JPM", "BAC", "USD"],
  },
  {
    pattern_id: "TECH_EARNINGS_BEAT",
    pattern_name: "Tech Earnings Beat",
    keywords: ["earnings", "beat", "revenue", "guidance", "technology", "profit", "margin"],
    direction: "Bullish",
    description: "Technology sector delivering strong earnings growth and positive guidance",
    sectors: ["Technology"],
    assets: ["QQQ", "XLK", "NVDA", "MSFT", "AAPL", "GOOGL"],
  },
  {
    pattern_id: "MONETARY_TIGHTENING",
    pattern_name: "Monetary Tightening Cycle",
    keywords: ["rate hike", "tightening", "fed", "ecb", "monetary policy", "hawkish", "inflation fight"],
    direction: "Bearish",
    description: "Central banks raising interest rates to combat inflation",
    sectors: ["Financials"],
    assets: ["TLT", "IEF", "XLF", "JPM", "BAC"],
  },
  {
    pattern_id: "CONSUMER_RESILIENCE",
    pattern_name: "Consumer Resilience",
    keywords: ["consumer", "spending", "sales", "retail", "employment", "wage", "strong"],
    direction: "Bullish",
    description: "Consumers maintaining spending despite economic headwinds",
    sectors: ["Consumer"],
    assets: ["XLY", "VCR", "COST", "NKE", "LULU"],
  },
  {
    pattern_id: "SUPPLY_CHAIN_NORMALIZATION",
    pattern_name: "Supply Chain Normalization",
    keywords: ["supply chain", "normalization", "shipping", "freight", "inventory", "production"],
    direction: "Bullish",
    description: "Global supply chains recovering from disruptions",
    sectors: ["Industrials"],
    assets: ["XLI", "VIS", "CAT", "DE"],
  },
  {
    pattern_id: "GEOPOLITICAL_RISK",
    pattern_name: "Geopolitical Risk Premium",
    keywords: ["geopolitical", "conflict", "war", "tension", "escalation", "missile", "sanctions"],
    direction: "Bearish",
    description: "Geopolitical tensions driving risk-off sentiment and safety bids",
    sectors: ["Defense", "Energy"],
    assets: ["LMT", "RTX", "XLE", "XOM", "GLD"],
  },
];

/**
 * Detect matching narratives from event cluster.
 */
function detectNarrativesFromCluster(cluster: EventCluster): Array<{
  pattern_id: string;
  pattern_name: string;
  match_score: number;
}> {
  const clusterText = `${cluster.label} ${cluster.event_types.join(" ")} ${cluster.entities.join(" ")} ${cluster.sectors.join(" ")}`.toLowerCase();

  const matches: Array<{ pattern_id: string; pattern_name: string; match_score: number }> = [];

  for (const pattern of narrativePatterns) {
    // Count keyword hits
    let hits = 0;
    for (const keyword of pattern.keywords) {
      if (clusterText.includes(keyword)) {
        hits++;
      }
    }

    if (hits > 0) {
      const matchScore = Math.min(1.0, hits / pattern.keywords.length);
      matches.push({
        pattern_id: pattern.pattern_id,
        pattern_name: pattern.pattern_name,
        match_score: matchScore,
      });
    }
  }

  return matches.sort((a, b) => b.match_score - a.match_score);
}

/**
 * Calculate narrative strength from supporting clusters.
 */
function calculateNarrativeStrength(
  clusters: EventCluster[],
  matchScores: number[]
): number {
  if (clusters.length === 0) return 0;

  // Component 1: Match quality
  const avgMatchScore = matchScores.reduce((a, b) => a + b, 0) / matchScores.length;

  // Component 2: Event density (events per cluster)
  const avgEventCount = clusters.reduce((a, b) => a + b.event_count, 0) / clusters.length;
  const eventDensityScore = Math.min(1.0, avgEventCount / 20); // 20 events = max

  // Component 3: Sentiment agreement
  const avgSentiment = clusters.reduce((a, b) => a + b.sentiment, 0) / clusters.length;
  const sentimentScore = Math.abs(avgSentiment);

  // Component 4: Recency (how recent are events)
  const now = new Date();
  const avgAge =
    clusters.reduce((sum, c) => {
      const age = (now.getTime() - new Date(c.last_event_at).getTime()) / (1000 * 60 * 60 * 24);
      return sum + age;
    }, 0) / clusters.length;
  const recencyScore = Math.max(0, 1.0 - Math.min(1.0, avgAge / 30)); // 30 days = fade

  // Weighted combination
  const strength = avgMatchScore * 0.35 + eventDensityScore * 0.25 + sentimentScore * 0.2 + recencyScore * 0.2;

  return Math.min(1.0, strength);
}

/**
 * Calculate narrative direction from supporting clusters.
 */
function calculateNarrativeDirection(
  clusters: EventCluster[],
  patternDirection: "Bullish" | "Bearish" | "Neutral"
): "Bullish" | "Bearish" | "Neutral" {
  if (clusters.length === 0) return patternDirection;

  const avgSentiment = clusters.reduce((a, b) => a + b.sentiment, 0) / clusters.length;

  // If pattern direction is set, weigh cluster sentiment to confirm/contradict
  if (Math.abs(avgSentiment) < 0.3) {
    return "Neutral";
  }

  if (avgSentiment > 0.3) {
    return "Bullish";
  }

  if (avgSentiment < -0.3) {
    return "Bearish";
  }

  return patternDirection;
}

/**
 * Calculate acceleration: change in strength trend.
 */
function calculateAcceleration(strengthHistory: number[]): number {
  if (strengthHistory.length < 2) return 0;

  const recent = strengthHistory.slice(-5); // Last 5 data points
  if (recent.length < 2) return 0;

  const recentChange = recent[recent.length - 1] - recent[0];
  const recentSpan = Math.max(1, recent.length - 1);
  const recentRate = recentChange / recentSpan;

  // Normalize: [-1, 1] where -1 is rapid decline, 1 is rapid growth
  return Math.max(-1, Math.min(1, recentRate * 2));
}

/**
 * Calculate similarity between two narratives [0, 1].
 */
function calculateNarrativeSimilarity(narrative1: NarrativeState, narrative2: NarrativeState): number {
  // Keyword overlap
  const keywords1 = new Set(narrative1.keywords);
  const keywords2 = new Set(narrative2.keywords);
  const intersection = new Set([...keywords1].filter((k) => keywords2.has(k)));
  const union = new Set([...keywords1, ...keywords2]);
  const keywordSimilarity = union.size > 0 ? intersection.size / union.size : 0;

  // Sector overlap
  const sectors1 = new Set(narrative1.affected_sectors);
  const sectors2 = new Set(narrative2.affected_sectors);
  const sectorIntersection = new Set([...sectors1].filter((s) => sectors2.has(s)));
  const sectorUnion = new Set([...sectors1, ...sectors2]);
  const sectorSimilarity = sectorUnion.size > 0 ? sectorIntersection.size / sectorUnion.size : 0;

  // Direction agreement
  const directionMatch = narrative1.direction === narrative2.direction ? 1.0 : 0.5;

  // Weighted combination
  return keywordSimilarity * 0.5 + sectorSimilarity * 0.3 + directionMatch * 0.2;
}

/**
 * Merge two similar narratives.
 */
function mergeNarratives(narrative1: NarrativeState, narrative2: NarrativeState): NarrativeState {
  // Keep older narrative ID, combine names
  const isPrimary = narrative1.created_at <= narrative2.created_at;
  const primary = isPrimary ? narrative1 : narrative2;
  const secondary = isPrimary ? narrative2 : narrative1;

  // Combine keywords
  const mergedKeywords = Array.from(new Set([...primary.keywords, ...secondary.keywords]));

  // Combine clusters and sectors
  const mergedClusters = new Set([...primary.supporting_clusters, ...secondary.supporting_clusters]);
  const mergedSectors = new Set([...primary.affected_sectors, ...secondary.affected_sectors]);
  const mergedEntities = new Set([...primary.affected_entities, ...secondary.affected_entities]);
  const mergedAssets = new Set([...primary.related_assets, ...secondary.related_assets]);

  // Average direction (if different, use primary)
  const direction = primary.direction;

  // Combined strength (average of both)
  const mergedStrength = (primary.strength + secondary.strength) / 2;

  return {
    narrative_id: primary.narrative_id,
    narrative_name: `${primary.narrative_name} & ${secondary.narrative_name}`,
    description: `Merged: ${primary.description}; ${secondary.description}`,
    keywords: mergedKeywords,
    direction,
    strength: mergedStrength,
    supporting_clusters: mergedClusters,
    affected_sectors: mergedSectors,
    affected_entities: mergedEntities,
    related_assets: mergedAssets,
    created_at: primary.created_at,
    updated_at: new Date(),
    last_cluster_update: new Date(),
    strengthHistory: primary.strengthHistory,
  };
}

/**
 * Apply decay to narrative strength when unsupported.
 */
function applyDecay(
  narrative: NarrativeState,
  currentTime: Date,
  config: NarrativeIntelligenceConfig
): NarrativeState {
  const daysSinceUpdate = (currentTime.getTime() - narrative.last_cluster_update.getTime()) / (1000 * 60 * 60 * 24);

  if (daysSinceUpdate > 0) {
    // Apply daily decay
    const decayFactor = Math.pow(1 - config.dailyDecayRate, daysSinceUpdate);
    narrative.strength = Math.max(config.minStrengthThreshold, narrative.strength * decayFactor);
  }

  return narrative;
}

/**
 * Track narratives across clusters.
 * In production, this would be backed by a persistent database.
 */
export class NarrativeRegistry {
  private narratives: Map<string, NarrativeState> = new Map();
  private config: NarrativeIntelligenceConfig;
  private narrativeCounter: number = 0;

  constructor(config?: Partial<NarrativeIntelligenceConfig>) {
    this.config = { ...defaultConfig, ...config };
  }

  /**
   * Update registry with new event clusters.
   */
  updateWithClusters(clusters: EventCluster[]): NarrativeIntelligence[] {
    const now = new Date();

    // Process each cluster
    for (const cluster of clusters) {
      const matches = detectNarrativesFromCluster(cluster);

      for (const match of matches) {
        const pattern = narrativePatterns.find((p) => p.pattern_id === match.pattern_id);
        if (!pattern) continue;

        // Find existing narrative or create new
        let existingNarrative: NarrativeState | null = null;
        for (const [, narrative] of this.narratives.entries()) {
          if (narrative.narrative_name === pattern.pattern_name) {
            existingNarrative = narrative;
            break;
          }
        }

        if (existingNarrative) {
          // Update existing narrative
          existingNarrative.supporting_clusters.add(cluster.cluster_id);
          existingNarrative.last_cluster_update = now;

          for (const entity of cluster.entities) {
            existingNarrative.affected_entities.add(entity);
          }
          for (const sector of cluster.sectors) {
            existingNarrative.affected_sectors.add(sector);
          }
          for (const asset of pattern.assets) {
            existingNarrative.related_assets.add(asset);
          }

          // Recalculate strength
          const supportingClusters = Array.from(existingNarrative.supporting_clusters)
            .map((id) => clusters.find((c) => c.cluster_id === id))
            .filter((c): c is EventCluster => c !== undefined);

          const matchScores = supportingClusters.map(() => match.match_score);
          existingNarrative.strength = calculateNarrativeStrength(supportingClusters, matchScores);
          existingNarrative.strengthHistory.push(existingNarrative.strength);

          if (existingNarrative.strengthHistory.length > 30) {
            existingNarrative.strengthHistory.shift(); // Keep last 30 data points
          }
        } else if (match.match_score >= 0.5) {
          // Create new narrative
          const narrativeId = `NARRATIVE_${pattern.pattern_id}_${++this.narrativeCounter}`;
          const newNarrative: NarrativeState = {
            narrative_id: narrativeId,
            narrative_name: pattern.pattern_name,
            description: pattern.description,
            keywords: pattern.keywords,
            direction: calculateNarrativeDirection([cluster], pattern.direction),
            strength: calculateNarrativeStrength([cluster], [match.match_score]),
            supporting_clusters: new Set([cluster.cluster_id]),
            affected_sectors: new Set(cluster.sectors),
            affected_entities: new Set(cluster.entities),
            related_assets: new Set(pattern.assets),
            created_at: now,
            updated_at: now,
            last_cluster_update: now,
            strengthHistory: [calculateNarrativeStrength([cluster], [match.match_score])],
          };

          this.narratives.set(narrativeId, newNarrative);
        }
      }
    }

    // Apply decay to unsupported narratives
    for (const [id, narrative] of this.narratives.entries()) {
      applyDecay(narrative, now, this.config);

      // Remove if too weak
      if (narrative.strength < this.config.minStrengthThreshold) {
        this.narratives.delete(id);
      }
    }

    // Merge similar narratives
    this.mergeNarrativesIfNeeded();

    // Convert to output format
    return this.toOutput();
  }

  /**
   * Merge narratives that are too similar.
   */
  private mergeNarrativesIfNeeded(): void {
    const narrativeArray = Array.from(this.narratives.values());

    for (let i = 0; i < narrativeArray.length; i++) {
      for (let j = i + 1; j < narrativeArray.length; j++) {
        const similarity = calculateNarrativeSimilarity(narrativeArray[i], narrativeArray[j]);

        if (similarity >= this.config.mergeSimilarityThreshold) {
          const merged = mergeNarratives(narrativeArray[i], narrativeArray[j]);
          this.narratives.set(merged.narrative_id, merged);
          this.narratives.delete(narrativeArray[j].narrative_id);
        }
      }
    }
  }

  /**
   * Limit narratives to maximum.
   */
  private limitNarratives(): void {
    if (this.narratives.size > this.config.maxNarratives) {
      const sorted = Array.from(this.narratives.values()).sort((a, b) => b.strength - a.strength);

      this.narratives.clear();
      for (let i = 0; i < this.config.maxNarratives; i++) {
        this.narratives.set(sorted[i].narrative_id, sorted[i]);
      }
    }
  }

  /**
   * Convert internal state to output format.
   */
  private toOutput(): NarrativeIntelligence[] {
    this.limitNarratives();

    const output: NarrativeIntelligence[] = [];
    const now = new Date();

    for (const [, narrative] of this.narratives.entries()) {
      const ageDays = (now.getTime() - narrative.created_at.getTime()) / (1000 * 60 * 60 * 24);

      output.push({
        narrative_id: narrative.narrative_id,
        narrative_name: narrative.narrative_name,
        strength: narrative.strength,
        direction: narrative.direction,
        acceleration: calculateAcceleration(narrative.strengthHistory),
        supporting_clusters: Array.from(narrative.supporting_clusters),
        affected_assets: Array.from(narrative.related_assets),
        description: narrative.description,
        age_days: Math.round(ageDays),
        created_at: narrative.created_at.toISOString(),
        updated_at: narrative.updated_at.toISOString(),
      });
    }

    return output.sort((a, b) => b.strength - a.strength);
  }

  /**
   * Get all active narratives.
   */
  getNarratives(): NarrativeIntelligence[] {
    return this.toOutput();
  }

  /**
   * Get narrative by ID.
   */
  getNarrativeById(narrativeId: string): NarrativeIntelligence | null {
    const narrative = this.narratives.get(narrativeId);
    if (!narrative) return null;

    const now = new Date();
    const ageDays = (now.getTime() - narrative.created_at.getTime()) / (1000 * 60 * 60 * 24);

    return {
      narrative_id: narrative.narrative_id,
      narrative_name: narrative.narrative_name,
      strength: narrative.strength,
      direction: narrative.direction,
      acceleration: calculateAcceleration(narrative.strengthHistory),
      supporting_clusters: Array.from(narrative.supporting_clusters),
      affected_assets: Array.from(narrative.related_assets),
      description: narrative.description,
      age_days: Math.round(ageDays),
      created_at: narrative.created_at.toISOString(),
      updated_at: narrative.updated_at.toISOString(),
    };
  }

  /**
   * Get narratives by direction.
   */
  getNarrativesByDirection(direction: "Bullish" | "Bearish" | "Neutral"): NarrativeIntelligence[] {
    return this.toOutput().filter((n) => n.direction === direction);
  }

  /**
   * Get narratives by sector.
   */
  getNarrativesBySector(sector: string): NarrativeIntelligence[] {
    const output = this.toOutput();
    const result: NarrativeIntelligence[] = [];

    for (const narrative of output) {
      const internalNarrative = this.narratives.get(narrative.narrative_id);
      if (internalNarrative && internalNarrative.affected_sectors.has(sector)) {
        result.push(narrative);
      }
    }

    return result;
  }

  /**
   * Clear all narratives (for testing or reset).
   */
  clear(): void {
    this.narratives.clear();
    this.narrativeCounter = 0;
  }
}

/**
 * Helper: Create narrative registry and process clusters in one call.
 */
export function processClustersByNarratives(
  clusters: EventCluster[],
  config?: Partial<NarrativeIntelligenceConfig>
): NarrativeIntelligence[] {
  const registry = new NarrativeRegistry(config);
  return registry.updateWithClusters(clusters);
}

/**
 * Helper: Get all supported narrative templates.
 */
export function getSupportedNarratives(): Array<{
  pattern_id: string;
  pattern_name: string;
  description: string;
  direction: "Bullish" | "Bearish" | "Neutral";
}> {
  return narrativePatterns.map((p) => ({
    pattern_id: p.pattern_id,
    pattern_name: p.pattern_name,
    description: p.description,
    direction: p.direction,
  }));
}

/**
 * Helper: Get default configuration.
 */
export function getDefaultNarrativeConfig(): NarrativeIntelligenceConfig {
  return { ...defaultConfig };
}

/**
 * Helper: Calculate narrative portfolio impact.
 * Estimates how narratives affect sector/asset allocations.
 */
export function calculateNarrativePortfolioImpact(
  narratives: NarrativeIntelligence[]
): {
  sector_impacts: Map<string, number>;
  asset_impacts: Map<string, number>;
} {
  const sectorImpacts = new Map<string, number>();
  const assetImpacts = new Map<string, number>();

  for (const narrative of narratives) {
    const directionMultiplier = narrative.direction === "Bullish" ? 1 : narrative.direction === "Bearish" ? -1 : 0;
    const impactStrength = narrative.strength * directionMultiplier;

    // Apply impact to affected assets
    for (const asset of narrative.affected_assets) {
      const current = assetImpacts.get(asset) || 0;
      assetImpacts.set(asset, current + impactStrength);
    }
  }

  return {
    sector_impacts: sectorImpacts,
    asset_impacts: assetImpacts,
  };
}
