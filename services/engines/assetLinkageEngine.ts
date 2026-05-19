/**
 * Asset Linkage Engine
 *
 * Maps events and intelligence insights to affected financial assets.
 * Integrates with company databases, supply chain models, sector mappings,
 * and macro event patterns to identify direct and indirect asset exposures.
 *
 * Philosophy:
 * - Direct linkages (company mentioned, ticker in text) get high confidence
 * - Indirect linkages (supply chain, sector impact, macro exposure) get medium confidence
 * - Speculative linkages (geopolitical, systemic risk) get lower confidence
 * - All linkages include reasoning for institutional traceability
 */

/**
 * Input event for asset linkage analysis.
 */
export interface AssetLinkageInput {
  /** Event title */
  title: string;
  /** Event summary or body text */
  summary: string;
  /** Extracted entity mentions (company names, proper nouns) */
  entities: string[];
  /** Classified event type (e.g., "MONETARY_POLICY", "EARNINGS", etc.) */
  event_type: string;
  /** User-provided tags (e.g., ["semiconductor", "supply-chain"]) */
  tags: string[];
}

/**
 * Output structure for asset linkage analysis.
 */
export interface AssetLinkageOutput {
  /** Ticker symbols of affected equities */
  affected_assets: string[];
  /** Sector names (e.g., "Technology", "Energy", "Financials") */
  sectors: string[];
  /** Asset class categories (e.g., "Equity", "ETF", "Commodity", "Crypto") */
  asset_classes: string[];
  /** Overall confidence [0, 1] */
  confidence: number;
  /** Detailed reasoning for each linkage */
  reasoning: string[];
}

/**
 * Detailed asset with linkage explanation.
 */
interface AssetLinkage {
  ticker: string;
  name: string;
  sector: string;
  asset_class: "Equity" | "ETF" | "Commodity" | "Crypto";
  confidence: number;
  reasoning: string;
}

/**
 * Configuration for asset linkage engine.
 */
export interface AssetLinkageConfig {
  /** Include indirect supply chain exposures [0, 1] */
  includeIndirectExposures: boolean;
  /** Include macro event linkages [0, 1] */
  includeMacroLinkages: boolean;
  /** Include geopolitical linkages [0, 1] */
  includeGeopoliticalLinkages: boolean;
  /** Minimum confidence threshold for results [0, 1] */
  minConfidenceThreshold: number;
  /** Maximum results to return */
  maxResults: number;
}

const defaultConfig: AssetLinkageConfig = {
  includeIndirectExposures: true,
  includeMacroLinkages: true,
  includeGeopoliticalLinkages: true,
  minConfidenceThreshold: 0.35,
  maxResults: 50,
};

/**
 * Company name to ticker mappings.
 * Includes common name variations, subsidiaries, and trading names.
 */
const companyNameToTicker: Map<string, string> = new Map([
  // Semiconductors & Chip Designers
  ["nvidia", "NVDA"],
  ["amd", "AMD"],
  ["intel", "INTC"],
  ["qualcomm", "QCOM"],
  ["broadcom", "AVGO"],
  ["marvell technology", "MRVL"],
  ["maxim integrated", "MXIM"],
  ["micron technology", "MU"],
  ["applied materials", "AMAT"],
  ["asml", "ASML"],
  ["lam research", "LRCX"],
  ["tsmc", "TSM"],
  ["samsung", "SSNLF"],
  ["sk hynix", "SK"],
  ["mediatek", "MTK"],

  // Cloud & AI Infrastructure
  ["amazon", "AMZN"],
  ["microsoft", "MSFT"],
  ["google", "GOOGL"],
  ["alphabet", "GOOGL"],
  ["meta", "META"],
  ["facebook", "META"],
  ["tesla", "TSLA"],
  ["openai", "OPENAI"], // Private but tracked
  ["anthropic", "ANTHROPIC"], // Private
  ["together ai", "TOGETHER"], // Private

  // Financial Institutions
  ["jpmorgan", "JPM"],
  ["goldman sachs", "GS"],
  ["morgan stanley", "MS"],
  ["bank of america", "BAC"],
  ["wells fargo", "WFC"],
  ["citigroup", "C"],
  ["blackrock", "BLK"],
  ["vanguard", "BLV"], // Varied
  ["fidelity", "FDX"],
  ["berkshire hathaway", "BRK.B"],

  // Energy & Oil
  ["exxon mobil", "XOM"],
  ["chevron", "CVX"],
  ["bp", "BP"],
  ["shell", "SHEL"],
  ["conoco", "COP"],
  ["conocophillips", "COP"],
  ["equinor", "EQNR"],
  ["enbridge", "ENB"],
  ["tc energy", "TRP"],

  // Healthcare & Pharma
  ["pfizer", "PFE"],
  ["moderna", "MRNA"],
  ["biontech", "BNTX"],
  ["j&j", "JNJ"],
  ["johnson & johnson", "JNJ"],
  ["merck", "MRK"],
  ["eli lilly", "LLY"],
  ["abbvie", "ABBV"],
  ["bristol myers", "BMY"],
  ["roche", "RHHBY"],

  // Consumer & Retail
  ["apple", "AAPL"],
  ["nike", "NKE"],
  ["adidas", "ADDYY"],
  ["lululemon", "LULU"],
  ["costco", "COST"],
  ["walmart", "WMT"],
  ["amazon", "AMZN"],
  ["target", "TGT"],
  ["macy's", "M"],

  // Automotive
  ["tesla", "TSLA"],
  ["general motors", "GM"],
  ["ford", "F"],
  ["volkswagen", "VWAGY"],
  ["bmw", "BMWYY"],
  ["mercedes", "MBGYY"],
  ["toyota", "TM"],
  ["honda", "HMC"],
  ["hyundai", "HYMLF"],

  // Airlines & Transportation
  ["delta", "DAL"],
  ["united", "UAL"],
  ["american airlines", "AAL"],
  ["southwest", "LUV"],
  ["fedex", "FDX"],
  ["ups", "UPS"],
  ["lyft", "LYFT"],
  ["uber", "UBER"],

  // Media & Communications
  ["comcast", "CMCSA"],
  ["disney", "DIS"],
  ["netflix", "NFLX"],
  ["warner bros discovery", "WBD"],
  ["paramount", "PARA"],
  ["fox", "FOXA"],
  ["cbs", "CBSB"],
  ["viacomcbs", "PARA"],
  ["telegram", "TGRAM"], // Private

  // Construction & Materials
  ["caterpillar", "CAT"],
  ["deere", "DE"],
  ["3m", "MMM"],
  ["dupont", "DD"],
  ["corteva", "CTVA"],
  ["rpm international", "RPM"],

  // Tech & Software
  ["salesforce", "CRM"],
  ["oracle", "ORCL"],
  ["adobe", "ADBE"],
  ["slack", "WORK"],
  ["zoom", "ZM"],
  ["crowdstrike", "CRWD"],
  ["cloudflare", "NET"],
  ["datadog", "DDOG"],
  ["elastic", "ESTC"],
  ["mongodb", "MDB"],

  // Defense & Aerospace
  ["lockheed martin", "LMT"],
  ["raytheon", "RTX"],
  ["boeing", "BA"],
  ["northrop", "NOC"],
  ["general dynamics", "GD"],
  ["l3harris", "LHX"],

  // Other Major Caps
  ["procter & gamble", "PG"],
  ["coca-cola", "KO"],
  ["pepsi", "PEP"],
  ["mcdonalds", "MCD"],
  ["starbucks", "SBUX"],
  ["mastercard", "MA"],
  ["visa", "V"],
  ["stripe", "STRIPE"], // Private
  ["paypal", "PYPL"],
  ["square", "SQ"],
]);

/**
 * Sector mappings for major tickers.
 */
const tickerToSector: Map<string, string> = new Map([
  // Technology
  ["NVDA", "Technology"],
  ["AMD", "Technology"],
  ["INTC", "Technology"],
  ["QCOM", "Technology"],
  ["MSFT", "Technology"],
  ["GOOGL", "Technology"],
  ["AAPL", "Technology"],
  ["META", "Technology"],
  ["ASML", "Technology"],
  ["AMAT", "Technology"],
  ["LRCX", "Technology"],
  ["AVGO", "Technology"],
  ["MRVL", "Technology"],
  ["MU", "Technology"],
  ["TSM", "Technology"],

  // Healthcare
  ["PFE", "Healthcare"],
  ["MRNA", "Healthcare"],
  ["BNTX", "Healthcare"],
  ["JNJ", "Healthcare"],
  ["MRK", "Healthcare"],
  ["LLY", "Healthcare"],
  ["ABBV", "Healthcare"],
  ["BMY", "Healthcare"],

  // Financials
  ["JPM", "Financials"],
  ["GS", "Financials"],
  ["MS", "Financials"],
  ["BAC", "Financials"],
  ["WFC", "Financials"],
  ["C", "Financials"],
  ["BLK", "Financials"],
  ["MA", "Financials"],
  ["V", "Financials"],

  // Energy
  ["XOM", "Energy"],
  ["CVX", "Energy"],
  ["BP", "Energy"],
  ["SHEL", "Energy"],
  ["COP", "Energy"],
  ["EQNR", "Energy"],
  ["ENB", "Energy"],
  ["TRP", "Energy"],

  // Consumer
  ["COST", "Consumer"],
  ["WMT", "Consumer"],
  ["TGT", "Consumer"],
  ["NKE", "Consumer"],
  ["LULU", "Consumer"],
  ["MCD", "Consumer"],
  ["SBUX", "Consumer"],

  // Industrials
  ["CAT", "Industrials"],
  ["DE", "Industrials"],
  ["MMM", "Industrials"],
  ["GE", "Industrials"],
  ["BA", "Industrials"],

  // Utilities
  ["NEE", "Utilities"],
  ["SO", "Utilities"],
  ["EXC", "Utilities"],
]);

/**
 * Supply chain dependencies.
 * Maps companies to their critical upstream/downstream dependencies.
 */
const supplyChainDependencies: Map<string, string[]> = new Map([
  // Semiconductors depend on equipment makers
  ["NVDA", ["ASML", "AMAT", "LRCX"]],
  ["AMD", ["ASML", "AMAT", "LRCX", "TSM"]],
  ["INTC", ["ASML", "AMAT", "LRCX"]],
  ["QCOM", ["ASML", "AMAT", "TSM"]],

  // Equipment makers depend on each other
  ["ASML", ["AMAT", "LRCX"]],
  ["AMAT", ["LRCX"]],

  // TSMC production affects many chip designers
  ["TSM", ["NVDA", "AMD", "QCOM", "INTC"]],

  // Tech companies depend on semiconductors
  ["AAPL", ["NVDA", "INTC", "QCOM", "TSM"]],
  ["MSFT", ["NVDA", "INTC", "AMD"]],
  ["GOOGL", ["NVDA", "INTC", "QCOM"]],
  ["META", ["NVDA", "INTC", "AMD"]],
  ["AMZN", ["NVDA", "INTC", "AMAT"]],

  // Automotive depends on semiconductors
  ["TSLA", ["NVDA", "INTC", "QCOM"]],
  ["GM", ["INTC", "QCOM", "NVDA"]],
  ["F", ["INTC", "QCOM"]],

  // Energy infrastructure
  ["XOM", ["CAT", "PHLX:XLE"]],
  ["CVX", ["CAT"]],

  // Consumer retailers depend on supply chains
  ["COST", ["CAT", "WMT"]],
  ["WMT", ["CAT", "AMZN"]],
]);

/**
 * ETF sector mappings.
 * Identifies major ETFs for sector/factor exposure.
 */
const sectorETFs: Map<string, string[]> = new Map([
  ["Technology", ["QQQ", "XLK", "VGT", "IYW"]],
  ["Energy", ["XLE", "VDE", "IYE"]],
  ["Healthcare", ["XLV", "VHT", "IBB"]],
  ["Financials", ["XLF", "VFV", "IYF"]],
  ["Consumer", ["XLY", "VCR", "IYC"]],
  ["Industrials", ["XLI", "VIS", "IYJ"]],
  ["Utilities", ["XLU", "VPU", "IDU"]],
  ["Real Estate", ["XLRE", "VNQ", "IYR"]],
  ["Materials", ["XLB", "VAW", "IYM"]],
  ["Semiconductors", ["SOXX", "SMH", "VGT"]],
  ["Artificial Intelligence", ["PALANTIR", "ARKK", "VGT"]],
  ["Commodities", ["DBC", "GSG"]],
]);

/**
 * Crypto asset mappings.
 */
const cryptoAssets: Map<string, string> = new Map([
  ["bitcoin", "BTC"],
  ["ethereum", "ETH"],
  ["cardano", "ADA"],
  ["solana", "SOL"],
  ["polkadot", "DOT"],
  ["litecoin", "LTC"],
  ["dogecoin", "DOGE"],
  ["ripple", "XRP"],
  ["chainlink", "LINK"],
  ["aave", "AAVE"],
]);

/**
 * Commodity asset mappings.
 */
const commodityAssets: Map<string, string> = new Map([
  ["crude oil", "CL=F"],
  ["brent", "BZ=F"],
  ["natural gas", "NG=F"],
  ["gold", "GC=F"],
  ["silver", "SI=F"],
  ["copper", "HG=F"],
  ["wheat", "ZWH"],
  ["corn", "ZCH"],
  ["soybeans", "ZSH"],
]);

/**
 * Event type to asset class mappings.
 * Used for macro event linkages.
 */
const eventTypeAssetImpact: Map<string, { assets: string[]; confidence: number }> = new Map([
  [
    "MONETARY_POLICY",
    {
      assets: ["TLT", "IEF", "SHY", "JPM", "BAC", "GS", "SCHB", "XLF"],
      confidence: 0.85,
    },
  ],
  ["INTEREST_RATE_HIKE", { assets: ["TLT", "BND", "XLF", "JPM"], confidence: 0.9 }],
  ["INTEREST_RATE_CUT", { assets: ["TSLA", "AMZN", "GOOGL", "QQQ", "TLT"], confidence: 0.85 }],
  [
    "EARNINGS",
    { assets: [], confidence: 0 }, // Handled by entity extraction
  ],
  [
    "GEOPOLITICAL_ESCALATION",
    {
      assets: ["LMT", "NOC", "RTX", "GD", "XLE", "CVX", "GLD"],
      confidence: 0.7,
    },
  ],
  [
    "SUPPLY_CHAIN",
    { assets: ["CAT", "DE", "XLK", "ASML", "AMAT"], confidence: 0.75 },
  ],
  [
    "COMMODITY_SHOCK",
    { assets: ["XLE", "CVX", "XOM", "DBC"], confidence: 0.8 },
  ],
  [
    "ENERGY_SUPPLY",
    { assets: ["XLE", "COP", "EQNR", "ENB", "TRP", "GLD"], confidence: 0.8 },
  ],
  [
    "CREDIT_STRESS",
    { assets: ["JPM", "BAC", "GS", "XLF", "HYG", "LQD"], confidence: 0.75 },
  ],
  ["REGULATORY", { assets: ["TSLA", "F", "META", "NFLX"], confidence: 0.6 }],
]);

/**
 * Geopolitical event to asset mappings.
 */
const geopoliticalAssetImpact: Map<string, string[]> = new Map([
  ["russia", ["XLE", "CVX", "BP", "LMT", "RTX", "GD"]],
  ["ukraine", ["XLE", "CVX", "BP", "EQNR", "LMT"]],
  ["china", ["TSM", "ASML", "AMAT", "NVDA", "AMD", "INTC"]],
  ["taiwan", ["TSM", "ASML", "QCOM", "NVDA", "AMD"]],
  ["middle east", ["XLE", "CVX", "XOM", "GLD", "DBC"]],
  ["iran", ["XLE", "CVX", "XOM", "LMT", "RTX"]],
  ["israel", ["LMT", "RTX", "NOC", "GLD"]],
  ["north korea", ["LMT", "RTX", "NOC"]],
  ["south korea", ["TSM", "QCOM", "NVDA", "AMD"]],
  ["trade war", ["TSLA", "F", "GM", "AAPL", "MSFT", "GOOGL"]],
  ["sanctions", ["XLE", "CVX", "XOM", "LMT", "RTX"]],
]);

/**
 * Normalize company/entity name for lookup.
 */
function normalizeEntityName(entity: string): string {
  return entity.toLowerCase().trim().replace(/[&]/g, "and");
}

/**
 * Search for company name in database with fuzzy matching.
 */
function findTickerByName(companyName: string): string | null {
  const normalized = normalizeEntityName(companyName);

  // Exact match
  if (companyNameToTicker.has(normalized)) {
    return companyNameToTicker.get(normalized)!;
  }

  // Partial match (e.g., "Nvidia Inc" → "NVDA")
  for (const [name, ticker] of companyNameToTicker.entries()) {
    if (name.includes(normalized) || normalized.includes(name)) {
      return ticker;
    }
  }

  return null;
}

/**
 * Extract ticker mentions directly from text (e.g., "NVDA", "ASML").
 */
function extractDirectTickerMentions(
  text: string
): Array<{ ticker: string; confidence: number }> {
  const tickerPattern = /\b([A-Z]{1,5})(?:=F|\.L|\.TO|\.DE)?\b/g;
  const matches = Array.from(text.matchAll(tickerPattern));

  const tickers: Array<{ ticker: string; confidence: number }> = [];
  const seenTickers = new Set<string>();

  for (const match of matches) {
    const ticker = match[1];

    // Filter out common false positives
    if (["THE", "AND", "FOR", "WITH", "FROM", "THAT", "THIS", "WILL"].includes(ticker)) {
      continue;
    }

    // Known tickers get higher confidence
    if (tickerToSector.has(ticker)) {
      if (!seenTickers.has(ticker)) {
        tickers.push({ ticker, confidence: 0.95 });
        seenTickers.add(ticker);
      }
    }
  }

  return tickers;
}

/**
 * Get supply chain cascade for a ticker.
 * Includes direct dependencies and secondary effects.
 */
function getSupplyChainExposures(ticker: string): Array<{ ticker: string; confidence: number }> {
  const exposures: Array<{ ticker: string; confidence: number }> = [];
  const visited = new Set<string>();

  function traverse(currentTicker: string, depth: number, confidence: number) {
    if (depth > 2 || visited.has(currentTicker)) return; // Limit depth
    visited.add(currentTicker);

    const dependencies = supplyChainDependencies.get(currentTicker) || [];
    for (const dep of dependencies) {
      exposures.push({
        ticker: dep,
        confidence: confidence * (1 - depth * 0.15), // Decay with depth
      });

      traverse(dep, depth + 1, confidence * 0.8);
    }
  }

  traverse(ticker, 0, 1.0);
  return exposures;
}

/**
 * Get sector exposure for a ticker.
 */
function getSectorForTicker(ticker: string): string {
  return tickerToSector.get(ticker) || "Unknown";
}

/**
 * Get sector ETFs.
 */
function getETFsForSector(sector: string): string[] {
  return sectorETFs.get(sector) || [];
}

/**
 * Analyze geopolitical mentions in text.
 */
function analyzeGeopoliticalLinkages(
  title: string,
  summary: string,
  config: AssetLinkageConfig
): AssetLinkage[] {
  if (!config.includeGeopoliticalLinkages) return [];

  const text = `${title} ${summary}`.toLowerCase();
  const exposures: AssetLinkage[] = [];
  const seenTickers = new Set<string>();

  for (const [region, tickers] of geopoliticalAssetImpact.entries()) {
    if (text.includes(region)) {
      for (const ticker of tickers) {
        if (!seenTickers.has(ticker)) {
          const sector = getSectorForTicker(ticker);
          exposures.push({
            ticker,
            name: ticker,
            sector,
            asset_class: "Equity",
            confidence: 0.6,
            reasoning: `Geopolitical exposure: ${region} mentioned in event`,
          });
          seenTickers.add(ticker);
        }
      }
    }
  }

  return exposures;
}

/**
 * Compute asset linkages for an event.
 */
export function computeAssetLinkages(
  input: AssetLinkageInput,
  config?: Partial<AssetLinkageConfig>
): AssetLinkageOutput {
  const mergedConfig: AssetLinkageConfig = { ...defaultConfig, ...config };

  const assetMap = new Map<string, AssetLinkage>();
  const combinedText = `${input.title} ${input.summary}`.toLowerCase();

  // 1. Direct ticker mentions
  const directTickers = extractDirectTickerMentions(input.title + " " + input.summary);
  for (const { ticker, confidence } of directTickers) {
    if (!assetMap.has(ticker)) {
      const sector = getSectorForTicker(ticker);
      assetMap.set(ticker, {
        ticker,
        name: ticker,
        sector,
        asset_class: "Equity",
        confidence,
        reasoning: `Direct ticker mention in event text`,
      });
    }
  }

  // 2. Entity-based company mentions
  for (const entity of input.entities) {
    const ticker = findTickerByName(entity);
    if (ticker && !assetMap.has(ticker)) {
      const sector = getSectorForTicker(ticker);
      assetMap.set(ticker, {
        ticker,
        name: entity,
        sector,
        asset_class: "Equity",
        confidence: 0.9,
        reasoning: `Company entity extracted: ${entity} → ${ticker}`,
      });
    }
  }

  // 3. Supply chain exposures
  if (mergedConfig.includeIndirectExposures) {
    for (const [directTicker] of assetMap.entries()) {
      const supplyChainExposures = getSupplyChainExposures(directTicker);
      for (const { ticker, confidence } of supplyChainExposures) {
        if (!assetMap.has(ticker)) {
          const sector = getSectorForTicker(ticker);
          assetMap.set(ticker, {
            ticker,
            name: ticker,
            sector,
            asset_class: "Equity",
            confidence: confidence * 0.7, // Reduce confidence for indirect
            reasoning: `Supply chain exposure via ${directTicker}`,
          });
        }
      }
    }
  }

  // 4. Macro event linkages
  if (mergedConfig.includeMacroLinkages) {
    const eventImpact = eventTypeAssetImpact.get(input.event_type);
    if (eventImpact) {
      for (const ticker of eventImpact.assets) {
        if (!assetMap.has(ticker)) {
          const sector = getSectorForTicker(ticker);
          assetMap.set(ticker, {
            ticker,
            name: ticker,
            sector,
            asset_class: "Equity",
            confidence: eventImpact.confidence * 0.65,
            reasoning: `Event type exposure: ${input.event_type} typically impacts ${sector}`,
          });
        }
      }
    }
  }

  // 5. Geopolitical linkages
  const geoExposures = analyzeGeopoliticalLinkages(input.title, input.summary, mergedConfig);
  for (const exposure of geoExposures) {
    if (!assetMap.has(exposure.ticker)) {
      assetMap.set(exposure.ticker, exposure);
    }
  }

  // 6. Tag-based linkages
  for (const tag of input.tags) {
    const normalizedTag = tag.toLowerCase();

    if (normalizedTag.includes("semiconductor")) {
      const semitickers = ["NVDA", "AMD", "INTC", "QCOM", "ASML", "AMAT", "TSM"];
      for (const ticker of semitickers) {
        if (!assetMap.has(ticker)) {
          const sector = getSectorForTicker(ticker);
          assetMap.set(ticker, {
            ticker,
            name: ticker,
            sector,
            asset_class: "Equity",
            confidence: 0.75,
            reasoning: `Tag-based exposure: "${tag}" implies semiconductor sector impact`,
          });
        }
      }
    }

    if (normalizedTag.includes("energy") || normalizedTag.includes("oil")) {
      const energyTickers = ["XLE", "XOM", "CVX", "COP", "EQNR"];
      for (const ticker of energyTickers) {
        if (!assetMap.has(ticker)) {
          const sector = getSectorForTicker(ticker);
          assetMap.set(ticker, {
            ticker,
            name: ticker,
            sector,
            asset_class: ticker.includes("=") ? "Commodity" : "Equity",
            confidence: 0.8,
            reasoning: `Tag-based exposure: "${tag}" implies energy sector impact`,
          });
        }
      }
    }

    if (normalizedTag.includes("crypto")) {
      const cryptoTickers = ["BTC", "ETH"];
      for (const ticker of cryptoTickers) {
        if (!assetMap.has(ticker)) {
          assetMap.set(ticker, {
            ticker,
            name: ticker,
            sector: "Cryptocurrency",
            asset_class: "Crypto",
            confidence: 0.7,
            reasoning: `Tag-based exposure: "${tag}" implies cryptocurrency impact`,
          });
        }
      }
    }
  }

  // Filter by confidence threshold and limit results
  const filtered = Array.from(assetMap.values())
    .filter((asset) => asset.confidence >= mergedConfig.minConfidenceThreshold)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, mergedConfig.maxResults);

  // Extract unique sectors and asset classes
  const sectors = Array.from(new Set(filtered.map((a) => a.sector).filter((s) => s !== "Unknown")));
  const asset_classes = Array.from(new Set(filtered.map((a) => a.asset_class)));

  // Calculate overall confidence
  const avgConfidence =
    filtered.length > 0
      ? filtered.reduce((sum, a) => sum + a.confidence, 0) / filtered.length
      : 0;

  // Add sector ETFs
  const etfs: AssetLinkage[] = [];
  for (const sector of sectors) {
    const etfsForSector = getETFsForSector(sector);
    for (const etf of etfsForSector) {
      if (!filtered.some((a) => a.ticker === etf)) {
        etfs.push({
          ticker: etf,
          name: etf,
          sector,
          asset_class: "ETF",
          confidence: 0.65,
          reasoning: `Sector ETF for ${sector} exposure`,
        });
      }
    }
  }

  const allAssets = [...filtered, ...etfs];

  return {
    affected_assets: allAssets.map((a) => a.ticker),
    sectors,
    asset_classes: Array.from(new Set(asset_classes)),
    confidence: avgConfidence,
    reasoning: allAssets.map((a) => a.reasoning),
  };
}

/**
 * Helper: Get all related assets for a ticker (supply chain + sector).
 */
export function getRelatedAssets(ticker: string): Array<{
  ticker: string;
  relationship: string;
  confidence: number;
}> {
  const related: Array<{ ticker: string; relationship: string; confidence: number }> = [];

  // Supply chain upstream/downstream
  const supplyChainExposures = getSupplyChainExposures(ticker);
  for (const exposure of supplyChainExposures) {
    related.push({
      ticker: exposure.ticker,
      relationship: "supply_chain",
      confidence: exposure.confidence,
    });
  }

  // Sector peers
  const sector = getSectorForTicker(ticker);
  if (sector && sector !== "Unknown") {
    const etfs = getETFsForSector(sector);
    for (const etf of etfs) {
      related.push({
        ticker: etf,
        relationship: "sector_etf",
        confidence: 0.65,
      });
    }
  }

  return related;
}

/**
 * Helper: Search for ticker or company name.
 */
export function searchAsset(query: string): Array<{ ticker: string; name: string; sector: string }> {
  const results: Array<{ ticker: string; name: string; sector: string }> = [];
  const normalized = normalizeEntityName(query);

  for (const [name, ticker] of companyNameToTicker.entries()) {
    if (name.includes(normalized) || normalized.includes(name) || ticker.includes(normalized)) {
      results.push({
        ticker,
        name,
        sector: getSectorForTicker(ticker),
      });
    }
  }

  return results;
}

/**
 * Helper: Get all supported tickers.
 */
export function getAllSupportedTickers(): string[] {
  return Array.from(companyNameToTicker.values());
}

/**
 * Helper: Get config for asset linkage computation.
 */
export function getDefaultAssetLinkageConfig(): AssetLinkageConfig {
  return { ...defaultConfig };
}
