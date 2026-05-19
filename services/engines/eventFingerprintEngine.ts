import { createHash } from "node:crypto";
import { getCanonicalName } from "./entityResolutionEngine";

export interface EventFingerprintInput {
  title: string;
  summary?: string;
  source?: string;
  entities?: string[];
  event_type?: string;
  published_at?: string;
}

export interface EventFingerprintOutput {
  fingerprint: string;
  semanticSignature: string;
  duplicateProbability: number;
  normalizedTitle: string;
  keyEntities: string[];
  event_type?: string;
}

export interface EventFingerprintConfig {
  exactDuplicateThreshold: number;
  nearDuplicateThreshold: number;
  relatedEventThreshold: number;
  titleWeight: number;
  entityWeight: number;
  eventTypeWeight: number;
  temporalWeight: number;
  semanticWeight: number;
  syndicationBoost: number;
  rewriteMarkerBoost: number;
  maxTemporalGapHours: number;
}

export interface FingerprintComparison {
  similarity: number;
  duplicateProbability: number;
  relationship: "ExactDuplicate" | "NearDuplicate" | "RelatedEvent" | "Distinct";
  titleSimilarity: number;
  entityOverlap: number;
  eventTypeMatch: number;
  temporalProximity: number;
  semanticSignatureOverlap: number;
}

type FingerprintComparable = Partial<EventFingerprintInput> & Partial<EventFingerprintOutput>;

interface NormalizedFingerprintContext {
  title: string;
  summary: string;
  source: string;
  entities: string[];
  eventType?: string;
  publishedAt?: string;
  sourceFamily: string;
}

interface NormalizedComparisonContext {
  title: string;
  entities: string[];
  eventType?: string;
  publishedAtMs?: number;
  semanticSignature: string;
}

interface RegexReplacementRule {
  pattern: RegExp;
  replacement: string;
}

interface SourceNormalizationRule {
  pattern: RegExp;
  family: string;
  replacement?: string;
}

interface AliasRule {
  pattern: RegExp;
  canonical: string;
}

export const DEFAULT_EVENT_FINGERPRINT_CONFIG: EventFingerprintConfig = {
  exactDuplicateThreshold: 0.92,
  nearDuplicateThreshold: 0.78,
  relatedEventThreshold: 0.58,
  titleWeight: 0.34,
  entityWeight: 0.24,
  eventTypeWeight: 0.12,
  temporalWeight: 0.12,
  semanticWeight: 0.18,
  syndicationBoost: 0.18,
  rewriteMarkerBoost: 0.12,
  maxTemporalGapHours: 72,
};

const STOPWORDS = new Set([
  "the",
  "and",
  "or",
  "of",
  "for",
  "to",
  "in",
  "on",
  "at",
  "by",
  "with",
  "a",
  "an",
  "as",
  "from",
  "after",
  "before",
  "over",
  "under",
  "into",
  "about",
  "amid",
  "this",
  "that",
  "these",
  "those",
  "said",
  "says",
  "report",
  "reports",
  "reported",
  "update",
  "updates",
  "live",
  "analysis",
  "exclusive",
  "factbox",
  "briefing",
  "breaking",
]);

const SOURCE_RULES: SourceNormalizationRule[] = [
  { pattern: /\b(?:reuters|thomson reuters)\b/gi, family: "reuters", replacement: "" },
  { pattern: /\b(?:associated press|ap news|ap)\b/gi, family: "ap", replacement: "" },
  { pattern: /\b(?:bloomberg)\b/gi, family: "bloomberg", replacement: "" },
  { pattern: /\b(?:financial times|ft)\b/gi, family: "ft", replacement: "" },
  { pattern: /\b(?:wall street journal|wsj)\b/gi, family: "wsj", replacement: "" },
  { pattern: /\b(?:cnbc)\b/gi, family: "cnbc", replacement: "" },
  { pattern: /\b(?:marketwatch)\b/gi, family: "marketwatch", replacement: "" },
  { pattern: /\b(?:seeking alpha)\b/gi, family: "seeking_alpha", replacement: "" },
];

const FINANCIAL_SYNONYM_RULES: RegexReplacementRule[] = [
  { pattern: /\b(?:federal reserve|fed|fomc|frb)\b/gi, replacement: "federal reserve" },
  { pattern: /\b(?:european central bank|ecb)\b/gi, replacement: "european central bank" },
  { pattern: /\b(?:bank of england|boe)\b/gi, replacement: "bank of england" },
  { pattern: /\b(?:bank of japan|boj)\b/gi, replacement: "bank of japan" },
  { pattern: /\b(?:people'?s bank of china|pboc)\b/gi, replacement: "people s bank of china" },
  { pattern: /\b(?:treasury|us treasury|u s treasury|white house|congress)\b/gi, replacement: "united states government" },
  { pattern: /\b(?:nvidia|nvda)\b/gi, replacement: "nvidia" },
  { pattern: /\b(?:advanced micro devices|amd)\b/gi, replacement: "advanced micro devices" },
  { pattern: /\b(?:taiwan semiconductor manufacturing company|tsmc|taiwan semiconductor)\b/gi, replacement: "taiwan semiconductor manufacturing company" },
  { pattern: /\b(?:microsoft|msft)\b/gi, replacement: "microsoft" },
  { pattern: /\b(?:alphabet|google|googl)\b/gi, replacement: "alphabet" },
  { pattern: /\b(?:amazon|amzn|amazon com)\b/gi, replacement: "amazon" },
  { pattern: /\b(?:meta platforms|meta|facebook|fb)\b/gi, replacement: "meta platforms" },
  { pattern: /\b(?:apple|aapl)\b/gi, replacement: "apple" },
  { pattern: /\b(?:tesla|tsla)\b/gi, replacement: "tesla" },
  { pattern: /\b(?:bitcoin|btc|xbt)\b/gi, replacement: "bitcoin" },
  { pattern: /\b(?:ethereum|eth|ether)\b/gi, replacement: "ethereum" },
  { pattern: /\b(?:solana|sol)\b/gi, replacement: "solana" },
  { pattern: /\b(?:spdr s and p 500 etf trust|spy|s and p 500 etf|s p 500 etf)\b/gi, replacement: "spdr s p 500 etf trust" },
  { pattern: /\b(?:invesco qqq trust|qqq|nasdaq 100 etf)\b/gi, replacement: "invesco qqq trust" },
  { pattern: /\b(?:spdr gold shares|gld|gold etf)\b/gi, replacement: "spdr gold shares" },
  { pattern: /\b(?:energy select sector spdr fund|xle|energy etf)\b/gi, replacement: "energy select sector spdr fund" },
  { pattern: /\b(?:vaneck semiconductor etf|smh|semiconductor etf)\b/gi, replacement: "vaneck semiconductor etf" },
  { pattern: /\b(?:i shares semiconductor etf|soxx)\b/gi, replacement: "ishares semiconductor etf" },
  { pattern: /\b(?:open ai|openai)\b/gi, replacement: "openai" },
  { pattern: /\b(?:anthropic)\b/gi, replacement: "anthropic" },
  { pattern: /\b(?:core weave|coreweave)\b/gi, replacement: "coreweave" },
  { pattern: /\b(?:oil|crude|wti|brent)\b/gi, replacement: "crude oil" },
  { pattern: /\b(?:semis|semiconductor|chips|chipmakers)\b/gi, replacement: "semiconductors" },
  { pattern: /\b(?:ai capex|ai infrastructure|gpu cluster|data center)\b/gi, replacement: "artificial intelligence infrastructure" },
  { pattern: /\b(?:liquidity squeeze|funding stress|tight liquidity)\b/gi, replacement: "liquidity stress" },
  { pattern: /\b(?:geopolitical risk premium|trade fragmentation)\b/gi, replacement: "geopolitical fragmentation" },
  { pattern: /\b(?:crypto liquidity cycle|crypto cycle)\b/gi, replacement: "crypto liquidity cycle" },
];

const ENTITY_ALIAS_RULES: AliasRule[] = [
  { pattern: /\b(?:fed|u s fed|us fed|fomc|frb)\b/gi, canonical: "Federal Reserve" },
  { pattern: /\b(?:ecb|european central bank)\b/gi, canonical: "European Central Bank" },
  { pattern: /\b(?:boe|bank of england)\b/gi, canonical: "Bank of England" },
  { pattern: /\b(?:boj|bank of japan)\b/gi, canonical: "Bank of Japan" },
  { pattern: /\b(?:pboc|people'?s bank of china)\b/gi, canonical: "People's Bank of China" },
  { pattern: /\b(?:nvda|nvidia|nvidia corp|nvidia corporation)\b/gi, canonical: "NVIDIA" },
  { pattern: /\b(?:amd|advanced micro devices)\b/gi, canonical: "Advanced Micro Devices" },
  { pattern: /\b(?:tsmc|taiwan semiconductor manufacturing company|taiwan semiconductor)\b/gi, canonical: "Taiwan Semiconductor Manufacturing Company" },
  { pattern: /\b(?:microsoft|msft)\b/gi, canonical: "Microsoft" },
  { pattern: /\b(?:alphabet|google|googl)\b/gi, canonical: "Alphabet" },
  { pattern: /\b(?:amazon|amzn)\b/gi, canonical: "Amazon" },
  { pattern: /\b(?:meta|facebook|meta platforms)\b/gi, canonical: "Meta Platforms" },
  { pattern: /\b(?:apple|aapl)\b/gi, canonical: "Apple" },
  { pattern: /\b(?:tesla|tsla)\b/gi, canonical: "Tesla" },
  { pattern: /\b(?:bitcoin|btc|xbt)\b/gi, canonical: "Bitcoin" },
  { pattern: /\b(?:ethereum|eth|ether)\b/gi, canonical: "Ethereum" },
  { pattern: /\b(?:solana|sol)\b/gi, canonical: "Solana" },
  { pattern: /\b(?:spy|spdr s p 500 etf trust|s and p 500 etf)\b/gi, canonical: "SPDR S&P 500 ETF Trust" },
  { pattern: /\b(?:qqq|invesco qqq trust|nasdaq 100 etf)\b/gi, canonical: "Invesco QQQ Trust" },
  { pattern: /\b(?:gld|spdr gold shares|gold etf)\b/gi, canonical: "SPDR Gold Shares" },
  { pattern: /\b(?:xle|energy select sector spdr fund|energy etf)\b/gi, canonical: "Energy Select Sector SPDR Fund" },
  { pattern: /\b(?:smh|van eck semiconductor etf|vaneck semiconductor etf|semiconductor etf)\b/gi, canonical: "VanEck Semiconductor ETF" },
  { pattern: /\b(?:soxx|ishares semiconductor etf)\b/gi, canonical: "iShares Semiconductor ETF" },
  { pattern: /\b(?:openai|open ai)\b/gi, canonical: "OpenAI" },
  { pattern: /\b(?:anthropic)\b/gi, canonical: "Anthropic" },
  { pattern: /\b(?:coreweave|core weave)\b/gi, canonical: "CoreWeave" },
  { pattern: /\b(?:united states government|us treasury|u s treasury|treasury|white house|congress)\b/gi, canonical: "United States Government" },
  { pattern: /\b(?:european union|eu commission|european commission)\b/gi, canonical: "European Union" },
  { pattern: /\b(?:china|prc|people'?s republic of china)\b/gi, canonical: "China" },
  { pattern: /\b(?:united states|usa|u s|u s a|america)\b/gi, canonical: "United States" },
  { pattern: /\b(?:uk|u k|britain|great britain|united kingdom)\b/gi, canonical: "United Kingdom" },
  { pattern: /\b(?:japan|nippon)\b/gi, canonical: "Japan" },
  { pattern: /\b(?:taiwan|roc|republic of china)\b/gi, canonical: "Taiwan" },
  { pattern: /\b(?:south korea|republic of korea|korea)\b/gi, canonical: "South Korea" },
  { pattern: /\b(?:saudi arabia|ksa)\b/gi, canonical: "Saudi Arabia" },
  { pattern: /\b(?:russia|russian federation)\b/gi, canonical: "Russia" },
  { pattern: /\b(?:ukraine)\b/gi, canonical: "Ukraine" },
  { pattern: /\b(?:israel)\b/gi, canonical: "Israel" },
  { pattern: /\b(?:nvidia|amd|tsmc|microsoft|alphabet|amazon|meta platforms|apple|tesla|bitcoin|ethereum|solana|spy|qqq|gld|xle|smh|soxx)\b/gi, canonical: "" },
];

const EVENT_MARKERS = [
  "rate hike",
  "rate cut",
  "earnings beat",
  "earnings miss",
  "supply disruption",
  "sanctions",
  "war escalation",
  "export controls",
  "guidance cut",
  "guidance raise",
];

const SYNONYM_LOOKUP = new Map<string, string>([
  ["ai", "artificial intelligence"],
  ["a.i.", "artificial intelligence"],
  ["semis", "semiconductors"],
  ["chipmakers", "semiconductors"],
  ["chips", "semiconductors"],
  ["bond market", "rates"],
  ["yield curve", "rates"],
  ["cash market", "liquidity"],
  ["digital asset", "crypto"],
  ["digital assets", "crypto"],
  ["stable coin", "stablecoin"],
  ["us treasury", "united states government"],
  ["u.s. treasury", "united states government"],
  ["fed", "federal reserve"],
  ["fomc", "federal reserve"],
  ["ecb", "european central bank"],
  ["boe", "bank of england"],
  ["boj", "bank of japan"],
  ["pboc", "people s bank of china"],
]);

const REWRITE_MARKERS = new Set([
  "update",
  "live",
  "analysis",
  "exclusive",
  "factbox",
  "briefing",
  "explainer",
  "breaking",
  "dealbook",
  "top news",
]);

function clamp(min: number, value: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripDiacritics(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

function normalizePunctuation(value: string): string {
  return value.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
}

function normalizeTickerToken(token: string): string {
  const cleaned = token.replace(/^\$/, "").replace(/\.(?:US|U|L|TO|DE|HK|MI|PA|SW)$/i, "");
  return cleaned.toUpperCase().trim();
}

function isLikelyTicker(token: string): boolean {
  return /^[A-Z]{1,6}$/.test(token) && !STOPWORDS.has(token.toLowerCase());
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) => left.localeCompare(right));
}

function tokenize(value: string): string[] {
  return normalizeWhitespace(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

function normalizeEventType(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = normalizeFinancialLanguage(value);
  return normalized || undefined;
}

function normalizeSourceFamily(source?: string): string {
  if (!source) {
    return "unknown";
  }

  const normalized = normalizeWhitespace(stripDiacritics(normalizePunctuation(source)).toLowerCase());
  for (const rule of SOURCE_RULES) {
    if (rule.pattern.test(normalized)) {
      return rule.family;
    }
  }

  if (normalized.includes("reuters")) return "reuters";
  if (normalized.includes("associated press") || normalized === "ap") return "ap";
  if (normalized.includes("bloomberg")) return "bloomberg";
  if (normalized.includes("financial times") || normalized === "ft") return "ft";
  if (normalized.includes("wall street journal") || normalized === "wsj") return "wsj";
  return normalized.replace(/[^a-z0-9]+/g, "_") || "unknown";
}

function removeSourceAttribution(value: string): { text: string; sourceFamily: string } {
  let text = value;
  let sourceFamily = "unknown";

  for (const rule of SOURCE_RULES) {
    if (rule.pattern.test(text)) {
      sourceFamily = rule.family;
      text = text.replace(rule.pattern, rule.replacement ?? " ");
    }
  }

  text = text
    .replace(/^\s*(?:reuters|ap|associated press|bloomberg|financial times|ft|wsj|wall street journal)\s*[-:–—]\s*/i, "")
    .replace(/\s*[-:–—]\s*(?:reuters|ap|associated press|bloomberg|financial times|ft|wsj|wall street journal)\s*$/i, "")
    .replace(/\b(?:update|live|analysis|exclusive|factbox|briefing|explainer|breaking)\b[:\s-]*/gi, " ");

  return { text: text.trim(), sourceFamily };
}

function applyReplacementRules(value: string, rules: RegexReplacementRule[]): string {
  let result = value;
  for (const rule of rules) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

function applyAliasRules(value: string): string {
  let result = value;
  for (const rule of ENTITY_ALIAS_RULES) {
    result = result.replace(rule.pattern, rule.canonical);
  }
  return result;
}

function applyTickerReplacement(value: string): string {
  return value.replace(/\$?[A-Za-z]{1,6}(?:[.:][A-Za-z]{1,4})?/g, (match) => {
    const normalizedTicker = normalizeTickerToken(match);
    if (!isLikelyTicker(normalizedTicker)) {
      return match;
    }

    const canonical = getCanonicalName(normalizedTicker);
    return canonical ?? match;
  });
}

function normalizeTokenStream(value: string): string {
  const normalized = stripDiacritics(normalizePunctuation(value)).toLowerCase();
  const tokens = normalized
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));

  return normalizeWhitespace(tokens.join(" "));
}

export function normalizeFinancialLanguage(value: string): string {
  if (!value) {
    return "";
  }

  let text = stripDiacritics(normalizePunctuation(value));
  text = text.replace(/\b(?:rth|rts|reuters)\s*[:\-]\s*/gi, " ");
  text = removeSourceAttribution(text).text;
  text = applyTickerReplacement(text);
  text = applyAliasRules(text);
  text = applyReplacementRules(text, FINANCIAL_SYNONYM_RULES);
  text = text.toLowerCase();
  text = text.replace(/[^a-z0-9\s]/g, " ");
  text = normalizeWhitespace(text);

  const tokens = text
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));

  const canonicalTokens = tokens.map((token) => {
    const synonym = SYNONYM_LOOKUP.get(token) ?? token;
    return synonym;
  });

  return normalizeWhitespace(canonicalTokens.join(" "));
}

function normalizeComparableText(value: string): string {
  return normalizeTokenStream(normalizeFinancialLanguage(value));
}

function textSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeComparableText(left);
  const normalizedRight = normalizeComparableText(right);

  if (!normalizedLeft || !normalizedRight) {
    return 0;
  }

  if (normalizedLeft === normalizedRight) {
    return 1;
  }

  const leftTokens = new Set(normalizedLeft.split(" "));
  const rightTokens = new Set(normalizedRight.split(" "));

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  const tokenUnion = new Set([...leftTokens, ...rightTokens]).size;
  const tokenScore = tokenUnion > 0 ? overlap / tokenUnion : 0;

  const compactLeft = normalizedLeft.replace(/\s+/g, "");
  const compactRight = normalizedRight.replace(/\s+/g, "");
  const minLength = Math.min(compactLeft.length, compactRight.length);
  let prefixScore = 0;
  if (minLength > 0) {
    let prefixLength = 0;
    while (prefixLength < minLength && compactLeft[prefixLength] === compactRight[prefixLength]) {
      prefixLength += 1;
    }
    prefixScore = prefixLength / minLength;
  }

  return clamp(0, tokenScore * 0.7 + prefixScore * 0.3, 1);
}

function temporalProximityScore(left?: string, right?: string, maxTemporalGapHours = DEFAULT_EVENT_FINGERPRINT_CONFIG.maxTemporalGapHours): number {
  if (!left || !right) {
    return 0.5;
  }

  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs) || !Number.isFinite(rightMs)) {
    return 0.5;
  }

  const hoursApart = Math.abs(leftMs - rightMs) / (60 * 60 * 1000);
  if (hoursApart <= 0) {
    return 1;
  }

  return clamp(0, 1 - hoursApart / maxTemporalGapHours, 1);
}

function buildCanonicalEntitySet(entities: string[] | undefined): string[] {
  if (!entities || entities.length === 0) {
    return [];
  }

  const resolved: string[] = [];
  for (const entity of entities) {
    const raw = normalizeWhitespace(entity).trim();
    if (!raw) {
      continue;
    }

    const canonical = getCanonicalName(raw) ?? getCanonicalName(normalizeFinancialLanguage(raw)) ?? raw;
    if (canonical) {
      resolved.push(canonical);
    }
  }

  return uniqueSorted(resolved);
}

function extractTickers(text: string): string[] {
  const matches = text.match(/\b\$?[A-Za-z]{1,6}(?:[.:][A-Za-z]{1,4})?\b/g) ?? [];
  const tickers: string[] = [];

  for (const match of matches) {
    const token = normalizeTickerToken(match);
    if (!isLikelyTicker(token)) {
      continue;
    }

    const canonical = getCanonicalName(token);
    if (canonical) {
      tickers.push(canonical);
    }
  }

  return tickers;
}

function findAliasEntities(text: string): string[] {
  const found: string[] = [];
  for (const rule of ENTITY_ALIAS_RULES) {
    const canonical = rule.canonical;
    if (!canonical) {
      continue;
    }

    if (rule.pattern.test(text)) {
      found.push(canonical);
    }
  }

  return found;
}

function removeDuplicateEntities(entities: string[]): string[] {
  return uniqueSorted(
    entities
      .map((entity) => normalizeWhitespace(entity))
      .filter((entity) => entity.length > 0),
  );
}

export function extractKeyEntities(input: Pick<EventFingerprintInput, "title" | "summary" | "entities">): string[] {
  const combinedText = [input.title, input.summary ?? ""].filter(Boolean).join(" ");
  const normalizedText = normalizePunctuation(stripDiacritics(combinedText));

  const candidates = [
    ...buildCanonicalEntitySet(input.entities),
    ...extractTickers(normalizedText),
    ...findAliasEntities(normalizedText),
  ];

  return removeDuplicateEntities(candidates);
}

function estimateDuplicateRisk(context: NormalizedFingerprintContext): number {
  let risk = 0.12;

  if (context.sourceFamily === "reuters" || context.sourceFamily === "ap") {
    risk += DEFAULT_EVENT_FINGERPRINT_CONFIG.syndicationBoost;
  }

  if (context.sourceFamily === "bloomberg" || context.sourceFamily === "ft" || context.sourceFamily === "wsj") {
    risk += 0.07;
  }

  const rewriteMarkerCount = [...REWRITE_MARKERS].reduce((count, marker) => {
    const markerRegex = new RegExp(`\\b${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
    return count + (markerRegex.test(context.title) || markerRegex.test(context.summary) ? 1 : 0);
  }, 0);

  risk += Math.min(0.22, rewriteMarkerCount * DEFAULT_EVENT_FINGERPRINT_CONFIG.rewriteMarkerBoost);

  const titleTokens = tokenize(context.title);
  if (titleTokens.length <= 4) {
    risk += 0.12;
  } else if (titleTokens.length <= 7) {
    risk += 0.06;
  }

  if (context.entities.length > 0) {
    risk += Math.min(0.08, context.entities.length * 0.02);
  }

  if (!context.eventType) {
    risk += 0.04;
  }

  if (context.title === context.summary && context.summary.length > 0) {
    risk += 0.05;
  }

  return clamp(0, risk, 0.98);
}

function normalizeFingerprintContext(input: EventFingerprintInput): NormalizedFingerprintContext {
  const sourceInfo = removeSourceAttribution(input.source ?? "");
  const sourceFamily = sourceInfo.sourceFamily !== "unknown" ? sourceInfo.sourceFamily : normalizeSourceFamily(input.source);

  const title = normalizeFinancialLanguage(input.title);
  const summary = normalizeFinancialLanguage(input.summary ?? "");
  const entities = extractKeyEntities(input);
  const eventType = normalizeEventType(input.event_type);

  return {
    title,
    summary,
    source: normalizeWhitespace(input.source ?? ""),
    entities,
    eventType,
    publishedAt: input.published_at,
    sourceFamily,
  };
}

function buildSemanticSignature(context: NormalizedFingerprintContext): string {
  const entityPart = context.entities.join("|");
  const summaryPart = context.summary || "";
  const titlePart = context.title || "";
  const eventTypePart = context.eventType ?? "unknown";

  const combinedText =
    `${titlePart} ${summaryPart}`.toLowerCase();

  const detectedMarkers = EVENT_MARKERS.filter(
    (marker) => combinedText.includes(marker)
  );

  return [
    "event-fingerprint:v1",
    `type=${eventTypePart}`,
    `title=${titlePart}`,
    `summary=${summaryPart}`,
    `entities=${entityPart}`,
    `markers=${detectedMarkers.join(",")}`,
  ].join("|");
}

function hashSignature(signature: string): string {
  return createHash("sha256").update(signature).digest("hex");
}

function toComparisonContext(value: FingerprintComparable): NormalizedComparisonContext {
  const normalizedTitle = normalizeFinancialLanguage(value.normalizedTitle ?? value.title ?? "");
  const resolvedEntities = value.keyEntities?.length ? uniqueSorted(value.keyEntities) : extractKeyEntities({ title: value.title ?? value.normalizedTitle ?? "", summary: value.summary, entities: value.entities });
  const eventType = normalizeEventType(value.event_type);
  const semanticSignature = value.semanticSignature ?? buildSemanticSignature({
    title: normalizedTitle,
    summary: normalizeFinancialLanguage(value.summary ?? ""),
    source: normalizeWhitespace(value.source ?? ""),
    entities: resolvedEntities,
    eventType,
    publishedAt: value.published_at,
    sourceFamily: normalizeSourceFamily(value.source),
  });

  return {
    title: normalizedTitle,
    entities: resolvedEntities,
    eventType,
    publishedAtMs: value.published_at ? Date.parse(value.published_at) : undefined,
    semanticSignature,
  };
}

function entityOverlapScore(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let overlap = 0;

  for (const entity of leftSet) {
    if (rightSet.has(entity)) {
      overlap += 1;
    }
  }

  const union = new Set([...leftSet, ...rightSet]).size;
  return union > 0 ? overlap / union : 0;
}

function semanticOverlapScore(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }

  return textSimilarity(left, right);
}

function scoreComparison(left: NormalizedComparisonContext, right: NormalizedComparisonContext, config: EventFingerprintConfig): FingerprintComparison {
  const titleSimilarity = textSimilarity(left.title, right.title);
  const entityOverlap = entityOverlapScore(left.entities, right.entities);
  const eventTypeMatch = left.eventType && right.eventType && left.eventType === right.eventType ? 1 : 0;
  const temporalProximity = temporalProximityScore(
    left.publishedAtMs ? new Date(left.publishedAtMs).toISOString() : undefined,
    right.publishedAtMs ? new Date(right.publishedAtMs).toISOString() : undefined,
    config.maxTemporalGapHours,
  );
  const semanticSignatureOverlap = semanticOverlapScore(left.semanticSignature, right.semanticSignature);

  const similarity = clamp(
    0,
    titleSimilarity * config.titleWeight +
      entityOverlap * config.entityWeight +
      eventTypeMatch * config.eventTypeWeight +
      temporalProximity * config.temporalWeight +
      semanticSignatureOverlap * config.semanticWeight,
    1,
  );

  return {
    similarity,
    duplicateProbability: similarity,
    relationship:
      similarity >= config.exactDuplicateThreshold
        ? "ExactDuplicate"
        : similarity >= config.nearDuplicateThreshold
          ? "NearDuplicate"
          : similarity >= config.relatedEventThreshold
            ? "RelatedEvent"
            : "Distinct",
    titleSimilarity,
    entityOverlap,
    eventTypeMatch,
    temporalProximity,
    semanticSignatureOverlap,
  };
}

export function compareFingerprints(
  left: FingerprintComparable,
  right: FingerprintComparable,
  config: Partial<EventFingerprintConfig> = {},
): FingerprintComparison {
  const mergedConfig = { ...DEFAULT_EVENT_FINGERPRINT_CONFIG, ...config };
  const leftContext = toComparisonContext(left);
  const rightContext = toComparisonContext(right);
  return scoreComparison(leftContext, rightContext, mergedConfig);
}

export function computeDuplicateProbability(
  left: FingerprintComparable,
  right: FingerprintComparable,
  config: Partial<EventFingerprintConfig> = {},
): number {
  return compareFingerprints(left, right, config).duplicateProbability;
}

export function createFingerprint(
  input: EventFingerprintInput,
  config: Partial<EventFingerprintConfig> = {},
): EventFingerprintOutput {
  const mergedConfig = { ...DEFAULT_EVENT_FINGERPRINT_CONFIG, ...config };
  const normalized = normalizeFingerprintContext(input);
  const semanticSignature = buildSemanticSignature(normalized);
  const fingerprint = hashSignature(semanticSignature);
  const duplicateProbability = estimateDuplicateRisk(normalized);

  return {
    fingerprint,
    semanticSignature,
    duplicateProbability: clamp(0, duplicateProbability, 1),
    normalizedTitle: normalized.title,
    keyEntities: normalized.entities,
    event_type: normalized.eventType,
  };
}

export function getFingerprintRelationship(
  left: FingerprintComparable,
  right: FingerprintComparable,
  config: Partial<EventFingerprintConfig> = {},
): FingerprintComparison["relationship"] {
  return compareFingerprints(left, right, config).relationship;
}

export function getFingerprintThresholds(config: Partial<EventFingerprintConfig> = {}): EventFingerprintConfig {
  return { ...DEFAULT_EVENT_FINGERPRINT_CONFIG, ...config };
}
