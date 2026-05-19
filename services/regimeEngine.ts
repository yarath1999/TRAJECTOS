import {
  DEFAULT_REGIME_ADJUSTMENT,
  MIN_REGIME_ADJUSTMENT,
  MAX_REGIME_ADJUSTMENT,
  MIN_REGIME_SCORE,
  MIN_REGIME_MARGIN,
  MAX_REGIME_SCORE,
  REGIME_HISTORY_SIZE,
  DEFAULT_FALLBACK_REGIME,
  REGIME_CONFIDENCE_WEAK_MAX,
  REGIME_CONFIDENCE_STRONG_MIN,
  REGIME_FALLBACK_TTL_MS,
} from "../config/allocationConfig";
import { logDebug, logEvent, logWarn } from "../utils/logger";
import { createMemoryCache, recordRegimeConfidence } from "../utils/performanceTracker";

export type MacroRegime = "inflationary" | "risk_off" | "growth" | "deflationary";

type InsightReasoningSignal = {
  direction?: unknown;
  strength?: unknown;
  confidence?: unknown;
  source_factor?: unknown;
};

type SignalLike = {
  direction?: unknown;
  confidence?: unknown;
  source_factor?: unknown;
};

type ParsedReasoning = { signals: InsightReasoningSignal[]; rawRegime: MacroRegime | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseRawReasoning(value: unknown): ParsedReasoning {
  if (!isRecord(value)) return { signals: [], rawRegime: null };

  const signals = Array.isArray(value.signals) ? (value.signals as InsightReasoningSignal[]) : [];
  const raw = (value.regime ?? value.dominant_regime ?? value.finalRegime ?? "").toString().trim().toLowerCase();
  const rawRegime =
    raw === "inflationary" || raw === "risk_off" || raw === "growth" || raw === "deflationary"
      ? (raw as MacroRegime)
      : null;

  return { signals, rawRegime };
}

const reasoningCache = createMemoryCache<string, ParsedReasoning>(100);

function parseReasoningFromString(value: string): ParsedReasoning {
  const cached = reasoningCache.get(value);
  if (cached) return cached;

  try {
    const parsed = JSON.parse(value) as unknown;
    const result = parseRawReasoning(parsed);
    reasoningCache.set(value, result);
    return result;
  } catch {
    const result = { signals: [], rawRegime: null };
    reasoningCache.set(value, result);
    return result;
  }
}

function parseReasoning(reasoning: unknown): ParsedReasoning {
  if (typeof reasoning === "string") return parseReasoningFromString(reasoning);
  return parseRawReasoning(reasoning);
}

function normalizeSignal(signal: string | null | undefined): "BUY" | "SELL" | "NEUTRAL" {
  const s = (signal ?? "").toString().trim().toUpperCase();
  if (s === "BUY" || s === "SELL" || s === "NEUTRAL") return s as "BUY" | "SELL" | "NEUTRAL";
  return "NEUTRAL";
}

function getSignalForAsset(
  signalByAsset: Map<string, { signal: "BUY" | "SELL" | "NEUTRAL"; confidence: number }>,
  asset: string,
): "BUY" | "SELL" | "NEUTRAL" {
  const entry = signalByAsset.get(asset);
  return entry?.signal ?? "NEUTRAL";
}

type RegimeScores = {
  inflationary: number;
  risk_off: number;
  growth: number;
  deflationary: number;
};

export type ExtendedRegime =
  | MacroRegime
  | "liquidity"
  | "ai_capex"
  | "geopolitical_fragmentation"
  | "energy_stress"
  | "banking_stress"
  | "semiconductor_cycle"
  | "crypto_liquidity_cycle";

export interface RegimeEventClusterInput {
  cluster_id?: string;
  label?: string;
  event_count?: number;
  sentiment?: number;
  event_types?: string[];
  entities?: string[];
  sectors?: string[];
}

export interface RegimeMacroEventInput {
  title?: string;
  summary?: string;
  event_type?: string;
  direction?: "BUY" | "SELL" | "NEUTRAL" | "Bullish" | "Bearish" | "Neutral";
  confidence?: number;
  affected_assets?: string[];
  affected_sectors?: string[];
  tags?: string[];
}

export interface RegimePortfolioSignalInput {
  asset: string;
  signal: "BUY" | "SELL" | "NEUTRAL";
  confidence?: number;
  weight?: number;
}

export interface RegimeEventImpactInput {
  asset?: string;
  sector?: string;
  factor?: string;
  direction?: "BUY" | "SELL" | "POSITIVE" | "NEGATIVE" | "UP" | "DOWN" | "NEUTRAL";
  magnitude?: number;
  confidence?: number;
  label?: string;
}

export interface RegimeAnalysisInput {
  event_clusters?: RegimeEventClusterInput[];
  macro_events?: RegimeMacroEventInput[];
  portfolio_signals?: RegimePortfolioSignalInput[];
  event_impacts?: RegimeEventImpactInput[];
  factor_exposures?: Record<string, number> | Array<{ factor: string; exposure: number }>;
  signals?: InsightReasoningSignal[];
  rawRegime?: MacroRegime | null;
}

export interface RegimeAnalysisOutput {
  active_regimes: ExtendedRegime[];
  dominant_regime: ExtendedRegime;
  confidence: number;
  supporting_signals: string[];
  affected_assets: string[];
  finalRegime: MacroRegime;
  smoothedRegime: MacroRegime | null;
  adjustmentStrength: number;
  scores: Record<string, number>;
  rejectReason: "below_threshold" | "insufficient_margin" | null;
  topScore: number;
  secondScore: number;
}

type RegimeBucket = {
  score: number;
  signals: Set<string>;
  assets: Set<string>;
};

const EXTENDED_REGIME_ASSETS: Record<ExtendedRegime, string[]> = {
  inflationary: ["TLT", "IEF", "BND", "XLF", "XLE"],
  risk_off: ["SPY", "QQQ", "TLT", "IEF", "GLD"],
  growth: ["SPY", "QQQ", "IWM", "XLY", "XLK"],
  deflationary: ["TLT", "IEF", "BND", "SHY"],
  liquidity: ["TLT", "IEF", "BIL", "SHY", "UUP"],
  ai_capex: ["NVDA", "AMD", "ASML", "TSM", "AMAT", "LRCX", "KLAC", "SOXX", "SMH"],
  geopolitical_fragmentation: ["GLD", "LMT", "RTX", "NOC", "XLE", "DBA"],
  energy_stress: ["XLE", "XOM", "CVX", "COP", "CL=F", "NG=F"],
  banking_stress: ["XLF", "KRE", "JPM", "BAC", "WFC", "C", "GS", "XLRE", "VNQ"],
  semiconductor_cycle: ["SOXX", "SMH", "NVDA", "AMD", "TSM", "ASML", "AMAT", "LRCX", "KLAC"],
  crypto_liquidity_cycle: ["BTC", "ETH", "COIN", "MSTR", "BITO", "MARA"],
};

const EXTENDED_REGIME_KEYWORDS: Record<ExtendedRegime, string[]> = {
  inflationary: ["inflation", "cpi", "wage", "price pressure", "hawkish", "rates higher", "yields rise", "oil spike", "commodity inflation"],
  risk_off: ["risk off", "selloff", "volatility", "stress", "recession", "panic", "deleveraging", "flight to safety"],
  growth: ["growth", "earnings beat", "capex", "productivity", "demand", "resilient consumer", "expansion", "rally"],
  deflationary: ["deflation", "disinflation", "weak demand", "falling yields", "soft landing", "recession", "price decline"],
  liquidity: ["liquidity", "repo", "funding", "cash", "margin call", "dealer balance sheet", "easy financial conditions", "reserve"],
  ai_capex: ["ai", "artificial intelligence", "capex", "data center", "gpu", "training", "hyperscaler", "compute", "inference"],
  geopolitical_fragmentation: ["geopolitical", "sanctions", "tariff", "export control", "decoupling", "fragmentation", "war", "conflict", "reshoring"],
  energy_stress: ["energy", "oil", "gas", "opec", "refinery", "pipeline", "supply shock", "energy supply", "lng"],
  banking_stress: ["bank", "credit", "regional bank", "deposit outflow", "commercial real estate", "cre", "loan loss", "refinancing", "lending standards"],
  semiconductor_cycle: ["semiconductor", "chip", "foundry", "wafer", "fab", "tapeout", "tsmc", "asml", "memory"],
  crypto_liquidity_cycle: ["crypto", "bitcoin", "ethereum", "stablecoin", "funding rate", "exchange outflow", "exchange inflow", "liquidity cycle"],
};

const EXTENDED_REGIME_ORDER: ExtendedRegime[] = [
  "liquidity",
  "ai_capex",
  "geopolitical_fragmentation",
  "energy_stress",
  "banking_stress",
  "semiconductor_cycle",
  "crypto_liquidity_cycle",
  "inflationary",
  "risk_off",
  "growth",
  "deflationary",
];

function computeRegimeScores(
  signalByAsset: Map<string, { signal: "BUY" | "SELL" | "NEUTRAL"; confidence: number }>,
): RegimeScores {
  const bonds = getSignalForAsset(signalByAsset, "bonds");
  const commodities = getSignalForAsset(signalByAsset, "commodities");
  const equities = getSignalForAsset(signalByAsset, "equities");
  const usd = getSignalForAsset(signalByAsset, "usd");

  const inflationary = (bonds === "SELL" ? 1 : 0) + (commodities === "BUY" ? 1 : 0);
  const risk_off = (equities === "SELL" ? 1 : 0) + (usd === "BUY" ? 1 : 0);
  const growth = (equities === "BUY" ? 1 : 0) + (commodities === "BUY" ? 1 : 0);
  const deflationary = (bonds === "BUY" ? 1 : 0) + (equities === "SELL" ? 1 : 0);

  return { inflationary, risk_off, growth, deflationary };
}

function pickRegimeFromScores(scores: RegimeScores): {
  regime: MacroRegime | null;
  topScore: number;
  secondScore: number;
  rejectReason: "below_threshold" | "insufficient_margin" | null;
} {
  const priority: MacroRegime[] = ["inflationary", "risk_off", "growth", "deflationary"];
  const ranked = priority.map((regime) => ({ regime, score: scores[regime] }));
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return priority.indexOf(a.regime) - priority.indexOf(b.regime);
  });

  const top = ranked[0];
  const second = ranked[1] ?? { score: 0, regime: "deflationary" as MacroRegime };
  const topScore = top?.score ?? 0;
  const secondScore = second?.score ?? 0;

  if (topScore < MIN_REGIME_SCORE) return { regime: null, topScore, secondScore, rejectReason: "below_threshold" };
  if (topScore - secondScore < MIN_REGIME_MARGIN) return { regime: null, topScore, secondScore, rejectReason: "insufficient_margin" };
  return { regime: top.regime, topScore, secondScore, rejectReason: null };
}

export function scoreRegimeSignals(
  signals: SignalLike[],
): {
  regime: MacroRegime | null;
  scores: RegimeScores;
  topScore: number;
  secondScore: number;
  rejectReason: "below_threshold" | "insufficient_margin" | null;
} {
  const signalMap = new Map<string, { signal: "BUY" | "SELL" | "NEUTRAL"; confidence: number }>();

  for (const row of signals) {
    if (!isRecord(row)) continue;
    const source = (row.source_factor ?? "").toString().trim().toLowerCase();
    if (!source) continue;

    const signal = normalizeSignal((row.direction ?? "").toString());
    const conf = Number(row.confidence);
    const confidence = Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : 0.6;
    signalMap.set(source, { signal, confidence });
  }

  const scores = computeRegimeScores(signalMap);
  const picked = pickRegimeFromScores(scores);
  return { ...picked, scores };
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function toArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => item?.toString().trim()).filter((item) => item.length > 0);
}

function createRegimeBuckets(): Record<ExtendedRegime, RegimeBucket> {
  return {
    inflationary: { score: 0, signals: new Set(), assets: new Set() },
    risk_off: { score: 0, signals: new Set(), assets: new Set() },
    growth: { score: 0, signals: new Set(), assets: new Set() },
    deflationary: { score: 0, signals: new Set(), assets: new Set() },
    liquidity: { score: 0, signals: new Set(), assets: new Set() },
    ai_capex: { score: 0, signals: new Set(), assets: new Set() },
    geopolitical_fragmentation: { score: 0, signals: new Set(), assets: new Set() },
    energy_stress: { score: 0, signals: new Set(), assets: new Set() },
    banking_stress: { score: 0, signals: new Set(), assets: new Set() },
    semiconductor_cycle: { score: 0, signals: new Set(), assets: new Set() },
    crypto_liquidity_cycle: { score: 0, signals: new Set(), assets: new Set() },
  };
}

function addEvidence(
  buckets: Record<ExtendedRegime, RegimeBucket>,
  regime: ExtendedRegime,
  score: number,
  signal: string,
  assets: string[] = [],
): void {
  if (!Number.isFinite(score) || score <= 0) return;
  const bucket = buckets[regime];
  bucket.score += score;
  if (signal.trim()) bucket.signals.add(signal.trim());
  for (const asset of assets) bucket.assets.add(asset.trim().toUpperCase());
}

function keywordHitScore(text: string, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  let hits = 0;
  for (const keyword of keywords) {
    if (text.includes(keyword)) hits += 1;
  }
  return hits === 0 ? 0 : hits / keywords.length;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function parseFactorExposures(
  factorExposures: RegimeAnalysisInput["factor_exposures"],
): Record<string, number> {
  if (!factorExposures) return {};
  if (Array.isArray(factorExposures)) {
    const mapped: Record<string, number> = {};
    for (const row of factorExposures) {
      const factor = row.factor?.toString().trim().toLowerCase();
      const exposure = Number(row.exposure);
      if (!factor || !Number.isFinite(exposure)) continue;
      mapped[factor] = (mapped[factor] ?? 0) + exposure;
    }
    return mapped;
  }

  const mapped: Record<string, number> = {};
  for (const [factor, exposure] of Object.entries(factorExposures)) {
    const normalizedFactor = factor.toLowerCase().trim();
    const numericExposure = Number(exposure);
    if (!normalizedFactor || !Number.isFinite(numericExposure)) continue;
    mapped[normalizedFactor] = numericExposure;
  }
  return mapped;
}

function normalizeDirection(value: unknown): "BUY" | "SELL" | "NEUTRAL" {
  const normalized = value?.toString().trim().toUpperCase() ?? "";
  if (normalized === "BUY" || normalized === "SELL" || normalized === "NEUTRAL") return normalized;
  if (normalized === "BULLISH" || normalized === "POSITIVE" || normalized === "UP") return "BUY";
  if (normalized === "BEARISH" || normalized === "NEGATIVE" || normalized === "DOWN") return "SELL";
  return "NEUTRAL";
}

function assetBasketForRegime(regime: ExtendedRegime): string[] {
  return EXTENDED_REGIME_ASSETS[regime] ?? [];
}

function mapExtendedToLegacy(regime: ExtendedRegime): MacroRegime {
  switch (regime) {
    case "inflationary":
    case "energy_stress":
      return "inflationary";
    case "growth":
    case "ai_capex":
    case "semiconductor_cycle":
    case "liquidity":
      return "growth";
    case "deflationary":
      return "deflationary";
    case "risk_off":
    case "geopolitical_fragmentation":
    case "banking_stress":
    case "crypto_liquidity_cycle":
      return "risk_off";
  }
}

function buildRegimeSummaryFromBuckets(
  buckets: Record<ExtendedRegime, RegimeBucket>,
  config: { minActiveScore: number; maxActiveRegimes: number },
): {
  activeRegimes: ExtendedRegime[];
  dominantRegime: ExtendedRegime;
  supportingSignals: string[];
  affectedAssets: string[];
  scoreMap: Record<string, number>;
  topScore: number;
  secondScore: number;
  confidence: number;
} {
  const ranked = EXTENDED_REGIME_ORDER.map((regime) => ({ regime, score: buckets[regime].score }))
    .sort((a, b) => b.score - a.score);

  const top = ranked[0] ?? { regime: "growth" as ExtendedRegime, score: 0 };
  const second = ranked[1] ?? { regime: "growth" as ExtendedRegime, score: 0 };
  const activeRegimes = ranked
    .filter((entry) => entry.score >= Math.max(config.minActiveScore, top.score * 0.6))
    .slice(0, config.maxActiveRegimes)
    .map((entry) => entry.regime);

  const signals = new Set<string>();
  const assets = new Set<string>();
  const scoreMap: Record<string, number> = {};

  for (const regime of EXTENDED_REGIME_ORDER) {
    const bucket = buckets[regime];
    scoreMap[regime] = Number(bucket.score.toFixed(4));
    for (const signal of bucket.signals) signals.add(signal);
    for (const asset of bucket.assets) assets.add(asset);
  }

  for (const regime of activeRegimes) {
    for (const asset of assetBasketForRegime(regime)) assets.add(asset);
  }

  const topScore = top.score;
  const secondScore = second.score;
  const relativeConfidence = topScore > 0 ? topScore / Math.max(topScore + secondScore, 0.000001) : 0;
  const absoluteConfidence = clamp01(topScore / 3);
  const breadthConfidence = clamp01(signals.size / 10);
  const confidence = clamp01(relativeConfidence * 0.5 + absoluteConfidence * 0.35 + breadthConfidence * 0.15);

  return {
    activeRegimes,
    dominantRegime: top.regime,
    supportingSignals: Array.from(signals),
    affectedAssets: Array.from(assets),
    scoreMap,
    topScore,
    secondScore,
    confidence,
  };
}

function scoreExtendedRegimes(input: RegimeAnalysisInput): RegimeAnalysisOutput {
  const buckets = createRegimeBuckets();
  const supportingSignals: string[] = [];

  const clusterInputs = input.event_clusters ?? [];
  for (const cluster of clusterInputs) {
    const text = normalizeText(
      [cluster.label, cluster.event_types?.join(" "), cluster.entities?.join(" "), cluster.sectors?.join(" ")].filter(Boolean).join(" "),
    );
    const eventWeight = clamp01(0.3 + Math.min(0.7, (Number(cluster.event_count) || 0) / 20));
    const sentiment = Math.max(-1, Math.min(1, Number(cluster.sentiment) || 0));
    const clusterSignal = cluster.cluster_id ? `cluster:${cluster.cluster_id}` : `cluster:${cluster.label ?? "unknown"}`;

    for (const regime of EXTENDED_REGIME_ORDER) {
      const match = keywordHitScore(text, EXTENDED_REGIME_KEYWORDS[regime]);
      if (match <= 0) continue;
      const regimeWeight = regime === "ai_capex" || regime === "banking_stress" || regime === "energy_stress" || regime === "semiconductor_cycle" ? 1.15 : 1;
      addEvidence(buckets, regime, match * eventWeight * regimeWeight, `${clusterSignal}:${regime}`, assetBasketForRegime(regime));
    }

    if (sentiment > 0.25) {
      addEvidence(buckets, "growth", sentiment * 0.25 * eventWeight, `${clusterSignal}:positive_sentiment`, ["SPY", "QQQ"]);
    }
    if (sentiment < -0.25) {
      addEvidence(buckets, "risk_off", Math.abs(sentiment) * 0.3 * eventWeight, `${clusterSignal}:negative_sentiment`, ["TLT", "IEF", "GLD"]);
    }
  }

  const macroEvents = input.macro_events ?? [];
  for (const event of macroEvents) {
    const text = normalizeText([event.title, event.summary, event.event_type, event.tags?.join(" ")].filter(Boolean).join(" "));
    const confidence = clamp01(Number(event.confidence) || 0.65);
    const signal = normalizeDirection(event.direction);
    const assetHints = toArray(event.affected_assets);
    const sectorHints = toArray(event.affected_sectors);

    if (/fed|rate hike|tightening|hawkish|yield|inflation/.test(text)) {
      addEvidence(buckets, "inflationary", 0.9 * confidence, `macro:${event.event_type ?? event.title ?? "monetary_policy"}:inflationary`, ["TLT", "IEF", "XLF"]);
      addEvidence(buckets, "risk_off", 0.45 * confidence, `macro:${event.event_type ?? event.title ?? "monetary_policy"}:risk_off`, ["SPY", "QQQ"]);
    }
    if (/liquidity|repo|funding|cash|balance sheet|margin call/.test(text)) {
      addEvidence(buckets, "liquidity", 1.0 * confidence, `macro:${event.event_type ?? event.title ?? "liquidity"}:liquidity`, ["TLT", "IEF", "BIL"]);
      addEvidence(buckets, "crypto_liquidity_cycle", 0.55 * confidence, `macro:${event.event_type ?? event.title ?? "liquidity"}:crypto`, ["BTC", "ETH"]);
    }
    if (/ai|data center|gpu|compute|hyperscaler|capex/.test(text)) {
      addEvidence(buckets, "ai_capex", 1.0 * confidence, `macro:${event.event_type ?? event.title ?? "ai"}:ai_capex`, ["NVDA", "AMD", "ASML", "TSM"]);
      addEvidence(buckets, "semiconductor_cycle", 0.85 * confidence, `macro:${event.event_type ?? event.title ?? "ai"}:semiconductors`, ["SOXX", "SMH"]);
    }
    if (/china|sanction|tariff|export control|decoupling|war|conflict|fragmentation/.test(text)) {
      addEvidence(buckets, "geopolitical_fragmentation", 1.0 * confidence, `macro:${event.event_type ?? event.title ?? "geopolitics"}:fragmentation`, ["GLD", "LMT", "RTX"]);
      addEvidence(buckets, "risk_off", 0.45 * confidence, `macro:${event.event_type ?? event.title ?? "geopolitics"}:risk_off`, ["SPY", "QQQ"]);
    }
    if (/oil|gas|energy|opec|pipeline|refinery|lng/.test(text)) {
      addEvidence(buckets, "energy_stress", 1.0 * confidence, `macro:${event.event_type ?? event.title ?? "energy"}:energy_stress`, ["XLE", "XOM", "CVX", "COP"]);
      addEvidence(buckets, "inflationary", 0.55 * confidence, `macro:${event.event_type ?? event.title ?? "energy"}:inflationary`, ["TLT", "IEF"]);
    }
    if (/bank|credit|regional bank|deposit|loan loss|commercial real estate|cre|refinancing|lending/.test(text)) {
      addEvidence(buckets, "banking_stress", 1.0 * confidence, `macro:${event.event_type ?? event.title ?? "banking"}:banking_stress`, ["XLF", "KRE", "JPM", "BAC"]);
      addEvidence(buckets, "risk_off", 0.5 * confidence, `macro:${event.event_type ?? event.title ?? "banking"}:risk_off`, ["TLT", "IEF"]);
    }
    if (/semiconductor|chip|foundry|wafer|fab|memory|tsmc|asml/.test(text)) {
      addEvidence(buckets, "semiconductor_cycle", 1.0 * confidence, `macro:${event.event_type ?? event.title ?? "semis"}:semiconductor_cycle`, ["SOXX", "SMH", "NVDA", "AMD"]);
      addEvidence(buckets, "growth", 0.45 * confidence, `macro:${event.event_type ?? event.title ?? "semis"}:growth`, ["QQQ", "XLK"]);
    }
    if (/crypto|bitcoin|ethereum|stablecoin|blockchain|etf approval/.test(text)) {
      addEvidence(buckets, "crypto_liquidity_cycle", 1.0 * confidence, `macro:${event.event_type ?? event.title ?? "crypto"}:crypto_liquidity_cycle`, ["BTC", "ETH", "COIN", "MSTR"]);
      addEvidence(buckets, "liquidity", 0.4 * confidence, `macro:${event.event_type ?? event.title ?? "crypto"}:liquidity`, ["BTC", "ETH"]);
    }

    if (signal === "BUY") {
      addEvidence(buckets, "growth", 0.18 * confidence, `macro:${event.event_type ?? event.title ?? "generic"}:buy`, assetHints.length ? assetHints : sectorHints);
    } else if (signal === "SELL") {
      addEvidence(buckets, "risk_off", 0.18 * confidence, `macro:${event.event_type ?? event.title ?? "generic"}:sell`, assetHints.length ? assetHints : sectorHints);
    }

    for (const asset of assetHints) {
      addEvidence(buckets, "growth", 0.1 * confidence, `macro:${event.event_type ?? event.title ?? "asset"}:${asset}`, [asset]);
    }
    for (const sector of sectorHints) {
      if (normalizeText(sector).includes("financial")) addEvidence(buckets, "banking_stress", 0.08 * confidence, `macro:${event.event_type ?? event.title ?? "sector"}:${sector}`, []);
      if (normalizeText(sector).includes("technology") || normalizeText(sector).includes("semiconductor")) addEvidence(buckets, "semiconductor_cycle", 0.08 * confidence, `macro:${event.event_type ?? event.title ?? "sector"}:${sector}`, []);
    }
  }

  const portfolioSignals = input.portfolio_signals ?? [];
  for (const signal of portfolioSignals) {
    const asset = signal.asset.toString().trim().toUpperCase();
    if (!asset) continue;
    const confidence = clamp01(Number(signal.confidence) || 0.6);
    const weight = clamp01(Number(signal.weight) || 1);
    const normalizedSignal = normalizeDirection(signal.signal);
    const reason = `portfolio:${asset}:${normalizedSignal}`;

    if (["TLT", "IEF", "BND", "SHY", "BIL"].includes(asset)) {
      if (normalizedSignal === "BUY") addEvidence(buckets, "deflationary", confidence * weight, reason, [asset]);
      if (normalizedSignal === "SELL") addEvidence(buckets, "inflationary", confidence * weight, reason, [asset]);
    }
    if (["XLF", "KRE", "JPM", "BAC", "WFC", "C", "GS"].includes(asset)) {
      if (normalizedSignal === "SELL") addEvidence(buckets, "banking_stress", confidence * weight, reason, [asset]);
      if (normalizedSignal === "SELL") addEvidence(buckets, "risk_off", confidence * 0.45 * weight, reason, [asset]);
    }
    if (["NVDA", "AMD", "ASML", "TSM", "AMAT", "LRCX", "KLAC", "SOXX", "SMH", "QQQ", "XLK"].includes(asset)) {
      if (normalizedSignal === "BUY") addEvidence(buckets, "ai_capex", confidence * weight, reason, [asset]);
      if (normalizedSignal === "BUY") addEvidence(buckets, "semiconductor_cycle", confidence * 0.9 * weight, reason, [asset]);
      if (normalizedSignal === "BUY") addEvidence(buckets, "growth", confidence * 0.4 * weight, reason, [asset]);
    }
    if (["BTC", "ETH", "COIN", "MSTR", "BITO", "MARA"].includes(asset)) {
      if (normalizedSignal === "BUY") addEvidence(buckets, "crypto_liquidity_cycle", confidence * weight, reason, [asset]);
      if (normalizedSignal === "BUY") addEvidence(buckets, "liquidity", confidence * 0.4 * weight, reason, [asset]);
      if (normalizedSignal === "SELL") addEvidence(buckets, "risk_off", confidence * 0.35 * weight, reason, [asset]);
    }
    if (["XLE", "XOM", "CVX", "COP", "CL=F", "NG=F"].includes(asset)) {
      if (normalizedSignal === "BUY") addEvidence(buckets, "energy_stress", confidence * weight, reason, [asset]);
      if (normalizedSignal === "BUY") addEvidence(buckets, "inflationary", confidence * 0.4 * weight, reason, [asset]);
    }
  }

  const factorExposures = parseFactorExposures(input.factor_exposures);
  for (const [factor, exposureValue] of Object.entries(factorExposures)) {
    const exposure = Math.max(-3, Math.min(3, Number(exposureValue) || 0));
    const magnitude = Math.abs(exposure) / 3;
    if (magnitude <= 0) continue;

    if (factor.includes("liquidity")) {
      addEvidence(buckets, "liquidity", magnitude, `factor:${factor}:${exposure >= 0 ? "positive" : "negative"}`, ["TLT", "IEF"]);
      if (exposure < 0) addEvidence(buckets, "risk_off", magnitude * 0.55, `factor:${factor}:risk_off`, ["SPY", "QQQ"]);
    }
    if (factor.includes("inflation") || factor.includes("commodity")) {
      addEvidence(buckets, "inflationary", magnitude, `factor:${factor}:${exposure >= 0 ? "positive" : "negative"}`, ["TLT", "IEF", "XLE"]);
      if (exposure > 0) addEvidence(buckets, "energy_stress", magnitude * 0.45, `factor:${factor}:energy_stress`, ["XLE", "XOM"]);
    }
    if (factor.includes("growth") || factor.includes("capex") || factor.includes("innovation")) {
      addEvidence(buckets, "growth", magnitude, `factor:${factor}:${exposure >= 0 ? "positive" : "negative"}`, ["QQQ", "XLK"]);
      if (factor.includes("capex") || factor.includes("innovation")) addEvidence(buckets, "ai_capex", magnitude * 0.8, `factor:${factor}:ai_capex`, ["NVDA", "AMD"]);
    }
    if (factor.includes("risk") || factor.includes("sentiment")) {
      if (exposure < 0) addEvidence(buckets, "risk_off", magnitude, `factor:${factor}:risk_off`, ["SPY", "QQQ"]);
      if (exposure > 0) addEvidence(buckets, "growth", magnitude * 0.6, `factor:${factor}:growth`, ["SPY", "QQQ"]);
    }
    if (factor.includes("bank") || factor.includes("credit")) {
      if (exposure < 0) addEvidence(buckets, "banking_stress", magnitude, `factor:${factor}:banking_stress`, ["XLF", "KRE"]);
      if (exposure < 0) addEvidence(buckets, "risk_off", magnitude * 0.45, `factor:${factor}:risk_off`, ["TLT", "IEF"]);
    }
    if (factor.includes("semiconductor") || factor.includes("chip")) {
      addEvidence(buckets, "semiconductor_cycle", magnitude, `factor:${factor}:semiconductor_cycle`, ["SOXX", "SMH"]);
      addEvidence(buckets, "ai_capex", magnitude * 0.6, `factor:${factor}:ai_capex`, ["NVDA", "AMD"]);
    }
    if (factor.includes("crypto")) {
      addEvidence(buckets, "crypto_liquidity_cycle", magnitude, `factor:${factor}:crypto_liquidity_cycle`, ["BTC", "ETH"]);
      addEvidence(buckets, "liquidity", magnitude * 0.4, `factor:${factor}:liquidity`, ["BTC", "ETH"]);
    }
    if (factor.includes("geopolitical") || factor.includes("geo")) {
      addEvidence(buckets, "geopolitical_fragmentation", magnitude, `factor:${factor}:geopolitical_fragmentation`, ["GLD", "LMT"]);
      addEvidence(buckets, "risk_off", magnitude * 0.35, `factor:${factor}:risk_off`, ["SPY", "QQQ"]);
    }
  }

  const eventImpacts = input.event_impacts ?? [];
  for (const impact of eventImpacts) {
    const label = impact.label?.toString().trim() || impact.factor?.toString().trim() || impact.sector?.toString().trim() || impact.asset?.toString().trim() || "impact";
    const confidence = clamp01(Number(impact.confidence) || 0.6);
    const magnitude = clamp01(Math.abs(Number(impact.magnitude) || 0) / 3 + 0.2);
    const direction = normalizeDirection(impact.direction);
    const assets = impact.asset ? [impact.asset.toString().trim().toUpperCase()] : [];
    const sectors = impact.sector ? [impact.sector.toString().trim().toLowerCase()] : [];
    const factor = impact.factor?.toString().trim().toLowerCase() ?? "";
    const strength = confidence * magnitude;

    if (assets.some((asset) => ["NVDA", "AMD", "ASML", "TSM", "AMAT", "LRCX", "KLAC"].includes(asset)) || factor.includes("ai")) {
      addEvidence(buckets, "ai_capex", strength, `impact:${label}:ai_capex`, assets);
      addEvidence(buckets, "semiconductor_cycle", strength * 0.85, `impact:${label}:semiconductor_cycle`, assets);
    }
    if (assets.some((asset) => ["XLF", "KRE", "JPM", "BAC", "WFC", "C", "GS"].includes(asset)) || factor.includes("bank") || sectors.some((sector) => sector.includes("financial"))) {
      addEvidence(buckets, "banking_stress", strength, `impact:${label}:banking_stress`, assets);
      addEvidence(buckets, "risk_off", strength * 0.45, `impact:${label}:risk_off`, assets);
    }
    if (assets.some((asset) => ["XLE", "XOM", "CVX", "COP", "CL=F", "NG=F"].includes(asset)) || factor.includes("energy")) {
      addEvidence(buckets, "energy_stress", strength, `impact:${label}:energy_stress`, assets);
      addEvidence(buckets, "inflationary", strength * 0.35, `impact:${label}:inflationary`, assets);
    }
    if (assets.some((asset) => ["BTC", "ETH", "COIN", "MSTR"].includes(asset)) || factor.includes("crypto")) {
      addEvidence(buckets, "crypto_liquidity_cycle", strength, `impact:${label}:crypto_liquidity_cycle`, assets);
      addEvidence(buckets, "liquidity", strength * 0.4, `impact:${label}:liquidity`, assets);
    }
    if (assets.some((asset) => ["SOXX", "SMH", "NVDA", "AMD", "TSM", "ASML"].includes(asset)) || factor.includes("semiconductor")) {
      addEvidence(buckets, "semiconductor_cycle", strength, `impact:${label}:semiconductor_cycle`, assets);
      addEvidence(buckets, "ai_capex", strength * 0.55, `impact:${label}:ai_capex`, assets);
    }
    if (sectors.some((sector) => sector.includes("real estate") || sector.includes("reit"))) {
      addEvidence(buckets, "banking_stress", strength * 0.65, `impact:${label}:commercial_real_estate`, assets);
      addEvidence(buckets, "risk_off", strength * 0.35, `impact:${label}:risk_off`, assets);
    }

    if (direction === "BUY") {
      addEvidence(buckets, "growth", strength * 0.25, `impact:${label}:buy`, assets);
    } else if (direction === "SELL") {
      addEvidence(buckets, "risk_off", strength * 0.25, `impact:${label}:sell`, assets);
    }
  }

  const summary = buildRegimeSummaryFromBuckets(buckets, { minActiveScore: 0.5, maxActiveRegimes: 4 });
  const legacyRegime = mapExtendedToLegacy(summary.dominantRegime);
  const legacyScores: RegimeScores = {
    inflationary: buckets.inflationary.score + (summary.dominantRegime === "energy_stress" ? buckets.energy_stress.score * 0.3 : 0),
    risk_off: buckets.risk_off.score + buckets.geopolitical_fragmentation.score * 0.45 + buckets.banking_stress.score * 0.4,
    growth: buckets.growth.score + buckets.ai_capex.score * 0.45 + buckets.semiconductor_cycle.score * 0.35 + buckets.liquidity.score * 0.2,
    deflationary: buckets.deflationary.score + buckets.liquidity.score * 0.2,
  };
  const pickedLegacy = pickRegimeFromScores(legacyScores);

  return {
    active_regimes: summary.activeRegimes,
    dominant_regime: summary.dominantRegime,
    confidence: summary.confidence,
    supporting_signals: summary.supportingSignals,
    affected_assets: summary.affectedAssets,
    finalRegime: legacyRegime,
    smoothedRegime: null,
    adjustmentStrength: DEFAULT_REGIME_ADJUSTMENT,
    scores: summary.scoreMap,
    rejectReason: pickedLegacy.rejectReason,
    topScore: summary.topScore,
    secondScore: summary.secondScore,
  };
}

let lastDetectedRegime: MacroRegime | null = null;
let lastDetectedRegimeAt: number | null = null;
const recentRegimes: MacroRegime[] = [];
let fallbackRegimeStreak = 0;
let lastFallbackRegimeUsed: MacroRegime | null = null;

function addDetectedRegime(regime: MacroRegime | null): void {
  if (!regime) return;
  lastDetectedRegimeAt = Date.now();
  recentRegimes.push(regime);
  while (recentRegimes.length > REGIME_HISTORY_SIZE) recentRegimes.shift();
}

function checkFallbackExpiration(): void {
  if (lastDetectedRegimeAt === null) return;
  const ageMs = Date.now() - lastDetectedRegimeAt;
  if (ageMs > REGIME_FALLBACK_TTL_MS) {
    logEvent("REGIME_FALLBACK_EXPIRED", { ageMs, ttlMs: REGIME_FALLBACK_TTL_MS }, "WARN");
    lastDetectedRegime = null;
    lastDetectedRegimeAt = null;
    recentRegimes.length = 0;
    logEvent("REGIME_HISTORY_RESET", { reason: "fallback_ttl_exceeded" }, "INFO");
  }
}

function getSmoothedRegime(): MacroRegime | null {
  if (recentRegimes.length === 0) return null;

  const counts: Record<MacroRegime, number> = { inflationary: 0, risk_off: 0, growth: 0, deflationary: 0 };
  for (const regime of recentRegimes) counts[regime] += 1;

  const max = Math.max(counts.inflationary, counts.risk_off, counts.growth, counts.deflationary);
  const candidates = (Object.keys(counts) as MacroRegime[]).filter((regime) => counts[regime] === max);
  if (candidates.length === 1) return candidates[0];

  for (let index = recentRegimes.length - 1; index >= 0; index -= 1) {
    const regime = recentRegimes[index];
    if (candidates.includes(regime)) return regime;
  }

  return candidates[0] ?? null;
}

function getRegimeAdjustmentStrength(topScore: number, scores: RegimeScores): { confidence: number; strength: number } {
  const totalScore = Object.values(scores).reduce((sum, score) => sum + score, 0);
  const absoluteStrength = topScore / Math.max(0.000001, MAX_REGIME_SCORE);
  const relativeStrength = totalScore > 0 ? topScore / totalScore : 0;
  const confidence = Math.min(1, Math.max(0, absoluteStrength * relativeStrength));

  recordRegimeConfidence(confidence);
  logDebug("REGIME_CONFIDENCE_BREAKDOWN", { topScore, totalScore, absoluteStrength, relativeStrength, confidence });

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

  return { confidence, strength };
}

export function analyzeRegime(reasoning: unknown): {
  rawRegime: MacroRegime | null;
  finalRegime: MacroRegime;
  smoothedRegime: MacroRegime | null;
  confidence: number;
  adjustmentStrength: number;
  scores: Record<string, number>;
  rejectReason?: string | null;
  topScore?: number;
  secondScore?: number;
  active_regimes: ExtendedRegime[];
  dominant_regime: ExtendedRegime;
  supporting_signals: string[];
  affected_assets: string[];
} {
  checkFallbackExpiration();

  const { signals, rawRegime } = parseReasoning(reasoning);
  logDebug("REGIME_RAW_DETECTED", { rawRegime });

  const { regime: scoreRegime, topScore, secondScore, rejectReason, scores } = scoreRegimeSignals(signals);
  logDebug("REGIME_TOP_SCORE", { topScore });
  logDebug("REGIME_SECOND_SCORE", { secondScore });
  if (rejectReason) logWarn("REGIME_REJECT_REASON", { rejectReason });

  const maybeContext = (() => {
    if (!isRecord(reasoning)) return null;

    const eventClusters = Array.isArray(reasoning.event_clusters)
      ? (reasoning.event_clusters as RegimeEventClusterInput[])
      : Array.isArray(reasoning.clusters)
        ? (reasoning.clusters as RegimeEventClusterInput[])
        : [];
    const macroEvents = Array.isArray(reasoning.macro_events)
      ? (reasoning.macro_events as RegimeMacroEventInput[])
      : Array.isArray(reasoning.macroEvents)
        ? (reasoning.macroEvents as RegimeMacroEventInput[])
        : [];
    const portfolioSignals = Array.isArray(reasoning.portfolio_signals)
      ? (reasoning.portfolio_signals as RegimePortfolioSignalInput[])
      : Array.isArray(reasoning.portfolioSignals)
        ? (reasoning.portfolioSignals as RegimePortfolioSignalInput[])
        : [];
    const eventImpacts = Array.isArray(reasoning.event_impacts)
      ? (reasoning.event_impacts as RegimeEventImpactInput[])
      : Array.isArray(reasoning.eventImpacts)
        ? (reasoning.eventImpacts as RegimeEventImpactInput[])
        : [];
    const factorExposures =
      isRecord(reasoning.factor_exposures) || Array.isArray(reasoning.factor_exposures)
        ? (reasoning.factor_exposures as RegimeAnalysisInput["factor_exposures"])
        : isRecord(reasoning.factorExposures) || Array.isArray(reasoning.factorExposures)
          ? (reasoning.factorExposures as RegimeAnalysisInput["factor_exposures"])
          : undefined;

    if (
      eventClusters.length === 0 &&
      macroEvents.length === 0 &&
      portfolioSignals.length === 0 &&
      eventImpacts.length === 0 &&
      factorExposures === undefined &&
      signals.length === 0
    ) {
      return null;
    }

    const legacyPortfolioSignals: RegimePortfolioSignalInput[] = signals
      .map((signal) => ({
        asset: (signal.source_factor ?? "").toString().trim(),
        signal: normalizeSignal(signal.direction?.toString()),
        confidence: Number.isFinite(Number(signal.confidence)) ? Number(signal.confidence) : 0.6,
        weight: Number.isFinite(Number(signal.strength)) ? Number(signal.strength) : 1,
      }))
      .filter((signal) => signal.asset.length > 0);

    return {
      event_clusters: eventClusters,
      macro_events: macroEvents,
      portfolio_signals: [...portfolioSignals, ...legacyPortfolioSignals],
      event_impacts: eventImpacts,
      factor_exposures: factorExposures,
    } satisfies RegimeAnalysisInput;
  })();

  const extendedResult = maybeContext ? scoreExtendedRegimes(maybeContext) : null;

  const detectedRegime = scoreRegime ?? extendedResult?.finalRegime ?? null;

  if (rawRegime !== null) {
    if (detectedRegime) lastDetectedRegime = detectedRegime;
    addDetectedRegime(detectedRegime);
    logDebug("REGIME_HISTORY_CONFIRMED_ONLY", { regime: detectedRegime });
  }

  let fallbackRegime: MacroRegime | null = null;
  if (!detectedRegime) {
    fallbackRegime = lastDetectedRegime ?? DEFAULT_FALLBACK_REGIME;
    logDebug("REGIME_FALLBACK_USED", { fallbackRegime });

    if (fallbackRegime === lastFallbackRegimeUsed) {
      fallbackRegimeStreak += 1;
    } else {
      lastFallbackRegimeUsed = fallbackRegime;
      fallbackRegimeStreak = 1;
    }

    if (fallbackRegimeStreak >= 3) {
      logWarn("REGIME_FALLBACK_REPEATED", {
        fallbackRegime,
        streak: fallbackRegimeStreak,
        ttlMs: REGIME_FALLBACK_TTL_MS,
      });
    }
  } else {
    fallbackRegimeStreak = 0;
    lastFallbackRegimeUsed = null;
  }

  const smoothed = getSmoothedRegime();
  logDebug("REGIME_HISTORY", { history: recentRegimes });
  logDebug("REGIME_SMOOTHED", { smoothed });

  const finalRegime = (smoothed ?? detectedRegime ?? fallbackRegime ?? DEFAULT_FALLBACK_REGIME) as MacroRegime;
  logEvent("REGIME_FINAL_USED", { regime: finalRegime }, "INFO");

  const confidenceBasis = extendedResult?.topScore ?? topScore ?? 0;
  const confidenceScores = extendedResult?.scores ?? scores;
  const { confidence, strength } = getRegimeAdjustmentStrength(confidenceBasis, confidenceScores as RegimeScores);
  logDebug("REGIME_CONFIDENCE", { confidence });
  logDebug("REGIME_ADJUSTMENT_STRENGTH", { strength });

  return {
    rawRegime,
    finalRegime,
    smoothedRegime: smoothed ?? null,
    confidence,
    adjustmentStrength: strength,
    scores,
    rejectReason: rejectReason ?? null,
    topScore,
    secondScore,
    active_regimes: extendedResult?.active_regimes ?? (finalRegime ? [finalRegime] : []),
    dominant_regime: extendedResult?.dominant_regime ?? (finalRegime as ExtendedRegime),
    supporting_signals: extendedResult?.supporting_signals ?? [],
    affected_assets: extendedResult?.affected_assets ?? [],
  };
}
