/**
 * Entity Resolution Engine
 *
 * Deterministically resolves aliases, abbreviations, tickers, and naming
 * variants into canonical institutional entities.
 *
 * Design goals:
 * - deterministic matching only
 * - no AI calls
 * - alias dictionaries and ticker registries
 * - fuzzy normalization with bounded confidence scoring
 * - duplicate prevention across canonical identities
 */

export interface EntityMention {
  raw: string;
  context?: string;
}

export interface CanonicalEntity {
  canonical_name: string;
  entity_type:
    | "Company"
    | "CentralBank"
    | "Government"
    | "Commodity"
    | "Cryptocurrency"
    | "ETF"
    | "Index"
    | "Sector"
    | "Country"
    | "Person"
    | "Technology"
    | "Narrative";
  aliases: string[];
  ticker?: string;
  confidence: number;
}

interface EntitySeed {
  canonical_name: string;
  entity_type: CanonicalEntity["entity_type"];
  aliases: string[];
  ticker?: string;
  confidence?: number;
  context_keywords?: string[];
}

interface EntityRecord extends CanonicalEntity {
  normalized_aliases: string[];
  normalized_context_keywords: string[];
}

type MatchKind = "exact_alias" | "ticker" | "partial" | "contextual" | "fuzzy";

interface EntityMatch {
  canonical_name: string;
  score: number;
  kind: MatchKind;
  matched_alias?: string;
  source?: string;
}

const CORPORATE_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "corp",
  "corporation",
  "co",
  "company",
  "ltd",
  "limited",
  "plc",
  "group",
  "holdings",
  "holding",
  "sa",
  "ag",
  "nv",
  "lp",
  "llc",
]);

const STOPWORDS = new Set([
  "the",
  "and",
  "of",
  "for",
  "to",
  "a",
  "an",
  "company",
  "corp",
  "inc",
  "incorporated",
  "group",
  "holding",
  "holdings",
  "co",
  "ltd",
  "limited",
  "plc",
]);

const EXCHANGE_SUFFIXES = new Set(["US", "U", "N", "O", "L", "TO", "DE", "HK", "MI", "PA", "SW"]);

export const canonicalEntityRegistry = new Map<string, EntityRecord>();
export const aliasRegistry = new Map<string, string>();
export const tickerRegistry = new Map<string, string>();
export const canonicalAliasRegistry = new Map<string, Set<string>>();
export const canonicalTickerRegistry = new Map<string, string>();

const ENTITY_PRIORITY: Record<CanonicalEntity["entity_type"], number> = {
  CentralBank: 10,
  Government: 9,
  Country: 8,
  Company: 7,
  ETF: 7,
  Index: 7,
  Cryptocurrency: 6,
  Commodity: 6,
  Sector: 5,
  Technology: 5,
  Narrative: 4,
  Person: 3,
};

const BUILTIN_ENTITIES: EntitySeed[] = [
  {
    canonical_name: "Federal Reserve",
    entity_type: "CentralBank",
    aliases: ["Fed", "US Fed", "U.S. Fed", "Federal Reserve System", "FOMC", "FRB", "Fed Board"],
    context_keywords: ["rates", "inflation", "policy", "powell", "fomc", "balance sheet", "liquidity"],
  },
  {
    canonical_name: "European Central Bank",
    entity_type: "CentralBank",
    aliases: ["ECB", "Euro Central Bank", "EU Central Bank", "European Central Bank"],
    context_keywords: ["rates", "inflation", "lagarde", "euro", "policy", "deposit rate"],
  },
  {
    canonical_name: "Bank of England",
    entity_type: "CentralBank",
    aliases: ["BoE", "BOE", "UK Central Bank", "Bank of England"],
    context_keywords: ["rates", "inflation", "bailey", "pound", "policy"],
  },
  {
    canonical_name: "Bank of Japan",
    entity_type: "CentralBank",
    aliases: ["BoJ", "BOJ", "Japan Central Bank", "Bank of Japan"],
    context_keywords: ["rates", "yen", "policy", "ueda", "yield curve control"],
  },
  {
    canonical_name: "People's Bank of China",
    entity_type: "CentralBank",
    aliases: ["PBoC", "PBOC", "China Central Bank", "People's Bank of China"],
    context_keywords: ["yuan", "liquidity", "policy", "reserve requirement", "prc"],
  },
  {
    canonical_name: "Reserve Bank of Australia",
    entity_type: "CentralBank",
    aliases: ["RBA", "Reserve Bank of Australia"],
    context_keywords: ["australia", "rates", "inflation", "policy"],
  },
  {
    canonical_name: "Swiss National Bank",
    entity_type: "CentralBank",
    aliases: ["SNB", "Swiss National Bank"],
    context_keywords: ["switzerland", "rates", "franc", "policy"],
  },
  {
    canonical_name: "Bank of Canada",
    entity_type: "CentralBank",
    aliases: ["BoC", "BOC", "Bank of Canada"],
    context_keywords: ["canada", "rates", "inflation", "policy"],
  },
  {
    canonical_name: "United States Government",
    entity_type: "Government",
    aliases: ["U.S. Government", "US Government", "United States Government", "US Treasury", "U.S. Treasury", "Treasury", "White House"],
    context_keywords: ["treasury", "fiscal", "debt", "congress", "administration", "washington"],
  },
  {
    canonical_name: "European Union",
    entity_type: "Government",
    aliases: ["EU", "European Union", "European Commission", "EU Commission"],
    context_keywords: ["brussels", "regulation", "policy", "union"],
  },
  {
    canonical_name: "China",
    entity_type: "Country",
    aliases: ["PRC", "People's Republic of China", "Mainland China"],
    context_keywords: ["beijing", "yuan", "tariffs", "exports", "policy"],
  },
  {
    canonical_name: "United States",
    entity_type: "Country",
    aliases: ["U.S.", "US", "USA", "America", "United States of America"],
    context_keywords: ["washington", "treasury", "fed", "dollar"],
  },
  { canonical_name: "Japan", entity_type: "Country", aliases: ["Nippon"], context_keywords: ["yen", "boj", "tokyo"] },
  { canonical_name: "Taiwan", entity_type: "Country", aliases: ["ROC", "Republic of China (Taiwan)"], context_keywords: ["tsmc", "taipei", "semiconductors"] },
  { canonical_name: "South Korea", entity_type: "Country", aliases: ["Korea", "Republic of Korea"], context_keywords: ["seoul", "semiconductors", "exports"] },
  { canonical_name: "United Kingdom", entity_type: "Country", aliases: ["UK", "Britain", "Great Britain", "U.K."], context_keywords: ["london", "boe", "pound"] },
  { canonical_name: "Germany", entity_type: "Country", aliases: ["Federal Republic of Germany"], context_keywords: ["euro", "europe", "berlin"] },
  { canonical_name: "France", entity_type: "Country", aliases: ["French Republic"], context_keywords: ["paris", "europe"] },
  { canonical_name: "Russia", entity_type: "Country", aliases: ["Russian Federation"], context_keywords: ["moscow", "sanctions", "war"] },
  { canonical_name: "Ukraine", entity_type: "Country", aliases: ["Ukrainian State"], context_keywords: ["kyiv", "war", "sanctions"] },
  { canonical_name: "Israel", entity_type: "Country", aliases: ["State of Israel"], context_keywords: ["jerusalem", "gaza", "security"] },
  { canonical_name: "Saudi Arabia", entity_type: "Country", aliases: ["KSA", "Kingdom of Saudi Arabia"], context_keywords: ["riyadh", "opec", "oil"] },
  { canonical_name: "NVIDIA", entity_type: "Company", ticker: "NVDA", aliases: ["Nvidia", "NVIDIA Corp", "NVIDIA Corporation", "Nvidia Corp", "NVDA"], context_keywords: ["gpu", "ai", "chips", "datacenter", "semiconductor"] },
  { canonical_name: "Advanced Micro Devices", entity_type: "Company", ticker: "AMD", aliases: ["AMD", "Advanced Micro Devices Inc", "Advanced Micro Devices"], context_keywords: ["gpu", "cpu", "semiconductor", "ai"] },
  { canonical_name: "Taiwan Semiconductor Manufacturing Company", entity_type: "Company", ticker: "TSM", aliases: ["TSMC", "Taiwan Semiconductor", "Taiwan Semiconductor Manufacturing", "Taiwan Semiconductor Manufacturing Company Limited"], context_keywords: ["foundry", "wafer", "chip manufacturing", "semiconductor"] },
  { canonical_name: "ASML", entity_type: "Company", ticker: "ASML", aliases: ["ASML Holding", "ASML Holding NV"], context_keywords: ["lithography", "semiconductor", "euV", "chips"] },
  { canonical_name: "Intel", entity_type: "Company", ticker: "INTC", aliases: ["Intel Corp", "Intel Corporation"], context_keywords: ["chip", "foundry", "semiconductor"] },
  { canonical_name: "Broadcom", entity_type: "Company", ticker: "AVGO", aliases: ["Broadcom Inc", "AVGO"], context_keywords: ["networking", "semiconductor", "ai"] },
  { canonical_name: "Micron Technology", entity_type: "Company", ticker: "MU", aliases: ["Micron", "Micron Technology Inc"], context_keywords: ["memory", "dram", "nand", "semiconductor"] },
  { canonical_name: "Qualcomm", entity_type: "Company", ticker: "QCOM", aliases: ["Qualcomm Inc", "Qualcomm Incorporated"], context_keywords: ["wireless", "chips", "semiconductor"] },
  { canonical_name: "Applied Materials", entity_type: "Company", ticker: "AMAT", aliases: ["Applied Materials Inc", "AMAT"], context_keywords: ["wafer", "equipment", "semiconductor"] },
  { canonical_name: "Lam Research", entity_type: "Company", ticker: "LRCX", aliases: ["Lam Research Corp"], context_keywords: ["etch", "fab", "semiconductor equipment"] },
  { canonical_name: "KLA", entity_type: "Company", ticker: "KLAC", aliases: ["KLA Corporation", "KLA Corp"], context_keywords: ["inspection", "metrology", "semiconductor"] },
  { canonical_name: "Super Micro Computer", entity_type: "Company", ticker: "SMCI", aliases: ["Supermicro", "Super Micro", "Super Micro Computer Inc"], context_keywords: ["servers", "ai infrastructure", "compute"] },
  { canonical_name: "Microsoft", entity_type: "Company", ticker: "MSFT", aliases: ["MSFT", "Microsoft Corp", "Microsoft Corporation"], context_keywords: ["cloud", "azure", "ai", "software"] },
  { canonical_name: "Alphabet", entity_type: "Company", ticker: "GOOGL", aliases: ["Google", "Google parent", "Alphabet Inc", "GOOGL"], context_keywords: ["cloud", "ai", "search", "ads"] },
  { canonical_name: "Amazon", entity_type: "Company", ticker: "AMZN", aliases: ["Amazon.com", "Amazon.com Inc"], context_keywords: ["cloud", "aws", "ai", "retail"] },
  { canonical_name: "Oracle", entity_type: "Company", ticker: "ORCL", aliases: ["Oracle Corp", "Oracle Corporation"], context_keywords: ["cloud", "database", "ai"] },
  { canonical_name: "Meta Platforms", entity_type: "Company", ticker: "META", aliases: ["Meta", "Facebook", "Meta Platforms Inc"], context_keywords: ["social", "ai", "ads"] },
  { canonical_name: "Apple", entity_type: "Company", ticker: "AAPL", aliases: ["Apple Inc", "AAPL"], context_keywords: ["devices", "consumer electronics", "chips"] },
  { canonical_name: "Tesla", entity_type: "Company", ticker: "TSLA", aliases: ["Tesla Inc", "Tesla Motors"], context_keywords: ["ev", "autos", "energy storage"] },
  { canonical_name: "OpenAI", entity_type: "Technology", aliases: ["Open AI"], context_keywords: ["chatgpt", "llm", "model", "ai"] },
  { canonical_name: "Anthropic", entity_type: "Technology", aliases: ["Anthropic PBC"], context_keywords: ["claude", "model", "ai"] },
  { canonical_name: "CoreWeave", entity_type: "Technology", aliases: ["Core Weave"], context_keywords: ["gpu cloud", "ai infrastructure", "compute"] },
  { canonical_name: "Exxon Mobil", entity_type: "Company", ticker: "XOM", aliases: ["Exxon", "ExxonMobil", "Exxon Mobil Corp"], context_keywords: ["oil", "energy", "upstream"] },
  { canonical_name: "Chevron", entity_type: "Company", ticker: "CVX", aliases: ["Chevron Corp", "Chevron Corporation"], context_keywords: ["oil", "energy", "upstream"] },
  { canonical_name: "Shell", entity_type: "Company", ticker: "SHEL", aliases: ["Shell PLC", "Royal Dutch Shell", "Shell plc"], context_keywords: ["oil", "lng", "energy"] },
  { canonical_name: "BP", entity_type: "Company", ticker: "BP", aliases: ["BP plc", "British Petroleum"], context_keywords: ["oil", "energy", "refining"] },
  { canonical_name: "ConocoPhillips", entity_type: "Company", ticker: "COP", aliases: ["Conoco", "ConocoPhillips Inc"], context_keywords: ["oil", "energy", "upstream"] },
  { canonical_name: "Occidental Petroleum", entity_type: "Company", ticker: "OXY", aliases: ["Occidental", "Occidental Petroleum Corp"], context_keywords: ["oil", "energy", "carbon capture"] },
  { canonical_name: "NextEra Energy", entity_type: "Company", ticker: "NEE", aliases: ["NextEra", "NextEra Energy Inc"], context_keywords: ["utilities", "power", "energy"] },
  { canonical_name: "SPDR S&P 500 ETF Trust", entity_type: "ETF", ticker: "SPY", aliases: ["SPY", "S&P 500 ETF", "S&P 500 Trust ETF"], context_keywords: ["equities", "market", "index"] },
  { canonical_name: "Invesco QQQ Trust", entity_type: "ETF", ticker: "QQQ", aliases: ["QQQ", "Nasdaq 100 ETF", "QQQ Trust"], context_keywords: ["nasdaq", "technology", "growth"] },
  { canonical_name: "VanEck Semiconductor ETF", entity_type: "ETF", ticker: "SMH", aliases: ["SMH", "Semiconductor ETF"], context_keywords: ["chips", "semiconductor"] },
  { canonical_name: "iShares Semiconductor ETF", entity_type: "ETF", ticker: "SOXX", aliases: ["SOXX"], context_keywords: ["chips", "semiconductor"] },
  { canonical_name: "Energy Select Sector SPDR Fund", entity_type: "ETF", ticker: "XLE", aliases: ["XLE", "Energy ETF"], context_keywords: ["energy", "oil", "gas"] },
  { canonical_name: "Technology Select Sector SPDR Fund", entity_type: "ETF", ticker: "XLK", aliases: ["XLK", "Tech ETF"], context_keywords: ["technology", "software", "ai"] },
  { canonical_name: "SPDR Gold Shares", entity_type: "ETF", ticker: "GLD", aliases: ["GLD", "Gold ETF"], context_keywords: ["gold", "precious metals"] },
  { canonical_name: "iShares Bitcoin Trust", entity_type: "ETF", ticker: "IBIT", aliases: ["IBIT", "Bitcoin ETF"], context_keywords: ["bitcoin", "crypto"] },
  { canonical_name: "S&P 500", entity_type: "Index", aliases: ["SPX", "SP500", "S&P500", "S and P 500", "Standard & Poor's 500"], context_keywords: ["equities", "market", "index"] },
  { canonical_name: "Nasdaq 100", entity_type: "Index", aliases: ["NDX", "NASDAQ-100", "Nasdaq100"], context_keywords: ["technology", "growth", "index"] },
  { canonical_name: "Philadelphia Semiconductor Index", entity_type: "Index", aliases: ["SOX", "PHLX Semiconductor Index", "Semiconductor Index"], context_keywords: ["chips", "semiconductor"] },
  { canonical_name: "Russell 2000", entity_type: "Index", aliases: ["RUT", "Russell2000"], context_keywords: ["small caps", "equities"] },
  { canonical_name: "VIX", entity_type: "Index", aliases: ["Cboe Volatility Index", "Volatility Index"], context_keywords: ["volatility", "risk", "equity markets"] },
  { canonical_name: "Gold", entity_type: "Commodity", aliases: ["XAU", "Gold Spot"], context_keywords: ["safe haven", "inflation", "precious metals"] },
  { canonical_name: "Silver", entity_type: "Commodity", aliases: ["XAG", "Silver Spot"], context_keywords: ["precious metals"] },
  { canonical_name: "Copper", entity_type: "Commodity", aliases: ["LME Copper"], context_keywords: ["industrial metal", "china", "growth"] },
  { canonical_name: "WTI Crude", entity_type: "Commodity", aliases: ["WTI", "West Texas Intermediate", "Light Sweet Crude"], context_keywords: ["oil", "energy", "crude"] },
  { canonical_name: "Brent Crude", entity_type: "Commodity", aliases: ["Brent", "Brent Oil"], context_keywords: ["oil", "energy", "crude"] },
  { canonical_name: "Natural Gas", entity_type: "Commodity", aliases: ["Nat Gas", "NG", "Henry Hub Gas"], context_keywords: ["energy", "utility", "lng"] },
  { canonical_name: "Bitcoin", entity_type: "Cryptocurrency", ticker: "BTC", aliases: ["BTC", "Bitcoin", "XBT"], context_keywords: ["crypto", "digital asset", "blockchain"] },
  { canonical_name: "Ethereum", entity_type: "Cryptocurrency", ticker: "ETH", aliases: ["ETH", "Ether", "Ethereum Network"], context_keywords: ["crypto", "smart contracts", "blockchain"] },
  { canonical_name: "Solana", entity_type: "Cryptocurrency", ticker: "SOL", aliases: ["SOL", "Solana Network"], context_keywords: ["crypto", "blockchain"] },
  { canonical_name: "XRP", entity_type: "Cryptocurrency", aliases: ["Ripple", "Ripple XRP"], context_keywords: ["crypto", "payments"] },
  { canonical_name: "USDC", entity_type: "Cryptocurrency", aliases: ["USD Coin", "Circle USDC"], context_keywords: ["stablecoin", "crypto", "payments"] },
  { canonical_name: "Semiconductor", entity_type: "Sector", aliases: ["Semiconductors", "Chip Sector", "Chipmakers"], context_keywords: ["chips", "foundry", "ai"] },
  { canonical_name: "Artificial Intelligence", entity_type: "Narrative", aliases: ["AI", "Artificial Intelligence", "AI CapEx", "AI Capex", "AI Infrastructure"], context_keywords: ["compute", "model training", "gpu", "datacenter"] },
  { canonical_name: "Liquidity Tightening", entity_type: "Narrative", aliases: ["Liquidity Squeeze", "Funding Stress", "Tight Liquidity"], context_keywords: ["repo", "funding", "cash", "margin"] },
  { canonical_name: "Energy Stress", entity_type: "Narrative", aliases: ["Energy Supply Stress", "Oil Shock"], context_keywords: ["oil", "gas", "opec", "supply"] },
  { canonical_name: "Geopolitical Fragmentation", entity_type: "Narrative", aliases: ["Fragmentation", "Trade Fragmentation", "Geopolitical Risk Premium"], context_keywords: ["sanctions", "trade", "tariffs", "conflict"] },
  { canonical_name: "Semiconductor Cycle", entity_type: "Narrative", aliases: ["Chip Cycle", "Semis Cycle"], context_keywords: ["inventory", "foundry", "fabs", "orders"] },
  { canonical_name: "Crypto Liquidity Cycle", entity_type: "Narrative", aliases: ["Crypto Cycle", "Digital Asset Liquidity Cycle"], context_keywords: ["bitcoin", "stablecoin", "exchange flows", "funding"] },
  { canonical_name: "Banking Stress", entity_type: "Narrative", aliases: ["Bank Stress", "Credit Stress Narrative"], context_keywords: ["deposits", "loan losses", "credit", "funding"] },
  { canonical_name: "Jerome Powell", entity_type: "Person", aliases: ["Powell", "Chair Powell"], context_keywords: ["fed", "rates", "fomc"] },
  { canonical_name: "Christine Lagarde", entity_type: "Person", aliases: ["Lagarde"], context_keywords: ["ecb", "rates", "policy"] },
  { canonical_name: "Kazuo Ueda", entity_type: "Person", aliases: ["Ueda"], context_keywords: ["boj", "yen", "rates"] },
  { canonical_name: "Andrew Bailey", entity_type: "Person", aliases: ["Bailey"], context_keywords: ["boe", "rates", "inflation"] },
  { canonical_name: "Janet Yellen", entity_type: "Person", aliases: ["Yellen"], context_keywords: ["treasury", "fiscal", "debt"] },
  { canonical_name: "Xi Jinping", entity_type: "Person", aliases: ["Xi"], context_keywords: ["china", "policy", "beijing"] },
];

function clamp(min: number, value: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function uniqueSorted(values: string[]): string[] {
  return Array.from(new Set(values)).sort((left, right) => left.localeCompare(right));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripDiacritics(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

export function normalizeEntityText(value: string): string {
  if (!value) {
    return "";
  }

  return normalizeWhitespace(
    stripDiacritics(value)
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\b(u\.?s\.?|u\.?k\.?|u\.?e\.?|p\.?r\.?c\.?)\b/g, (match) => match.replace(/\./g, "")),
  );
}

function normalizeCompactText(value: string): string {
  return normalizeEntityText(value).replace(/\s+/g, "");
}

function normalizeTickerText(value: string): string {
  const trimmed = stripDiacritics(value).toUpperCase().trim().replace(/^\$/, "");
  if (!trimmed) {
    return "";
  }

  const decorated = trimmed.match(/^([A-Z]{1,6})(?:[.:]([A-Z]{1,4}))?$/);
  if (!decorated) {
    return trimmed.replace(/[^A-Z0-9]/g, "");
  }

  const [, symbol, suffix] = decorated;
  if (suffix && EXCHANGE_SUFFIXES.has(suffix)) {
    return symbol;
  }

  return suffix ? `${symbol}.${suffix}` : symbol;
}

function tokenizeEntityText(value: string): string[] {
  return normalizeEntityText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

function detectTickerTokens(text: string): string[] {
  const matches = text.match(/\b\$?[A-Za-z]{1,6}(?:[.:][A-Za-z]{1,4})?\b/g) ?? [];
  const normalized: string[] = [];

  for (const match of matches) {
    const ticker = normalizeTickerText(match);
    if (ticker) {
      normalized.push(ticker);
    }
  }

  return uniqueSorted(normalized);
}

function canonicalizeAlias(alias: string): string {
  const normalized = normalizeEntityText(alias);
  const tokens = normalized.split(" ").filter(Boolean);
  while (tokens.length > 1 && CORPORATE_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(" ");
}

function bigramSimilarity(left: string, right: string): number {
  const cleanLeft = normalizeCompactText(left);
  const cleanRight = normalizeCompactText(right);

  if (!cleanLeft || !cleanRight) {
    return 0;
  }

  if (cleanLeft === cleanRight) {
    return 1;
  }

  if (cleanLeft.length === 1 || cleanRight.length === 1) {
    return cleanLeft === cleanRight ? 1 : 0;
  }

  const leftBigrams = new Map<string, number>();
  const rightBigrams = new Map<string, number>();

  for (let index = 0; index < cleanLeft.length - 1; index += 1) {
    const gram = cleanLeft.slice(index, index + 2);
    leftBigrams.set(gram, (leftBigrams.get(gram) ?? 0) + 1);
  }

  for (let index = 0; index < cleanRight.length - 1; index += 1) {
    const gram = cleanRight.slice(index, index + 2);
    rightBigrams.set(gram, (rightBigrams.get(gram) ?? 0) + 1);
  }

  let overlap = 0;
  for (const [gram, count] of leftBigrams.entries()) {
    overlap += Math.min(count, rightBigrams.get(gram) ?? 0);
  }

  const total = (cleanLeft.length - 1) + (cleanRight.length - 1);
  return total > 0 ? clamp(0, (2 * overlap) / total, 1) : 0;
}

function jaccardSimilarity(left: string, right: string): number {
  const leftTokens = new Set(tokenizeEntityText(left));
  const rightTokens = new Set(tokenizeEntityText(right));

  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union > 0 ? intersection / union : 0;
}

function buildContextText(mention: EntityMention): string {
  return normalizeEntityText([mention.raw, mention.context ?? ""].filter(Boolean).join(" "));
}

function createCanonicalRecord(seed: EntitySeed): EntityRecord {
  return {
    canonical_name: seed.canonical_name,
    entity_type: seed.entity_type,
    aliases: uniqueSorted([seed.canonical_name, ...seed.aliases]),
    ticker: seed.ticker ? normalizeTickerText(seed.ticker) : undefined,
    confidence: clamp(0, seed.confidence ?? 0.92, 1),
    normalized_aliases: uniqueSorted([seed.canonical_name, ...seed.aliases].map((alias) => canonicalizeAlias(alias)).filter(Boolean)),
    normalized_context_keywords: uniqueSorted((seed.context_keywords ?? []).map((keyword) => normalizeEntityText(keyword)).filter(Boolean)),
  };
}

function ensureCanonicalRecord(seed: EntitySeed): EntityRecord {
  const existing = canonicalEntityRegistry.get(seed.canonical_name);
  if (existing) {
    return existing;
  }

  const record = createCanonicalRecord(seed);
  canonicalEntityRegistry.set(record.canonical_name, record);
  canonicalAliasRegistry.set(record.canonical_name, new Set(record.normalized_aliases));

  if (record.ticker) {
    canonicalTickerRegistry.set(record.canonical_name, record.ticker);
  }

  return record;
}

function registerAliasVariant(record: EntityRecord, alias: string): void {
  const normalizedAlias = canonicalizeAlias(alias);
  if (!normalizedAlias) {
    return;
  }

  const existingCanonical = aliasRegistry.get(normalizedAlias);
  if (existingCanonical && existingCanonical !== record.canonical_name) {
    const existingRecord = canonicalEntityRegistry.get(existingCanonical);
    if (existingRecord) {
      const existingPriority = ENTITY_PRIORITY[existingRecord.entity_type];
      const incomingPriority = ENTITY_PRIORITY[record.entity_type];
      if (incomingPriority < existingPriority) {
        return;
      }
      if (incomingPriority === existingPriority && existingRecord.confidence >= record.confidence) {
        return;
      }
    }
  }

  aliasRegistry.set(normalizedAlias, record.canonical_name);
  const canonicalAliases = canonicalAliasRegistry.get(record.canonical_name) ?? new Set<string>();
  canonicalAliases.add(normalizedAlias);
  canonicalAliasRegistry.set(record.canonical_name, canonicalAliases);

  if (!record.aliases.some((existingAlias) => canonicalizeAlias(existingAlias) === normalizedAlias)) {
    record.aliases = uniqueSorted([...record.aliases, alias.trim()].filter(Boolean));
  }
}

function registerTickerVariants(record: EntityRecord, ticker?: string): void {
  const normalizedTicker = ticker ? normalizeTickerText(ticker) : undefined;
  if (!normalizedTicker) {
    return;
  }

  tickerRegistry.set(normalizedTicker, record.canonical_name);
  canonicalTickerRegistry.set(record.canonical_name, normalizedTicker);

  const suffixStripped = normalizedTicker.replace(/\.[A-Z0-9]+$/, "");
  if (suffixStripped && suffixStripped !== normalizedTicker) {
    tickerRegistry.set(suffixStripped, record.canonical_name);
  }
}

function registerSeed(seed: EntitySeed): CanonicalEntity {
  const record = ensureCanonicalRecord(seed);

  registerAliasVariant(record, record.canonical_name);
  for (const alias of seed.aliases) {
    registerAliasVariant(record, alias);
  }

  registerTickerVariants(record, seed.ticker);
  return toCanonicalEntity(record);
}

function toCanonicalEntity(record: EntityRecord): CanonicalEntity {
  return {
    canonical_name: record.canonical_name,
    entity_type: record.entity_type,
    aliases: uniqueSorted(record.aliases),
    ticker: record.ticker,
    confidence: clamp(0, record.confidence, 1),
  };
}

function getContextScore(contextText: string, record: EntityRecord): number {
  if (!contextText) {
    return 0;
  }

  const contextTokens = new Set(tokenizeEntityText(contextText));
  let keywordHits = 0;

  for (const keyword of record.normalized_context_keywords) {
    const keywordTokens = keyword.split(" ").filter(Boolean);
    if (keywordTokens.length === 0) {
      continue;
    }

    const allPresent = keywordTokens.every((token) => contextTokens.has(token));
    const anyPresent = keywordTokens.some((token) => contextTokens.has(token));

    if (allPresent) {
      keywordHits += 2;
    } else if (anyPresent) {
      keywordHits += 1;
    }
  }

  const density = record.normalized_context_keywords.length > 0 ? keywordHits / (record.normalized_context_keywords.length * 2) : 0;
  return clamp(0, density, 1);
}

function scoreCandidate(
  record: EntityRecord,
  mentionText: string,
  normalizedMention: string,
  compactMention: string,
  contextText: string,
): EntityMatch | null {
  const canonicalNormalized = canonicalizeAlias(record.canonical_name);
  const aliasSet = canonicalAliasRegistry.get(record.canonical_name) ?? new Set<string>(record.normalized_aliases);
  const tickerTokens = detectTickerTokens(mentionText);

  let best: EntityMatch | null = null;

  if (record.ticker) {
    const normalizedTicker = normalizeTickerText(record.ticker);
    const tickerMatch = tickerTokens.includes(normalizedTicker) || normalizeTickerText(mentionText) === normalizedTicker;
    if (tickerMatch) {
      best = {
        canonical_name: record.canonical_name,
        score: clamp(0, 0.94 + record.confidence * 0.04, 0.99),
        kind: "ticker",
        matched_alias: normalizedTicker,
        source: "ticker_registry",
      };
    }
  }

  for (const alias of aliasSet) {
    if (!alias) {
      continue;
    }

    if (normalizedMention === alias || compactMention === normalizeCompactText(alias)) {
      const score = clamp(0, 0.97 + record.confidence * 0.03, 0.995);
      return {
        canonical_name: record.canonical_name,
        score,
        kind: "exact_alias",
        matched_alias: alias,
        source: "alias_registry",
      };
    }
  }

if (
  canonicalNormalized &&
  (
    normalizedMention.includes(canonicalNormalized) ||
    canonicalNormalized.includes(normalizedMention)
  )
) {
  const similarity = compareEntitySimilarity(
    mentionText,
    record.canonical_name
  );

  let score = clamp(
    0,
    0.82 + similarity * 0.16 + record.confidence * 0.02,
    0.96
  );

  const financialTerms = [
    "stock",
    "shares",
    "earnings",
    "market",
    "guidance",
    "etf",
    "bond",
    "yield",
    "chip",
    "semiconductor",
    "rates",
    "inflation",
  ];

  const lowerContext = contextText.toLowerCase();

  const hasFinancialContext =
    financialTerms.some((t) =>
      lowerContext.includes(t)
    );

  if (
    score > 0.8 &&
    !hasFinancialContext
  ) {
    score *= 0.72;
  }

  best = chooseBetterMatch(best, {
    canonical_name: record.canonical_name,
    score,
    kind: "partial",
    matched_alias: record.canonical_name,
    source: "canonical_partial_match",
  });
}

  for (const alias of aliasSet) {
    if (!alias) {
      continue;
    }

    const aliasCompact = normalizeCompactText(alias);
    if (!aliasCompact) {
      continue;
    }

    if (compactMention === aliasCompact || aliasCompact.includes(compactMention) || compactMention.includes(aliasCompact)) {
      const similarity = compareEntitySimilarity(mentionText, alias);
      let score = clamp(
  0,
  0.8 + similarity * 0.15 + record.confidence * 0.03,
  0.95
);

const financialTerms = [
  "stock",
  "shares",
  "earnings",
  "market",
  "guidance",
  "etf",
  "bond",
  "yield",
  "chip",
  "semiconductor",
  "rates",
  "inflation",
];

const lowerContext = contextText.toLowerCase();

const hasFinancialContext =
  financialTerms.some((t) =>
    lowerContext.includes(t)
  );

if (
  score > 0.8 &&
  !hasFinancialContext
) {
  score *= 0.72;
}
      best = chooseBetterMatch(best, {
        canonical_name: record.canonical_name,
        score,
        kind: "partial",
        matched_alias: alias,
        source: "alias_partial_match",
      });
    }

    const similarity = compareEntitySimilarity(mentionText, alias);
    if (similarity >= 0.72) {
      const score = clamp(0, 0.6 + similarity * 0.3 + record.confidence * 0.05, 0.9);
      best = chooseBetterMatch(best, {
        canonical_name: record.canonical_name,
        score,
        kind: "fuzzy",
        matched_alias: alias,
        source: "fuzzy_similarity",
      });
    }
  }

  const contextScore = getContextScore(contextText, record);
  if (contextScore > 0) {
    const contextualScore = clamp(0, 0.76 + contextScore * 0.18 + record.confidence * 0.04, 0.96);
    best = chooseBetterMatch(best, {
      canonical_name: record.canonical_name,
      score: contextualScore,
      kind: "contextual",
      matched_alias: record.canonical_name,
      source: "contextual_keywords",
    });
  }

  return best;
}

function chooseBetterMatch(current: EntityMatch | null, candidate: EntityMatch): EntityMatch {
  if (!current) {
    return candidate;
  }

  if (candidate.score !== current.score) {
    return candidate.score > current.score ? candidate : current;
  }

  const currentPriority = ENTITY_PRIORITY[canonicalEntityRegistry.get(current.canonical_name)?.entity_type ?? "Narrative"];
  const candidatePriority = ENTITY_PRIORITY[canonicalEntityRegistry.get(candidate.canonical_name)?.entity_type ?? "Narrative"];

  if (candidatePriority !== currentPriority) {
    return candidatePriority > currentPriority ? candidate : current;
  }

  return candidate.canonical_name.localeCompare(current.canonical_name) < 0 ? candidate : current;
}

function resolveBestMatch(mention: EntityMention): EntityMatch | null {
  const rawText = normalizeEntityText(mention.raw);
  const contextText = buildContextText(mention);
  const compactMention = normalizeCompactText(mention.raw);

  if (!rawText && !contextText) {
    return null;
  }

  const normalizedTicker = normalizeTickerText(mention.raw);
  const tickerCanonical = tickerRegistry.get(normalizedTicker);
  if (tickerCanonical) {
    const record = canonicalEntityRegistry.get(tickerCanonical);
    if (record) {
      return {
        canonical_name: record.canonical_name,
        score: clamp(0, 0.95 + record.confidence * 0.03, 0.99),
        kind: "ticker",
        matched_alias: normalizedTicker,
        source: "ticker_registry",
      };
    }
  }

  const exactCanonical = aliasRegistry.get(rawText) ?? aliasRegistry.get(canonicalizeAlias(mention.raw));
  if (exactCanonical) {
    const record = canonicalEntityRegistry.get(exactCanonical);
    if (record) {
      return {
        canonical_name: record.canonical_name,
        score: clamp(0, 0.98 + record.confidence * 0.02, 0.995),
        kind: "exact_alias",
        matched_alias: rawText,
        source: "alias_registry",
      };
    }
  }

  let best: EntityMatch | null = null;
  for (const record of canonicalEntityRegistry.values()) {
    const candidate = scoreCandidate(record, mention.raw, rawText, compactMention, contextText);
    if (!candidate) {
      continue;
    }

    best = chooseBetterMatch(best, candidate);
  }

  if (!best) {
    return null;
  }

  const resolvedRecord = canonicalEntityRegistry.get(best.canonical_name);
  if (!resolvedRecord) {
    return null;
  }

  const finalConfidence = clamp(0, best.score * 0.9 + resolvedRecord.confidence * 0.1, 1);
  return {
    ...best,
    score: finalConfidence,
  };
}

function mergeResolvedEntities(left: CanonicalEntity, right: CanonicalEntity): CanonicalEntity {
  const aliasSet = new Set<string>([...left.aliases, ...right.aliases]);
  return {
    canonical_name: left.canonical_name,
    entity_type: left.entity_type,
    aliases: uniqueSorted(Array.from(aliasSet)),
    ticker: left.ticker ?? right.ticker,
    confidence: Math.max(left.confidence, right.confidence),
  };
}

function hasDuplicateAlias(canonicalName: string, alias: string): boolean {
  const normalizedAlias = canonicalizeAlias(alias);
  const aliases = canonicalAliasRegistry.get(canonicalName);
  return !!aliases && aliases.has(normalizedAlias);
}

export function registerAlias(
  canonical_name: string,
  alias: string,
  entity_type: CanonicalEntity["entity_type"],
  ticker?: string,
  confidence = 0.92,
): CanonicalEntity {
  const seed: EntitySeed = {
    canonical_name: canonical_name.trim(),
    entity_type,
    aliases: [alias.trim()],
    ticker,
    confidence,
  };

  const record = ensureCanonicalRecord(seed);
  if (ticker) {
    registerTickerVariants(record, ticker);
  }

  registerAliasVariant(record, canonical_name);
  registerAliasVariant(record, alias);
  return toCanonicalEntity(record);
}

export function getCanonicalName(raw: string, context?: string): string | null {
  const resolved = resolveEntity({ raw, context });
  return resolved?.canonical_name ?? null;
}

export function compareEntitySimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeEntityText(left);
  const normalizedRight = normalizeEntityText(right);

  if (!normalizedLeft || !normalizedRight) {
    return 0;
  }

  if (normalizedLeft === normalizedRight) {
    return 1;
  }

  const tokenScore = jaccardSimilarity(normalizedLeft, normalizedRight);
  const charScore = bigramSimilarity(normalizedLeft, normalizedRight);
  const compactLeft = normalizeCompactText(normalizedLeft);
  const compactRight = normalizeCompactText(normalizedRight);

  if (compactLeft === compactRight) {
    return 1;
  }

  const containmentScore =
    compactLeft.includes(compactRight) || compactRight.includes(compactLeft)
      ? 0.9
      : 0;

  return clamp(0, tokenScore * 0.45 + charScore * 0.4 + containmentScore * 0.15, 1);
}

export function resolveEntity(mention: EntityMention | string): CanonicalEntity | null {
  const normalizedMention = typeof mention === "string" ? { raw: mention } : mention;
  const best = resolveBestMatch(normalizedMention);
  if (!best) {
    return null;
  }

  const record = canonicalEntityRegistry.get(best.canonical_name);
  if (!record) {
    return null;
  }

  const result = toCanonicalEntity(record);
  return {
    ...result,
    confidence: clamp(0, best.score, 1),
  };
}

export function resolveEntities(mentions: Array<EntityMention | string>): CanonicalEntity[] {
  const resolved = new Map<string, CanonicalEntity>();

  for (const mention of mentions) {
    const entity = resolveEntity(mention);
    if (!entity) {
      continue;
    }

    const existing = resolved.get(entity.canonical_name);
    if (!existing) {
      resolved.set(entity.canonical_name, entity);
      continue;
    }

    resolved.set(entity.canonical_name, mergeResolvedEntities(existing, entity));
  }

  return Array.from(resolved.values()).sort((left, right) => {
    if (right.confidence !== left.confidence) {
      return right.confidence - left.confidence;
    }
    return left.canonical_name.localeCompare(right.canonical_name);
  });
}

export function getCanonicalEntityRecord(canonicalName: string): CanonicalEntity | null {
  const record = canonicalEntityRegistry.get(canonicalName);
  return record ? toCanonicalEntity(record) : null;
}

export function isRegisteredCanonicalEntity(value: string): boolean {
  return canonicalEntityRegistry.has(value);
}

export function listCanonicalEntities(): CanonicalEntity[] {
  return Array.from(canonicalEntityRegistry.values()).map((record) => toCanonicalEntity(record));
}

export function getAliasesForCanonicalName(canonicalName: string): string[] {
  const aliases = canonicalAliasRegistry.get(canonicalName);
  if (!aliases) {
    return [];
  }

  const record = canonicalEntityRegistry.get(canonicalName);
  if (!record) {
    return [];
  }

  return uniqueSorted(Array.from(aliases).map((alias) => record.aliases.find((current) => canonicalizeAlias(current) === alias) ?? alias));
}

export function getTickerForCanonicalName(canonicalName: string): string | undefined {
  return canonicalTickerRegistry.get(canonicalName);
}

for (const seed of BUILTIN_ENTITIES) {
  registerSeed(seed);
}
