/**
 * Causal Graph Engine
 *
 * Models second-order and third-order market consequences using a deterministic,
 * directed, probabilistic causal graph. The engine consumes event clusters,
 * narratives, asset linkages, and macro signals to infer likely causal chains
 * across macroeconomic, geopolitical, and sector-contagion pathways.
 *
 * Philosophy:
 * - Causal relationships are encoded as directed edges with weights
 * - Chain confidence decays multiplicatively with path length
 * - Macro and geopolitical regimes seed distinct but overlapping pathways
 * - Sector contagion is modeled as directed spillover across linked sectors
 * - Output remains deterministic and traceable for institutional use
 */

export interface CausalEventCluster {
  cluster_id: string;
  label: string;
  event_count: number;
  sentiment: number;
  event_types: string[];
  entities: string[];
  sectors: string[];
  last_event_at?: string;
}

export interface CausalNarrative {
  narrative_id: string;
  narrative_name: string;
  strength: number;
  direction: "Bullish" | "Bearish" | "Neutral";
  supporting_clusters?: string[];
  affected_assets?: string[];
  affected_sectors?: string[];
}

export interface CausalAssetLinkage {
  affected_assets: string[];
  sectors: string[];
  asset_classes: string[];
  confidence: number;
  reasoning?: string[];
}

export interface CausalMacroSignal {
  signal_type: string;
  value?: number;
  direction?: "Bullish" | "Bearish" | "Neutral";
  confidence?: number;
  label?: string;
  description?: string;
}

export interface CausalChain {
  origin: string;
  effects: string[];
  confidence: number;
}

export interface CausalGraphNode {
  id: string;
  label: string;
  kind: "macro" | "geopolitical" | "sector" | "asset" | "narrative" | "signal";
  weight: number;
}

export interface CausalGraphEdge {
  from: string;
  to: string;
  relation: string;
  weight: number;
  lag?: string;
}

export interface CausalGraphOutput {
  causalChains: CausalChain[];
}

export interface CausalGraphInput {
  eventClusters: CausalEventCluster[];
  narratives: CausalNarrative[];
  assetLinkages: CausalAssetLinkage[];
  macroSignals: CausalMacroSignal[];
}

export interface CausalGraphConfig {
  maxDepth: number;
  minEdgeWeight: number;
  minChainConfidence: number;
  maxChains: number;
  sectorContagionMultiplier: number;
  macroChainMultiplier: number;
  geopoliticalChainMultiplier: number;
  narrativeAmplification: number;
}

const defaultConfig: CausalGraphConfig = {
  maxDepth: 3,
  minEdgeWeight: 0.2,
  minChainConfidence: 0.25,
  maxChains: 50,
  sectorContagionMultiplier: 0.9,
  macroChainMultiplier: 1.0,
  geopoliticalChainMultiplier: 0.95,
  narrativeAmplification: 1.1,
};

type NodeKind = CausalGraphNode["kind"];

interface GraphNodeState extends CausalGraphNode {
  outgoing: CausalGraphEdge[];
}

interface SeedContext {
  nodeId: string;
  label: string;
  baseConfidence: number;
  kind: NodeKind;
}

interface ChainCandidate {
  origin: string;
  path: string[];
  confidence: number;
}

const MACRO_EDGE_LIBRARY: Array<{
  from: string;
  to: string;
  relation: string;
  weight: number;
  lag?: string;
}> = [
  { from: "fed hikes", to: "bond yields rise", relation: "policy_transmits_to_rates", weight: 0.96, lag: "immediate" },
  { from: "bond yields rise", to: "bank stress", relation: "duration_pressure", weight: 0.88, lag: "days" },
  { from: "bank stress", to: "commercial real estate pressure", relation: "credit_tightening", weight: 0.87, lag: "days" },
  { from: "commercial real estate pressure", to: "reit weakness", relation: "balance_sheet_contagion", weight: 0.91, lag: "days" },
  { from: "fed hikes", to: "duration-sensitive assets weaken", relation: "discount_rate_repricing", weight: 0.84, lag: "days" },
  { from: "fed hikes", to: "usd strengthens", relation: "policy_differential", weight: 0.8, lag: "days" },
  { from: "usd strengthens", to: "emerging markets pressure", relation: "capital_flow_pressure", weight: 0.74, lag: "weeks" },
  { from: "inflation persists", to: "fed hikes", relation: "policy_response", weight: 0.9, lag: "weeks" },
  { from: "inflation persists", to: "bond yields rise", relation: "inflation_premium", weight: 0.82, lag: "days" },
  { from: "yield curve steepens", to: "financials benefit", relation: "net_interest_margin", weight: 0.72, lag: "weeks" },
  { from: "credit stress", to: "lending standards tighten", relation: "risk_aversion", weight: 0.92, lag: "days" },
  { from: "lending standards tighten", to: "small caps weaken", relation: "funding_pressure", weight: 0.73, lag: "days" },
  { from: "liquidity shock", to: "risk assets sell off", relation: "deleveraging", weight: 0.9, lag: "immediate" },
  { from: "risk assets sell off", to: "volatility rises", relation: "forced_repricing", weight: 0.86, lag: "immediate" },
  { from: "recession risk rises", to: "defensive sectors outperform", relation: "risk_rotation", weight: 0.7, lag: "weeks" },
  { from: "growth slows", to: "earnings estimates fall", relation: "fundamental_revisions", weight: 0.77, lag: "weeks" },
  { from: "earnings estimates fall", to: "equity multiples compress", relation: "valuation_repricing", weight: 0.82, lag: "days" },
  { from: "supply chain stress", to: "input costs rise", relation: "cost_push", weight: 0.88, lag: "days" },
  { from: "input costs rise", to: "margin pressure", relation: "profitability_compression", weight: 0.85, lag: "days" },
  { from: "margin pressure", to: "earnings weakness", relation: "fundamental_transmission", weight: 0.83, lag: "weeks" },
];

const GEOPOLITICAL_EDGE_LIBRARY: Array<{
  from: string;
  to: string;
  relation: string;
  weight: number;
  lag?: string;
}> = [
  { from: "geopolitical escalation", to: "oil prices rise", relation: "supply_risk", weight: 0.84, lag: "immediate" },
  { from: "geopolitical escalation", to: "risk-off sentiment", relation: "flight_to_safety", weight: 0.86, lag: "immediate" },
  { from: "oil prices rise", to: "inflation pressure", relation: "energy_pass_through", weight: 0.88, lag: "days" },
  { from: "inflation pressure", to: "rates stay higher for longer", relation: "policy_response", weight: 0.83, lag: "weeks" },
  { from: "rates stay higher for longer", to: "duration assets weaken", relation: "discount_rate_effect", weight: 0.8, lag: "days" },
  { from: "geopolitical escalation", to: "defense demand rises", relation: "security_spending", weight: 0.72, lag: "weeks" },
  { from: "geopolitical escalation", to: "shipping disruption", relation: "logistics_dislocation", weight: 0.81, lag: "days" },
  { from: "shipping disruption", to: "inventory shortages", relation: "supply_delay", weight: 0.79, lag: "days" },
  { from: "inventory shortages", to: "consumer prices rise", relation: "cost_pass_through", weight: 0.74, lag: "weeks" },
  { from: "sanctions intensify", to: "commodity volatility rises", relation: "trade_fragmentation", weight: 0.77, lag: "days" },
  { from: "commodity volatility rises", to: "input costs rise", relation: "supply_chain_pressure", weight: 0.75, lag: "days" },
  { from: "war risk rises", to: "safe havens bid", relation: "capital_rotation", weight: 0.8, lag: "immediate" },
];

const SECTOR_CONTAGION_EDGE_LIBRARY: Array<{
  from: string;
  to: string;
  relation: string;
  weight: number;
  lag?: string;
}> = [
  { from: "bank stress", to: "regional banks weaken", relation: "peer_contagion", weight: 0.89, lag: "days" },
  { from: "bank stress", to: "credit availability tightens", relation: "balance_sheet_defense", weight: 0.87, lag: "days" },
  { from: "credit availability tightens", to: "commercial real estate pressure", relation: "refinancing_risk", weight: 0.83, lag: "weeks" },
  { from: "commercial real estate pressure", to: "reit weakness", relation: "occupancy_and_refi_risk", weight: 0.91, lag: "days" },
  { from: "reit weakness", to: "financials drag", relation: "portfolio_exposure", weight: 0.66, lag: "weeks" },
  { from: "semiconductor weakness", to: "hardware slowdown", relation: "demand_chain", weight: 0.84, lag: "weeks" },
  { from: "hardware slowdown", to: "enterprise it spend slows", relation: "capex_cycle", weight: 0.76, lag: "weeks" },
  { from: "energy shock", to: "transportation margins compress", relation: "fuel_costs", weight: 0.8, lag: "days" },
  { from: "transportation margins compress", to: "consumer spending weakens", relation: "price_transmission", weight: 0.68, lag: "weeks" },
  { from: "consumer spending weakens", to: "retail earnings weaken", relation: "demand_elasticity", weight: 0.79, lag: "weeks" },
  { from: "industrial slowdown", to: "capital goods orders fall", relation: "investment_cycle", weight: 0.76, lag: "weeks" },
  { from: "capital goods orders fall", to: "equipment makers weaken", relation: "capex_transmission", weight: 0.82, lag: "weeks" },
];

const NARRATIVE_EDGE_LIBRARY: Array<{
  from: string;
  to: string;
  relation: string;
  weight: number;
  lag?: string;
}> = [
  { from: "ai capex boom", to: "semiconductor demand rises", relation: "theme_transmission", weight: 0.92, lag: "weeks" },
  { from: "ai capex boom", to: "power demand rises", relation: "infrastructure_load", weight: 0.78, lag: "weeks" },
  { from: "energy supply stress", to: "inflation persistence", relation: "cost_push", weight: 0.84, lag: "days" },
  { from: "commercial real estate weakness", to: "bank stress", relation: "collateral_pressure", weight: 0.88, lag: "days" },
  { from: "monetary tightening cycle", to: "bond yields rise", relation: "policy_transmission", weight: 0.89, lag: "immediate" },
  { from: "monetary tightening cycle", to: "equity multiples compress", relation: "discount_rate_repricing", weight: 0.86, lag: "days" },
  { from: "consumer resilience", to: "retail earnings beat", relation: "demand_support", weight: 0.73, lag: "weeks" },
  { from: "supply chain normalization", to: "margin pressure eases", relation: "cost_relief", weight: 0.8, lag: "weeks" },
  { from: "geopolitical risk premium", to: "defense demand rises", relation: "security_spend", weight: 0.78, lag: "weeks" },
  { from: "geopolitical risk premium", to: "energy volatility rises", relation: "supply_uncertainty", weight: 0.82, lag: "days" },
];

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildRuleSet(
  rules: Array<{ from: string; to: string; relation: string; weight: number; lag?: string }>
): Map<string, Array<{ to: string; relation: string; weight: number; lag?: string }>> {
  const map = new Map<string, Array<{ to: string; relation: string; weight: number; lag?: string }>>();

  for (const rule of rules) {
    const normalizedFrom = normalizeText(rule.from);
    const edges = map.get(normalizedFrom) ?? [];
    edges.push({ to: normalizeText(rule.to), relation: rule.relation, weight: rule.weight, lag: rule.lag });
    map.set(normalizedFrom, edges);
  }

  return map;
}

const MACRO_RULES = buildRuleSet(MACRO_EDGE_LIBRARY);
const GEOPOLITICAL_RULES = buildRuleSet(GEOPOLITICAL_EDGE_LIBRARY);
const SECTOR_CONTAGION_RULES = buildRuleSet(SECTOR_CONTAGION_EDGE_LIBRARY);
const NARRATIVE_RULES = buildRuleSet(NARRATIVE_EDGE_LIBRARY);

function buildGraphNode(id: string, label: string, kind: NodeKind, weight: number): GraphNodeState {
  return {
    id,
    label,
    kind,
    weight,
    outgoing: [],
  };
}

function scoreClusterSeed(cluster: CausalEventCluster): number {
  const density = clamp(cluster.event_count / 10, 0, 1);
  const sentimentStrength = clamp(Math.abs(cluster.sentiment), 0, 1);
  return clamp(density * 0.5 + sentimentStrength * 0.3 + 0.2, 0, 1);
}

function scoreNarrativeSeed(narrative: CausalNarrative): number {
  return clamp(narrative.strength, 0, 1);
}

function scoreAssetLinkageSeed(linkage: CausalAssetLinkage): number {
  return clamp(linkage.confidence, 0, 1);
}

function scoreMacroSeed(signal: CausalMacroSignal): number {
  return clamp(signal.confidence ?? 0.7, 0, 1);
}

function detectSignalThemes(signal: CausalMacroSignal): string[] {
  const parts = [signal.signal_type, signal.label ?? "", signal.description ?? ""].join(" ");
  const normalized = normalizeText(parts);
  const themes: string[] = [];

  if (/(fed|rates|hike|cut|yield|bond|inflation|tighten)/.test(normalized)) {
    themes.push("macro");
  }
  if (/(war|conflict|sanction|geopolitical|taiwan|china|russia|ukraine|gaza|israel|iran)/.test(normalized)) {
    themes.push("geopolitical");
  }
  if (/(bank|credit|cre|real estate|reit|regional bank|lending)/.test(normalized)) {
    themes.push("sector-contagion");
  }
  if (/(oil|energy|gas|commodity|shipping|supply chain)/.test(normalized)) {
    themes.push("supply-chain");
  }

  return unique(themes);
}

function makeSeedContexts(input: CausalGraphInput): SeedContext[] {
  const seeds: SeedContext[] = [];

  for (const cluster of input.eventClusters) {
    seeds.push({
      nodeId: `cluster:${cluster.cluster_id}`,
      label: cluster.label,
      baseConfidence: scoreClusterSeed(cluster),
      kind: "signal",
    });
  }

  for (const narrative of input.narratives) {
    seeds.push({
      nodeId: `narrative:${narrative.narrative_id}`,
      label: narrative.narrative_name,
      baseConfidence: scoreNarrativeSeed(narrative) * 0.95,
      kind: "narrative",
    });
  }

  for (const [index, linkage] of input.assetLinkages.entries()) {
    const primaryAsset = linkage.affected_assets[0] ?? `asset_${index}`;
    seeds.push({
      nodeId: `asset:${primaryAsset}`,
      label: primaryAsset,
      baseConfidence: scoreAssetLinkageSeed(linkage),
      kind: "asset",
    });
  }

  for (const signal of input.macroSignals) {
    seeds.push({
      nodeId: `macro:${normalizeText(signal.signal_type)}`,
      label: signal.label ?? signal.signal_type,
      baseConfidence: scoreMacroSeed(signal),
      kind: signal.direction === "Bearish" ? "geopolitical" : "macro",
    });
  }

  return seeds;
}

function buildGraphFromInput(input: CausalGraphInput): Map<string, GraphNodeState> {
  const graph = new Map<string, GraphNodeState>();

  function ensureNode(id: string, label: string, kind: NodeKind, weight: number): GraphNodeState {
    const existing = graph.get(id);
    if (existing) {
      existing.weight = Math.max(existing.weight, weight);
      return existing;
    }

    const created = buildGraphNode(id, label, kind, weight);
    graph.set(id, created);
    return created;
  }

  function addEdge(from: string, to: string, relation: string, weight: number, lag?: string): void {
    const source = graph.get(from);
    if (!source) return;

    source.outgoing.push({ from, to, relation, weight: clamp(weight, 0, 1), lag });
  }

  for (const cluster of input.eventClusters) {
    const node = ensureNode(`cluster:${cluster.cluster_id}`, cluster.label, "signal", scoreClusterSeed(cluster));
    const normalizedText = normalizeText(`${cluster.label} ${cluster.event_types.join(" ")} ${cluster.entities.join(" ")} ${cluster.sectors.join(" ")}`);

    for (const sector of cluster.sectors) {
      ensureNode(`sector:${sector}`, sector, "sector", 0.6);
      const sectorText = normalizeText(sector);
      if (normalizedText.includes(sectorText)) {
        addEdge(node.id, `sector:${sector}`, "sector_exposure", 0.72);
      }
    }

    if (/(fed|rates|yield|inflation|policy)/.test(normalizedText)) {
      ensureNode("macro:fed hikes", "Fed hikes", "macro", 0.9);
      addEdge(node.id, "macro:fed hikes", "macro_alignment", 0.75);
    }
    if (/(bank|lending|credit|regional bank)/.test(normalizedText)) {
      ensureNode("sector:financials", "Financials", "sector", 0.8);
      addEdge(node.id, "sector:financials", "sector_contagion", 0.76);
    }
    if (/(cre|reit|real estate)/.test(normalizedText)) {
      ensureNode("sector:real estate", "Real Estate", "sector", 0.8);
      addEdge(node.id, "sector:real estate", "sector_exposure", 0.78);
    }
    if (/(oil|energy|gas|commodity)/.test(normalizedText)) {
      ensureNode("sector:energy", "Energy", "sector", 0.8);
      addEdge(node.id, "sector:energy", "commodity_exposure", 0.75);
    }
  }

  for (const narrative of input.narratives) {
    const node = ensureNode(`narrative:${narrative.narrative_id}`, narrative.narrative_name, "narrative", scoreNarrativeSeed(narrative));
    const lowerName = normalizeText(narrative.narrative_name);

    if (lowerName.includes("fed") || lowerName.includes("tightening") || lowerName.includes("inflation")) {
      ensureNode("macro:fed hikes", "Fed hikes", "macro", 0.95);
      addEdge(node.id, "macro:fed hikes", "narrative_to_macro", 0.8);
    }
    if (lowerName.includes("commercial real estate") || lowerName.includes("cre")) {
      ensureNode("sector:real estate", "Real Estate", "sector", 0.85);
      addEdge(node.id, "sector:real estate", "narrative_to_sector", 0.84);
    }
    if (lowerName.includes("ai") || lowerName.includes("semiconductor") || lowerName.includes("chip")) {
      ensureNode("sector:technology", "Technology", "sector", 0.85);
      ensureNode("sector:semiconductors", "Semiconductors", "sector", 0.9);
      addEdge(node.id, "sector:semiconductors", "theme_transmission", 0.88);
    }
  }

  for (const linkage of input.assetLinkages) {
    const linkageWeight = scoreAssetLinkageSeed(linkage);
    for (const asset of linkage.affected_assets) {
      ensureNode(`asset:${asset}`, asset, "asset", linkageWeight);
    }
    for (const sector of linkage.sectors) {
      ensureNode(`sector:${sector}`, sector, "sector", linkageWeight * 0.9);
    }
  }

  for (const signal of input.macroSignals) {
    const signalId = `macro:${normalizeText(signal.signal_type)}`;
    const node = ensureNode(signalId, signal.label ?? signal.signal_type, signal.direction === "Bearish" ? "geopolitical" : "macro", scoreMacroSeed(signal));
    const themes = detectSignalThemes(signal);
    const normalizedText = normalizeText([signal.signal_type, signal.label ?? "", signal.description ?? ""].join(" "));

    if (themes.includes("macro")) {
      ensureNode("macro:fed hikes", "Fed hikes", "macro", 0.95);
      if (/(fed|rates|yield|inflation|hike|cut)/.test(normalizedText)) {
        addEdge(node.id, "macro:fed hikes", "macro_alignment", 0.82);
      }
    }
    if (themes.includes("geopolitical")) {
      ensureNode("geopolitical:escalation", "Geopolitical escalation", "geopolitical", 0.9);
      addEdge(node.id, "geopolitical:escalation", "geopolitical_alignment", 0.8);
    }
    if (themes.includes("sector-contagion")) {
      ensureNode("sector:financials", "Financials", "sector", 0.85);
      addEdge(node.id, "sector:financials", "contagion_risk", 0.76);
    }
    if (themes.includes("supply-chain")) {
      ensureNode("sector:industrials", "Industrials", "sector", 0.7);
      addEdge(node.id, "sector:industrials", "supply_chain_pressure", 0.7);
    }
  }

  const allNodes = Array.from(graph.values());
  for (const node of allNodes) {
    const normalizedLabel = normalizeText(node.label);
    const ruleSets = [MACRO_RULES, GEOPOLITICAL_RULES, SECTOR_CONTAGION_RULES, NARRATIVE_RULES];

    for (const ruleSet of ruleSets) {
      const edges = ruleSet.get(normalizedLabel);
      if (!edges) continue;

      for (const edge of edges) {
        const targetKind: NodeKind = edge.to.startsWith("macro:") ? "macro" : edge.to.startsWith("geopolitical:") ? "geopolitical" : edge.to.startsWith("sector:") ? "sector" : edge.to.startsWith("asset:") ? "asset" : "signal";
        const targetLabel = edge.to.split(":").slice(1).join(":") || edge.to;
        ensureNode(edge.to, targetLabel, targetKind, edge.weight);
        addEdge(node.id, edge.to, edge.relation, edge.weight, edge.lag);
      }
    }
  }

  return graph;
}

function propagateChains(
  graph: Map<string, GraphNodeState>,
  seeds: SeedContext[],
  config: CausalGraphConfig
): ChainCandidate[] {
  const chains: ChainCandidate[] = [];
  const adjacency = graph;

  for (const seed of seeds) {
    const startNode = adjacency.get(seed.nodeId);
    if (!startNode) continue;

    const queue: Array<{ nodeId: string; path: string[]; confidence: number; depth: number }> = [
      {
        nodeId: seed.nodeId,
        path: [seed.label],
        confidence: seed.baseConfidence,
        depth: 0,
      },
    ];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;

      const node = adjacency.get(current.nodeId);
      if (!node) continue;

      for (const edge of node.outgoing) {
        if (edge.weight < config.minEdgeWeight) continue;
        if (current.path.includes(adjacency.get(edge.to)?.label ?? edge.to)) continue;

        const nextNode = adjacency.get(edge.to);
        if (!nextNode) continue;

        const lengthPenalty = current.depth === 0 ? 1 : current.depth === 1 ? 0.86 : 0.72;
        const kindMultiplier = nextNode.kind === "sector" ? config.sectorContagionMultiplier : nextNode.kind === "macro" ? config.macroChainMultiplier : nextNode.kind === "geopolitical" ? config.geopoliticalChainMultiplier : 1;
        const signalBoost = seed.kind === "narrative" ? config.narrativeAmplification : 1;
        const nextConfidence = clamp(current.confidence * edge.weight * lengthPenalty * kindMultiplier * signalBoost, 0, 1);
        const nextPath = [...current.path, nextNode.label];

        if (nextPath.length >= 2) {
          chains.push({
            origin: seed.label,
            path: nextPath,
            confidence: nextConfidence,
          });
        }

        if (current.depth + 1 < config.maxDepth && nextConfidence >= config.minChainConfidence) {
          queue.push({
            nodeId: nextNode.id,
            path: nextPath,
            confidence: nextConfidence,
            depth: current.depth + 1,
          });
        }
      }
    }
  }

  return chains;
}

function collapseChains(candidates: ChainCandidate[], config: CausalGraphConfig): CausalChain[] {
  const grouped = new Map<string, { effects: Set<string>; confidenceValues: number[] }>();

  for (const candidate of candidates) {
    if (candidate.path.length < 2) continue;
    const origin = candidate.path[0];
    const effects = candidate.path.slice(1);
    const key = [origin, ...effects].join(" -> ");
    const existing = grouped.get(key);

    if (existing) {
      for (const effect of effects) {
        existing.effects.add(effect);
      }
      existing.confidenceValues.push(candidate.confidence);
    } else {
      grouped.set(key, { effects: new Set(effects), confidenceValues: [candidate.confidence] });
    }
  }

  const chains = Array.from(grouped.entries()).map(([key, value]) => {
    const [origin, ...effects] = key.split(" -> ");
    return {
      origin,
      effects: effects.length > 0 ? effects : Array.from(value.effects),
      confidence: average(value.confidenceValues),
    } satisfies CausalChain;
  });

  return chains
    .filter((chain) => chain.confidence >= config.minChainConfidence)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, config.maxChains)
    .map((chain) => ({
      origin: chain.origin,
      effects: unique(chain.effects),
      confidence: clamp(chain.confidence, 0, 1),
    }));
}

export function buildCausalGraph(input: CausalGraphInput): {
  nodes: CausalGraphNode[];
  edges: CausalGraphEdge[];
} {
  const graph = buildGraphFromInput(input);
  const nodes = Array.from(graph.values()).map(({ outgoing, ...node }) => node);
  const edges: CausalGraphEdge[] = [];

  for (const node of graph.values()) {
    edges.push(...node.outgoing);
  }

  return { nodes, edges };
}

export function inferCausalChains(
  input: CausalGraphInput,
  config?: Partial<CausalGraphConfig>
): CausalGraphOutput {
  const resolvedConfig = { ...defaultConfig, ...config };
  const graph = buildGraphFromInput(input);
  const seeds = makeSeedContexts(input);
  const candidates = propagateChains(graph, seeds, resolvedConfig);
  const causalChains = collapseChains(candidates, resolvedConfig);

  return { causalChains };
}

export function getDefaultCausalGraphConfig(): CausalGraphConfig {
  return { ...defaultConfig };
}

export function explainCausalChain(chain: CausalChain): string {
  if (chain.effects.length === 0) {
    return `${chain.origin} has no inferred downstream effects.`;
  }

  return `${chain.origin} may cascade into ${chain.effects.join(" -> ")} with ${Math.round(chain.confidence * 100)}% confidence.`;
}
