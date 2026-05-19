/**
 * Source Credibility Engine
 *
 * Assigns institutional credibility scores to intelligence sources based on
 * tier classification, domain normalization, and override capability.
 *
 * Tier System:
 * - Tier 1 Institutional (0.95–1.0): Major exchanges, central banks, regulatory bodies, Tier-1 news
 * - Tier 2 Professional (0.75–0.94): Professional financial services, wire services, major publications
 * - Tier 3 Specialized (0.55–0.74): Niche financial, crypto, analyst platforms, industry sources
 * - Tier 4 Retail (0.35–0.54): Retail news, blogs, smaller publications, emerging platforms
 * - Tier 5 Unknown (0.15–0.34): Unknown/unclassified sources, fallback for unmapped domains
 */

/**
 * Output structure for source credibility assessment.
 */
export interface SourceCredibilityOutput {
  /** Credibility score [0, 1] */
  score: number;
  /** Tier classification (e.g., "Tier 1 Institutional") */
  tier: string;
  /** Classification category (e.g., "Central Bank", "Wire Service", "Crypto News") */
  classification: string;
  /** Normalized ownership group for independence weighting */
  ownership_group?: string;
}

/**
 * Internal representation of a known source.
 */
interface SourceEntry {
  domains: string[];
  tier: SourceTier;
  classification: string;
  baseScore: number;
  ownershipGroup?: string;
}

type SourceTier = 1 | 2 | 3 | 4 | 5;

/**
 * In-memory override registry for dynamic credibility adjustments.
 * Maps normalized domain → override {tier, score, classification}
 */
const credibilityOverrides: Map<
  string,
  { tier: SourceTier; score: number; classification: string }
> = new Map();

const ownershipGroupRules: Array<{ pattern: RegExp; ownershipGroup: string }> = [
  { pattern: /(^|\.)reuters\.com$/i, ownershipGroup: "Thomson Reuters" },
  { pattern: /thomson\s+reuters/i, ownershipGroup: "Thomson Reuters" },
  { pattern: /\breuters\b/i, ownershipGroup: "Thomson Reuters" },
  { pattern: /(^|\.)wsj\.com$/i, ownershipGroup: "Dow Jones" },
  { pattern: /(^|\.)wall-street-journal\.com$/i, ownershipGroup: "Dow Jones" },
  { pattern: /\bwsj\b/i, ownershipGroup: "Dow Jones" },
  { pattern: /\bbarrons?\b/i, ownershipGroup: "Dow Jones" },
  { pattern: /\bmarketwatch\b/i, ownershipGroup: "Dow Jones" },
  { pattern: /(^|\.)cnbc\.com$/i, ownershipGroup: "NBCUniversal" },
  { pattern: /\bcnbc\b/i, ownershipGroup: "NBCUniversal" },
  { pattern: /(^|\.)finance\.yahoo\.com$/i, ownershipGroup: "Yahoo" },
  { pattern: /(^|\.)yahoo-finance\.com$/i, ownershipGroup: "Yahoo" },
  { pattern: /\byahoo finance\b/i, ownershipGroup: "Yahoo" },
  { pattern: /\byahoo\b/i, ownershipGroup: "Yahoo" },
  { pattern: /(^|\.)bloomberg\.com$/i, ownershipGroup: "Bloomberg" },
  { pattern: /\bbloomberg\b/i, ownershipGroup: "Bloomberg" },
  { pattern: /(^|\.)ft\.com$/i, ownershipGroup: "Nikkei" },
  { pattern: /\bfinancial times\b/i, ownershipGroup: "Nikkei" },
  { pattern: /\bft\b/i, ownershipGroup: "Nikkei" },
  { pattern: /(^|\.)apnews\.com$/i, ownershipGroup: "Associated Press" },
  { pattern: /\bassociated press\b/i, ownershipGroup: "Associated Press" },
  { pattern: /(^|\.)businesswire\.com$/i, ownershipGroup: "Business Wire" },
  { pattern: /(^|\.)prnewswire\.com$/i, ownershipGroup: "Cision" },
  { pattern: /(^|\.)globenewswire\.com$/i, ownershipGroup: "GlobeNewswire" },
];

/**
 * Comprehensive source database: 100+ institutional, professional, specialized, and retail sources.
 * Domains normalized (no protocol, no www prefix required during lookup).
 */
const sourceDatabase: Map<string, SourceEntry> = new Map([
  // TIER 1 INSTITUTIONAL: Central Banks
  [
    "federalreserve.gov",
    {
      domains: ["federalreserve.gov", "fed.org"],
      tier: 1,
      classification: "Central Bank",
      baseScore: 0.99,
    },
  ],
  [
    "ecb.europa.eu",
    {
      domains: ["ecb.europa.eu", "ecb.int"],
      tier: 1,
      classification: "Central Bank",
      baseScore: 0.99,
    },
  ],
  [
    "boe.co.uk",
    {
      domains: ["boe.co.uk", "bankofengland.co.uk"],
      tier: 1,
      classification: "Central Bank",
      baseScore: 0.99,
    },
  ],
  [
    "boj.or.jp",
    {
      domains: ["boj.or.jp", "bankofJapan.org"],
      tier: 1,
      classification: "Central Bank",
      baseScore: 0.99,
    },
  ],
  [
    "snb.ch",
    {
      domains: ["snb.ch", "swiss-national-bank.ch"],
      tier: 1,
      classification: "Central Bank",
      baseScore: 0.99,
    },
  ],
  [
    "rbnz.govt.nz",
    {
      domains: ["rbnz.govt.nz"],
      tier: 1,
      classification: "Central Bank",
      baseScore: 0.99,
    },
  ],
  [
    "rba.gov.au",
    {
      domains: ["rba.gov.au"],
      tier: 1,
      classification: "Central Bank",
      baseScore: 0.99,
    },
  ],
  [
    "bis.org",
    {
      domains: ["bis.org"],
      tier: 1,
      classification: "International Monetary",
      baseScore: 0.98,
    },
  ],

  // TIER 1: Regulators & Government Agencies
  [
    "sec.gov",
    { domains: ["sec.gov"], tier: 1, classification: "Regulator", baseScore: 0.99 },
  ],
  [
    "cftc.gov",
    { domains: ["cftc.gov"], tier: 1, classification: "Regulator", baseScore: 0.99 },
  ],
  [
    "irs.gov",
    {
      domains: ["irs.gov"],
      tier: 1,
      classification: "Government",
      baseScore: 0.98,
    },
  ],
  [
    "treasury.gov",
    {
      domains: ["treasury.gov"],
      tier: 1,
      classification: "Government",
      baseScore: 0.99,
    },
  ],
  [
    "fca.org.uk",
    { domains: ["fca.org.uk"], tier: 1, classification: "Regulator", baseScore: 0.99 },
  ],
  [
    "esma.europa.eu",
    {
      domains: ["esma.europa.eu"],
      tier: 1,
      classification: "Regulator",
      baseScore: 0.98,
    },
  ],
  [
    "finma.ch",
    { domains: ["finma.ch"], tier: 1, classification: "Regulator", baseScore: 0.98 },
  ],
  [
    "asic.gov.au",
    {
      domains: ["asic.gov.au"],
      tier: 1,
      classification: "Regulator",
      baseScore: 0.98,
    },
  ],
  [
    "fda.gov",
    { domains: ["fda.gov"], tier: 1, classification: "Regulator", baseScore: 0.99 },
  ],
  [
    "ema.europa.eu",
    { domains: ["ema.europa.eu"], tier: 1, classification: "Regulator", baseScore: 0.98 },
  ],
  [
    "bsee.gov",
    {
      domains: ["bsee.gov"],
      tier: 1,
      classification: "Government",
      baseScore: 0.99,
    },
  ],

  // TIER 1: Major Stock Exchanges
  [
    "nyse.com",
    {
      domains: ["nyse.com", "newyorkstockexchange.com"],
      tier: 1,
      classification: "Exchange",
      baseScore: 0.99,
    },
  ],
  [
    "nasdaq.com",
    { domains: ["nasdaq.com"], tier: 1, classification: "Exchange", baseScore: 0.99 },
  ],
  [
    "london-stock-exchange.com",
    {
      domains: ["london-stock-exchange.com", "lseg.com"],
      tier: 1,
      classification: "Exchange",
      baseScore: 0.99,
    },
  ],
  [
    "euronext.com",
    { domains: ["euronext.com"], tier: 1, classification: "Exchange", baseScore: 0.99 },
  ],
  [
    "jpx.co.jp",
    { domains: ["jpx.co.jp"], tier: 1, classification: "Exchange", baseScore: 0.99 },
  ],
  [
    "asx.com.au",
    { domains: ["asx.com.au"], tier: 1, classification: "Exchange", baseScore: 0.99 },
  ],
  [
    "sgx.com",
    { domains: ["sgx.com"], tier: 1, classification: "Exchange", baseScore: 0.99 },
  ],
  [
    "hkex.com.hk",
    { domains: ["hkex.com.hk"], tier: 1, classification: "Exchange", baseScore: 0.99 },
  ],
  [
    "sse.com.cn",
    { domains: ["sse.com.cn"], tier: 1, classification: "Exchange", baseScore: 0.98 },
  ],

  // TIER 1: International Financial Institutions
  [
    "imf.org",
    {
      domains: ["imf.org"],
      tier: 1,
      classification: "International Monetary",
      baseScore: 0.99,
    },
  ],
  [
    "worldbank.org",
    {
      domains: ["worldbank.org"],
      tier: 1,
      classification: "International Monetary",
      baseScore: 0.99,
    },
  ],
  [
    "oecd.org",
    {
      domains: ["oecd.org"],
      tier: 1,
      classification: "International Monetary",
      baseScore: 0.98,
    },
  ],

  // TIER 1: Wire Services & News Agencies
  [
    "reuters.com",
    {
      domains: ["reuters.com"],
      tier: 1,
      classification: "Wire Service",
      baseScore: 0.98,
    },
  ],
  [
    "bloomberg.com",
    {
      domains: ["bloomberg.com"],
      tier: 1,
      classification: "Wire Service",
      baseScore: 0.98,
    },
  ],
  [
    "ft.com",
    {
      domains: ["ft.com", "ft.co.uk", "financial-times.com"],
      tier: 1,
      classification: "Premium News",
      baseScore: 0.98,
    },
  ],
  [
    "wsj.com",
    {
      domains: ["wsj.com", "wall-street-journal.com"],
      tier: 1,
      classification: "Premium News",
      baseScore: 0.98,
    },
  ],
  [
    "apnews.com",
    {
      domains: ["apnews.com"],
      tier: 1,
      classification: "Wire Service",
      baseScore: 0.97,
    },
  ],
  [
    "businesswire.com",
    {
      domains: ["businesswire.com"],
      tier: 1,
      classification: "Wire Service",
      baseScore: 0.97,
    },
  ],

  // TIER 1: Investment Banks
  [
    "goldmansachs.com",
    {
      domains: ["goldmansachs.com"],
      tier: 1,
      classification: "Investment Bank",
      baseScore: 0.96,
    },
  ],
  [
    "jpmorgan.com",
    {
      domains: ["jpmorgan.com"],
      tier: 1,
      classification: "Investment Bank",
      baseScore: 0.96,
    },
  ],
  [
    "bofa.com",
    {
      domains: ["bofa.com", "bankofamerica.com"],
      tier: 1,
      classification: "Investment Bank",
      baseScore: 0.96,
    },
  ],
  [
    "citigroup.com",
    {
      domains: ["citigroup.com"],
      tier: 1,
      classification: "Investment Bank",
      baseScore: 0.95,
    },
  ],
  [
    "morganstanley.com",
    {
      domains: ["morganstanley.com"],
      tier: 1,
      classification: "Investment Bank",
      baseScore: 0.95,
    },
  ],

  // TIER 2: Premium Financial News
  [
    "cnbc.com",
    {
      domains: ["cnbc.com"],
      tier: 2,
      classification: "Financial News",
      baseScore: 0.92,
    },
  ],
  [
    "marketwatch.com",
    {
      domains: ["marketwatch.com"],
      tier: 2,
      classification: "Financial News",
      baseScore: 0.9,
    },
  ],
  [
    "nikkei.com",
    {
      domains: ["nikkei.com"],
      tier: 2,
      classification: "Premium News",
      baseScore: 0.92,
    },
  ],
  [
    "barrons.com",
    {
      domains: ["barrons.com", "barron.com"],
      tier: 2,
      classification: "Financial News",
      baseScore: 0.9,
    },
  ],
  [
    "economist.com",
    {
      domains: ["economist.com"],
      tier: 2,
      classification: "Premium News",
      baseScore: 0.91,
    },
  ],
  [
    "theguardian.com",
    {
      domains: ["theguardian.com"],
      tier: 2,
      classification: "General News",
      baseScore: 0.88,
    },
  ],
  [
    "bbc.com",
    {
      domains: ["bbc.com", "bbc.co.uk"],
      tier: 2,
      classification: "General News",
      baseScore: 0.89,
    },
  ],
  [
    "telegraph.co.uk",
    {
      domains: ["telegraph.co.uk"],
      tier: 2,
      classification: "General News",
      baseScore: 0.87,
    },
  ],
  [
    "independent.co.uk",
    {
      domains: ["independent.co.uk"],
      tier: 2,
      classification: "General News",
      baseScore: 0.85,
    },
  ],
  [
    "businessinsider.com",
    {
      domains: ["businessinsider.com"],
      tier: 2,
      classification: "Financial News",
      baseScore: 0.84,
    },
  ],

  // TIER 2: Analyst Platforms & Research
  [
    "seeking-alpha.com",
    {
      domains: ["seeking-alpha.com", "seekingalpha.com"],
      tier: 2,
      classification: "Analyst Platform",
      baseScore: 0.85,
    },
  ],
  [
    "morningstar.com",
    {
      domains: ["morningstar.com"],
      tier: 2,
      classification: "Financial Analysis",
      baseScore: 0.88,
    },
  ],
  [
    "yahoo-finance.com",
    {
      domains: ["yahoo-finance.com", "finance.yahoo.com"],
      tier: 2,
      classification: "Financial News",
      baseScore: 0.85,
    },
  ],
  [
    "gartner.com",
    {
      domains: ["gartner.com"],
      tier: 2,
      classification: "Research Firm",
      baseScore: 0.88,
    },
  ],
  [
    "idc.com",
    {
      domains: ["idc.com"],
      tier: 2,
      classification: "Research Firm",
      baseScore: 0.87,
    },
  ],
  [
    "forrester.com",
    {
      domains: ["forrester.com"],
      tier: 2,
      classification: "Research Firm",
      baseScore: 0.86,
    },
  ],

  // TIER 2: Rating & Data Agencies
  [
    "moodys.com",
    {
      domains: ["moodys.com"],
      tier: 2,
      classification: "Rating Agency",
      baseScore: 0.92,
    },
  ],
  [
    "fitchratings.com",
    {
      domains: ["fitchratings.com"],
      tier: 2,
      classification: "Rating Agency",
      baseScore: 0.91,
    },
  ],
  [
    "dbrs.com",
    {
      domains: ["dbrs.com"],
      tier: 2,
      classification: "Rating Agency",
      baseScore: 0.89,
    },
  ],
  [
    "sp-global.com",
    {
      domains: ["sp-global.com", "spglobal.com"],
      tier: 2,
      classification: "Research Firm",
      baseScore: 0.91,
    },
  ],

  // TIER 2: Asset Managers & Brokerages
  [
    "vanguard.com",
    {
      domains: ["vanguard.com"],
      tier: 2,
      classification: "Asset Manager",
      baseScore: 0.89,
    },
  ],
  [
    "fidelity.com",
    {
      domains: ["fidelity.com"],
      tier: 2,
      classification: "Asset Manager",
      baseScore: 0.88,
    },
  ],
  [
    "schwab.com",
    {
      domains: ["schwab.com"],
      tier: 2,
      classification: "Brokerage",
      baseScore: 0.86,
    },
  ],
  [
    "interactive-brokers.com",
    {
      domains: ["interactive-brokers.com", "interactivebrokers.com"],
      tier: 2,
      classification: "Brokerage",
      baseScore: 0.85,
    },
  ],
  [
    "etrade.com",
    {
      domains: ["etrade.com"],
      tier: 2,
      classification: "Brokerage",
      baseScore: 0.84,
    },
  ],
  [
    "ishares.com",
    {
      domains: ["ishares.com"],
      tier: 2,
      classification: "Asset Manager",
      baseScore: 0.87,
    },
  ],

  // TIER 2: Investment Banks (Secondary)
  [
    "barclays.com",
    {
      domains: ["barclays.com"],
      tier: 2,
      classification: "Investment Bank",
      baseScore: 0.88,
    },
  ],
  [
    "nomura.com",
    {
      domains: ["nomura.com"],
      tier: 2,
      classification: "Investment Bank",
      baseScore: 0.87,
    },
  ],
  [
    "dbs.com",
    {
      domains: ["dbs.com"],
      tier: 2,
      classification: "Investment Bank",
      baseScore: 0.85,
    },
  ],
  [
    "hsbc.com",
    {
      domains: ["hsbc.com"],
      tier: 2,
      classification: "Investment Bank",
      baseScore: 0.86,
    },
  ],
  [
    "deutsche-bank.com",
    {
      domains: ["deutsche-bank.com", "deutschebank.com"],
      tier: 2,
      classification: "Investment Bank",
      baseScore: 0.84,
    },
  ],

  // TIER 3: Specialized Finance & Crypto
  [
    "coindesk.com",
    {
      domains: ["coindesk.com"],
      tier: 3,
      classification: "Crypto News",
      baseScore: 0.72,
    },
  ],
  [
    "the-block.com",
    {
      domains: ["the-block.com", "theblock.com"],
      tier: 3,
      classification: "Crypto Research",
      baseScore: 0.7,
    },
  ],
  [
    "messari.io",
    {
      domains: ["messari.io"],
      tier: 3,
      classification: "Crypto Intelligence",
      baseScore: 0.71,
    },
  ],
  [
    "glassnode.com",
    {
      domains: ["glassnode.com"],
      tier: 3,
      classification: "Crypto Analytics",
      baseScore: 0.69,
    },
  ],
  [
    "nansen.ai",
    {
      domains: ["nansen.ai"],
      tier: 3,
      classification: "Crypto Analytics",
      baseScore: 0.68,
    },
  ],
  [
    "cointelegraph.com",
    {
      domains: ["cointelegraph.com"],
      tier: 3,
      classification: "Crypto News",
      baseScore: 0.66,
    },
  ],
  [
    "bitcoinmagazine.com",
    {
      domains: ["bitcoinmagazine.com"],
      tier: 3,
      classification: "Crypto News",
      baseScore: 0.66,
    },
  ],
  [
    "decrypt.co",
    {
      domains: ["decrypt.co"],
      tier: 3,
      classification: "Crypto News",
      baseScore: 0.65,
    },
  ],

  // TIER 3: Tech News
  [
    "techcrunch.com",
    {
      domains: ["techcrunch.com"],
      tier: 3,
      classification: "Tech News",
      baseScore: 0.75,
    },
  ],
  [
    "theverge.com",
    {
      domains: ["theverge.com"],
      tier: 3,
      classification: "Tech News",
      baseScore: 0.72,
    },
  ],
  [
    "arstechnica.com",
    {
      domains: ["arstechnica.com"],
      tier: 3,
      classification: "Tech News",
      baseScore: 0.73,
    },
  ],
  [
    "wired.com",
    {
      domains: ["wired.com"],
      tier: 3,
      classification: "Tech News",
      baseScore: 0.72,
    },
  ],

  // TIER 3: Economic & Macro Analysis
  [
    "trading-economics.com",
    {
      domains: ["trading-economics.com", "tradingeconomics.com"],
      tier: 3,
      classification: "Economic Data",
      baseScore: 0.7,
    },
  ],
  [
    "investing.com",
    {
      domains: ["investing.com"],
      tier: 3,
      classification: "Financial Platform",
      baseScore: 0.68,
    },
  ],
  [
    "zerohedge.com",
    {
      domains: ["zerohedge.com"],
      tier: 3,
      classification: "Alternative Finance",
      baseScore: 0.65,
    },
  ],
  [
    "axios.com",
    {
      domains: ["axios.com"],
      tier: 3,
      classification: "News Aggregator",
      baseScore: 0.7,
    },
  ],
  [
    "vox.com",
    {
      domains: ["vox.com"],
      tier: 3,
      classification: "News Analysis",
      baseScore: 0.67,
    },
  ],

  // TIER 3: Geopolitical & Research
  [
    "stratfor.com",
    {
      domains: ["stratfor.com"],
      tier: 3,
      classification: "Geopolitical Intelligence",
      baseScore: 0.73,
    },
  ],
  [
    "cfr.org",
    {
      domains: ["cfr.org"],
      tier: 3,
      classification: "Research Institute",
      baseScore: 0.74,
    },
  ],
  [
    "brookings.edu",
    {
      domains: ["brookings.edu"],
      tier: 3,
      classification: "Research Institute",
      baseScore: 0.74,
    },
  ],
  [
    "sipri.org",
    {
      domains: ["sipri.org"],
      tier: 3,
      classification: "Research Institute",
      baseScore: 0.75,
    },
  ],

  // TIER 3: Industry & Specialty
  [
    "supply-chain-dive.com",
    {
      domains: ["supply-chain-dive.com", "supplychaindive.com"],
      tier: 3,
      classification: "Industry News",
      baseScore: 0.68,
    },
  ],
  [
    "prnewswire.com",
    {
      domains: ["prnewswire.com"],
      tier: 3,
      classification: "Press Release",
      baseScore: 0.69,
    },
  ],
  [
    "globenewswire.com",
    {
      domains: ["globenewswire.com"],
      tier: 3,
      classification: "Press Release",
      baseScore: 0.68,
    },
  ],
  [
    "platts.com",
    {
      domains: ["platts.com"],
      tier: 3,
      classification: "Commodity News",
      baseScore: 0.74,
    },
  ],
  [
    "oilprice.com",
    {
      domains: ["oilprice.com"],
      tier: 3,
      classification: "Commodity News",
      baseScore: 0.68,
    },
  ],

  // TIER 4: Retail & Community
  [
    "reddit.com",
    {
      domains: ["reddit.com"],
      tier: 4,
      classification: "Community Platform",
      baseScore: 0.45,
    },
  ],
  [
    "twitter.com",
    {
      domains: ["twitter.com", "x.com"],
      tier: 4,
      classification: "Social Network",
      baseScore: 0.42,
    },
  ],
  [
    "linkedin.com",
    {
      domains: ["linkedin.com"],
      tier: 4,
      classification: "Professional Network",
      baseScore: 0.5,
    },
  ],
  [
    "stocktwits.com",
    {
      domains: ["stocktwits.com"],
      tier: 4,
      classification: "Community Platform",
      baseScore: 0.48,
    },
  ],
  [
    "motley-fool.com",
    {
      domains: ["motley-fool.com", "motionfool.com"],
      tier: 4,
      classification: "Retail Analysis",
      baseScore: 0.52,
    },
  ],
  [
    "medium.com",
    {
      domains: ["medium.com"],
      tier: 4,
      classification: "Platform",
      baseScore: 0.44,
    },
  ],
  [
    "substack.com",
    {
      domains: ["substack.com"],
      tier: 4,
      classification: "Platform",
      baseScore: 0.43,
    },
  ],
  [
    "bogleheads.org",
    {
      domains: ["bogleheads.org"],
      tier: 4,
      classification: "Community Platform",
      baseScore: 0.48,
    },
  ],
  [
    "youtube.com",
    {
      domains: ["youtube.com"],
      tier: 4,
      classification: "Video Platform",
      baseScore: 0.45,
    },
  ],
  [
    "politico.eu",
    {
      domains: ["politico.eu", "politico-eu.com"],
      tier: 4,
      classification: "Political News",
      baseScore: 0.62,
    },
  ],

  // TIER 5: Unknown/Emerging (not added explicitly; handled by fallback)
]);

/**
 * Normalize a source domain or URL for lookup.
 * - Strips protocol (http://, https://)
 * - Removes 'www.' prefix
 * - Lowercases
 * - Removes trailing slashes
 * - Extracts base domain from subdomain.base.com patterns
 */
function normalizeDomain(source: string): string {
  try {
    // Handle URLs
    if (source.includes("://") || source.includes(".")) {
      const urlStr = source.includes("://") ? source : `https://${source}`;
      const url = new URL(urlStr);
      let host = url.hostname.toLowerCase();

      // Remove www prefix
      if (host.startsWith("www.")) {
        host = host.slice(4);
      }

      return host;
    }

    return source.toLowerCase().replace(/\/$/, "");
  } catch {
    // If URL parsing fails, just lowercase and clean
    return source
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/$/, "");
  }
}

/**
 * Normalize a source string for ownership-group matching.
 */
function normalizeSourceLabel(source: string): string {
  return source
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Get ownership group for a source domain or label.
 */
export function getOwnershipGroup(source: string): string | undefined {
  const normalizedDomain = normalizeDomain(source);
  const normalizedLabel = normalizeSourceLabel(source);

  for (const rule of ownershipGroupRules) {
    if (rule.pattern.test(normalizedDomain) || rule.pattern.test(normalizedLabel)) {
      return rule.ownershipGroup;
    }
  }

  return undefined;
}

/**
 * Compute an independence score for a set of sources.
 * Same domain and same ownership groups contribute very little incremental independence.
 */
export function computeIndependenceScore(sources: Array<string | { source: string }>): number {
  if (sources.length === 0) {
    return 0;
  }

  const seenDomains = new Set<string>();
  const seenOwnershipGroups = new Set<string>();
  let weightedScore = 0;

  for (const entry of sources) {
    const source = typeof entry === "string" ? entry : entry.source;
    const domain = normalizeDomain(source);
    const ownershipGroup = getOwnershipGroup(source);

    let contribution = 1.0;
    if (seenDomains.has(domain)) {
      contribution = 0.05;
    } else if (ownershipGroup && seenOwnershipGroups.has(ownershipGroup)) {
      contribution = 0.2;
    }

    weightedScore += contribution;
    seenDomains.add(domain);
    if (ownershipGroup) {
      seenOwnershipGroups.add(ownershipGroup);
    }
  }

  return Math.max(0, Math.min(1, weightedScore / sources.length));
}

/**
 * Retrieve credibility score for a source.
 * Checks overrides first, then database with domain normalization and fallback scoring.
 */
export function getSourceCredibility(source: string): SourceCredibilityOutput {
  const normalized = normalizeDomain(source);
  const ownership_group = getOwnershipGroup(source);

  // Check overrides first
  const override = credibilityOverrides.get(normalized);
  if (override) {
    return {
      score: override.score,
      tier: `Tier ${override.tier} ${getTierLabel(override.tier)}`,
      classification: override.classification,
      ownership_group,
    };
  }

  // Try exact match
  const entry = sourceDatabase.get(normalized);
  if (entry) {
    return {
      score: entry.baseScore,
      tier: `Tier ${entry.tier} ${getTierLabel(entry.tier)}`,
      classification: entry.classification,
      ownership_group: entry.ownershipGroup ?? ownership_group,
    };
  }

  // Try domain variants (www variant, parent domain, etc.)
  for (const [domain, sourceEntry] of sourceDatabase.entries()) {
    if (sourceEntry.domains.includes(normalized)) {
      return {
        score: sourceEntry.baseScore,
        tier: `Tier ${sourceEntry.tier} ${getTierLabel(sourceEntry.tier)}`,
        classification: sourceEntry.classification,
        ownership_group: sourceEntry.ownershipGroup ?? ownership_group,
      };
    }
  }

  // Try matching by domain suffix (e.g., blog.reuters.com → reuters.com)
  const parts = normalized.split(".");
  if (parts.length > 2) {
    const parentDomain = parts.slice(1).join(".");
    for (const [domain, sourceEntry] of sourceDatabase.entries()) {
      if (sourceEntry.domains.includes(parentDomain)) {
        // Slight score reduction for subdomain match
        return {
          score: Math.max(0.15, sourceEntry.baseScore - 0.05),
          tier: `Tier ${sourceEntry.tier} ${getTierLabel(sourceEntry.tier)}`,
          classification: sourceEntry.classification,
          ownership_group: sourceEntry.ownershipGroup ?? ownership_group,
        };
      }
    }
  }

  // Fallback: Tier 5 Unknown
  return {
    score: 0.25,
    tier: "Tier 5 Unknown",
    classification: "Unknown",
    ownership_group,
  };
}

/**
 * Get human-readable tier label.
 */
function getTierLabel(tier: SourceTier): string {
  const labels: Record<SourceTier, string> = {
    1: "Institutional",
    2: "Professional",
    3: "Specialized",
    4: "Retail",
    5: "Unknown",
  };
  return labels[tier];
}

/**
 * Check if a normalized domain is a known source in the database.
 */
export function isKnownSource(domain: string): boolean {
  const normalized = normalizeDomain(domain);
  if (sourceDatabase.has(normalized)) {
    return true;
  }

  // Check domain aliases
  for (const [, entry] of sourceDatabase.entries()) {
    if (entry.domains.includes(normalized)) {
      return true;
    }
  }

  // Check if it's a subdomain of a known source
  const parts = normalized.split(".");
  if (parts.length > 2) {
    const parentDomain = parts.slice(1).join(".");
    for (const [, entry] of sourceDatabase.entries()) {
      if (entry.domains.includes(parentDomain)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Dynamically override credibility for a source domain.
 * Useful for runtime adjustments based on institutional decisions or new sources.
 */
export function overrideCredibility(
  domain: string,
  tier: SourceTier,
  score: number,
  classification: string
): void {
  const normalized = normalizeDomain(domain);
  credibilityOverrides.set(normalized, { tier, score, classification });
}

/**
 * Clear a dynamic override for a source.
 */
export function clearOverride(domain: string): void {
  const normalized = normalizeDomain(domain);
  credibilityOverrides.delete(normalized);
}

/**
 * List all sources in the database (for debugging, analytics, or UI display).
 */
export function getAllSources(): Array<{
  domain: string;
  tier: SourceTier;
  classification: string;
  score: number;
}> {
  const result = [];
  for (const [domain, entry] of sourceDatabase.entries()) {
    result.push({
      domain,
      tier: entry.tier,
      classification: entry.classification,
      score: entry.baseScore,
    });
  }
  // Add overrides at the end
  for (const [domain, override] of credibilityOverrides.entries()) {
    result.push({
      domain,
      tier: override.tier,
      classification: override.classification,
      score: override.score,
    });
  }
  return result;
}

/**
 * Get sources by tier (e.g., all Tier 1 sources).
 */
export function getSourcesByTier(tier: SourceTier): string[] {
  const result = [];
  for (const [domain, entry] of sourceDatabase.entries()) {
    if (entry.tier === tier) {
      result.push(domain);
    }
  }
  return result;
}

/**
 * Count sources by tier.
 */
export function countSourcesByTier(): Record<SourceTier, number> {
  const counts: Record<SourceTier, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const [, entry] of sourceDatabase.entries()) {
    counts[entry.tier]++;
  }
  return counts;
}
