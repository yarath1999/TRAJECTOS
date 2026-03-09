import { classifyEvent, type MacroEventType } from "@/engines/eventClassifier";

export type MacroEvent = {
  id: string;
  title: string;
  description: string;
  source: string;
  timestamp: number;
  category: string;
  geography?: string;
  industries?: string[];
};

export type UserProfile = {
  country?: string;
  industries?: string[];
  assetClasses?: string[];
};

export type RelevanceResult = {
  score: number;
  feedType: "impact" | "relevant" | "ignore";
};

const WEIGHTS = {
  macroImportance: 50,
  geographyMatch: 20,
  industryMatch: 20,
  assetClassMatch: 10,
} as const;

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizeList(values: string[] | undefined): string[] {
  if (!values) return [];
  return values.map((v) => normalize(v)).filter(Boolean);
}

function hasOverlap(a: string[] | undefined, b: string[] | undefined): boolean {
  const setA = new Set(normalizeList(a));
  if (setA.size === 0) return false;

  for (const item of normalizeList(b)) {
    if (setA.has(item)) return true;
  }

  return false;
}

function toMacroEventType(event: MacroEvent): MacroEventType | "industry" {
  // If the incoming event.category is already aligned with our taxonomy, use it.
  const category = normalize(event.category);
  const allowed: Array<MacroEventType | "industry"> = [
    "inflation",
    "interest_rate",
    "market",
    "tax",
    "policy",
    "unknown",
    "industry",
  ];

  // Treat "unknown" as a hint, but allow text-based detection/classification.
  if (allowed.includes(category as MacroEventType | "industry") && category !== "unknown") {
    return category as MacroEventType | "industry";
  }

  // Industry keyword detection (helps when category is missing/incorrect).
  const text = `${event.title} ${event.description} ${event.category}`.toLowerCase();
  const industryKeywords = [
    "technology",
    "tech",
    "software",
    "semiconductor",
    "chip",
    "chips",
    "banking",
    "finance",
    "fintech",
    "energy",
    "oil",
    "gas",
    "automotive",
    "manufacturing",
    "healthcare",
    "biotech",
    "pharma",
  ] as const;

  for (const keyword of industryKeywords) {
    if (text.includes(keyword)) {
      return "industry";
    }
  }

  // Fallback: classify from free text.
  return classifyEvent(`${event.title} ${event.description}`);
}

function macroImportanceScore(eventType: MacroEventType | "industry"): number {
  switch (eventType) {
    case "inflation":
      return 50;
    case "interest_rate":
      return 50;
    case "tax":
      return 40;
    case "market":
      return 30;
    case "industry":
      return 20;
    case "policy":
      return 20;
    case "unknown":
    default:
      return 10;
  }
}

function geographyScore(event: MacroEvent, user: UserProfile): number {
  const eventGeo = normalize(event.geography);
  const userCountry = normalize(user.country);

  // Exact match.
  if (eventGeo.length > 0 && userCountry.length > 0 && eventGeo === userCountry) {
    return WEIGHTS.geographyMatch;
  }

  // Treat explicit global markers (or missing geography) as broadly relevant.
  const isGlobal =
    eventGeo.length === 0 ||
    eventGeo === "global" ||
    eventGeo === "world" ||
    eventGeo === "international";

  if (isGlobal) {
    return 10;
  }

  return 0;
}

type AssetClass = "equities" | "bonds" | "crypto" | "commodities";

function inferAssetClasses(event: MacroEvent, eventType: MacroEventType | "industry"): AssetClass[] {
  const text = `${event.title} ${event.description} ${event.category}`.toLowerCase();
  const classes = new Set<AssetClass>();

  // Keyword heuristics.
  if (
    /(equity|equities|stock|stocks|share|shares|index|nifty|sensex|nasdaq|s\&p|dow)/i.test(
      text,
    )
  ) {
    classes.add("equities");
  }

  if (/(bond|bonds|yield|yields|treasury|gilt|gilts|debt|duration)/i.test(text)) {
    classes.add("bonds");
  }

  if (/(crypto|bitcoin|btc|ethereum|eth|token|altcoin|blockchain)/i.test(text)) {
    classes.add("crypto");
  }

  if (/(commodity|commodities|gold|silver|oil|crude|brent|wti|copper)/i.test(text)) {
    classes.add("commodities");
  }

  // Macro-type hints (kept conservative).
  if (eventType === "interest_rate") {
    classes.add("bonds");
  }
  if (eventType === "market") {
    classes.add("equities");
  }

  return Array.from(classes);
}

function assetClassScore(event: MacroEvent, user: UserProfile, eventType: MacroEventType | "industry"): number {
  const userAssets = new Set(normalizeList(user.assetClasses));
  if (userAssets.size === 0) return 0;

  const related = inferAssetClasses(event, eventType);
  for (const asset of related) {
    if (userAssets.has(asset)) {
      return WEIGHTS.assetClassMatch;
    }
  }

  return 0;
}

export function computeRelevance(event: MacroEvent, user: UserProfile): RelevanceResult {
  const eventType = toMacroEventType(event);

  const macroImportance = macroImportanceScore(eventType);
  const geo = geographyScore(event, user);
  const industry = hasOverlap(event.industries, user.industries)
    ? WEIGHTS.industryMatch
    : 0;
  const asset = assetClassScore(event, user, eventType);

  const hasGeographyMatch = geo > 0;
  const hasIndustryMatch = industry > 0;
  const hasAssetMatch = asset > 0;
  const hasRelevanceSignal = hasGeographyMatch || hasIndustryMatch || hasAssetMatch;

  const score = macroImportance + geo + industry + asset;

  const feedType: RelevanceResult["feedType"] =
    macroImportance >= 40 && hasRelevanceSignal
      ? "impact"
      : score >= 30
        ? "relevant"
        : "ignore";

  return { score, feedType };
}
