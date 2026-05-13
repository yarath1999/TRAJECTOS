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
  const raw = (value.regime ?? "").toString().trim().toLowerCase();
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
} {
  checkFallbackExpiration();

  const { signals, rawRegime } = parseReasoning(reasoning);
  logDebug("REGIME_RAW_DETECTED", { rawRegime });

  const { regime: scoreRegime, topScore, secondScore, rejectReason, scores } = scoreRegimeSignals(signals);
  logDebug("REGIME_TOP_SCORE", { topScore });
  logDebug("REGIME_SECOND_SCORE", { secondScore });
  if (rejectReason) logWarn("REGIME_REJECT_REASON", { rejectReason });

  const detectedRegime = scoreRegime;

  if (rawRegime !== null) {
    if (detectedRegime) lastDetectedRegime = detectedRegime;
    addDetectedRegime(detectedRegime);
    logEvent("REGIME_HISTORY_CONFIRMED_ONLY", { regime: detectedRegime }, "DEBUG");
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

  const { confidence, strength } = getRegimeAdjustmentStrength(topScore ?? 0, scores);
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
  };
}
