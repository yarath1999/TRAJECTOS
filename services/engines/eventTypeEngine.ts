export type SupportedEventType =
  | "MONETARY_POLICY"
  | "GEOPOLITICAL_ESCALATION"
  | "EARNINGS"
  | "AI_INFRASTRUCTURE"
  | "ENERGY_SUPPLY"
  | "CREDIT_STRESS"
  | "REGULATORY"
  | "LABOR_MARKET"
  | "SEMICONDUCTOR"
  | "CRYPTO"
  | "LIQUIDITY"
  | "SUPPLY_CHAIN"
  | "MACRO_DATA"
  | "DEFENSE"
  | "COMMODITIES"
  | "TECHNOLOGY"
  | "HEALTHCARE"
  | "CYBERSECURITY";

export type EventTypeInput = {
  title: string;
  description?: string;
  category?: string;
  entities?: string[];
  source?: string;
};

export type EventTypeOutput = {
  event_type: SupportedEventType;
  subtype?: string;
  confidence: number;
  reasoning: string[];
  tags: string[];
};

type ScoredMatch = {
  eventType: SupportedEventType;
  score: number;
  reason: string;
  subtype?: string;
  tags: Set<string>;
};

type SignalRule = {
  keywords: string[];
  score: number;
  reason: string;
  subtype?: string;
  tags?: string[];
};

const TYPE_ORDER: SupportedEventType[] = [
  "MONETARY_POLICY",
  "GEOPOLITICAL_ESCALATION",
  "EARNINGS",
  "AI_INFRASTRUCTURE",
  "ENERGY_SUPPLY",
  "CREDIT_STRESS",
  "REGULATORY",
  "LABOR_MARKET",
  "SEMICONDUCTOR",
  "CRYPTO",
  "LIQUIDITY",
  "SUPPLY_CHAIN",
  "MACRO_DATA",
  "DEFENSE",
  "COMMODITIES",
  "TECHNOLOGY",
  "HEALTHCARE",
  "CYBERSECURITY",
];

const TYPE_RULES: Record<SupportedEventType, SignalRule[]> = {
  MONETARY_POLICY: [
    {
      keywords: ["federal reserve", "fed", "ecb", "boj", "boe", "central bank", "interest rate", "rates", "rate cut", "rate hike", "hawkish", "dovish", "policy decision", "monetary policy"],
      score: 1.0,
      reason: "Direct monetary policy language detected.",
      tags: ["rates", "central-bank", "policy"],
    },
    {
      keywords: ["qt", "qe", "balance sheet", "liquidity drain", "reserve requirement"],
      score: 0.8,
      reason: "Balance sheet or liquidity policy language detected.",
      tags: ["liquidity", "central-bank"],
    },
  ],
  GEOPOLITICAL_ESCALATION: [
    {
      keywords: ["war", "missile", "strike", "attack", "military escalation", "border conflict", "ceasefire", "sanctions", "invasion", "conflict", "tensions", "hostilities"],
      score: 1.0,
      reason: "Geopolitical conflict or escalation language detected.",
      tags: ["geopolitics", "conflict"],
    },
    {
      keywords: ["iran", "israel", "russia", "ukraine", "china", "taiwan", "gaza", "nato"],
      score: 0.7,
      reason: "Conflict-prone geopolitical entity detected.",
      tags: ["geopolitics"],
    },
  ],
  EARNINGS: [
    {
      keywords: ["earnings", "revenue", "eps", "guidance", "quarterly results", "profit", "loss", "beat estimates", "missed estimates", "sales guidance", "margin"],
      score: 1.0,
      reason: "Company results or earnings language detected.",
      tags: ["earnings", "company-results"],
    },
    {
      keywords: ["annual report", "quarter", "q1", "q2", "q3", "q4"],
      score: 0.45,
      reason: "Quarterly reporting context detected.",
      tags: ["reporting"],
    },
  ],
  AI_INFRASTRUCTURE: [
    {
      keywords: ["ai infrastructure", "data center", "datacenter", "gpu cluster", "hyperscaler", "model training", "compute", "inference", "cloud capacity", "ai chips", "nvidia", "amd", "server demand"],
      score: 1.0,
      reason: "AI infrastructure or compute buildout language detected.",
      tags: ["ai", "infrastructure", "compute"],
    },
    {
      keywords: ["rack", "cooling", "power supply", "power demand", "grid capacity"],
      score: 0.6,
      reason: "Infrastructure constraints around AI compute detected.",
      tags: ["data-center"],
    },
  ],
  ENERGY_SUPPLY: [
    {
      keywords: ["oil supply", "crude supply", "opec", "production cut", "output cut", "refinery", "pipeline", "lng", "natural gas supply", "shipping disruption", "tankers", "energy supply"],
      score: 1.0,
      reason: "Energy supply or production language detected.",
      tags: ["energy", "supply"],
    },
    {
      keywords: ["barrel", "bpd", "spare capacity", "inventory draw", "stockpile"],
      score: 0.55,
      reason: "Supply-side energy inventory or capacity language detected.",
      tags: ["inventory", "capacity"],
    },
  ],
  CREDIT_STRESS: [
    {
      keywords: ["credit stress", "default", "default risk", "delinquency", "distress", "bankruptcy", "liquidity crunch", "borrower stress", "funding strain", "widening spreads", "spread widening"],
      score: 1.0,
      reason: "Credit stress or refinancing strain detected.",
      tags: ["credit", "stress"],
    },
    {
      keywords: ["bank exposure", "loan loss", "covenant", "downgrade", "ratings warning"],
      score: 0.65,
      reason: "Credit transmission risk detected.",
      tags: ["credit", "banks"],
    },
  ],
  REGULATORY: [
    {
      keywords: ["regulation", "regulatory", "rulemaking", "compliance", "approval", "license", "lawsuit", "antitrust", "investigation", "fine", "ban", "settlement"],
      score: 1.0,
      reason: "Regulatory, legal, or enforcement language detected.",
      tags: ["regulatory", "policy"],
    },
    {
      keywords: ["sec", "cftc", "ftc", "eu commission", "doj", "fca"],
      score: 0.8,
      reason: "Named regulatory authority detected.",
      tags: ["regulator"],
    },
  ],
  LABOR_MARKET: [
    {
      keywords: ["jobs", "payrolls", "unemployment", "labor market", "wages", "hiring", "layoffs", "jobless claims", "employment", "labor shortage"],
      score: 1.0,
      reason: "Labor market language detected.",
      tags: ["labor", "employment"],
    },
    {
      keywords: ["nonfarm", "payroll", "wage growth", "employment report"],
      score: 0.8,
      reason: "Labor market report context detected.",
      tags: ["macro-data", "labor"],
    },
  ],
  SEMICONDUCTOR: [
    {
      keywords: ["semiconductor", "chip", "chips", "foundry", "wafer", "fab", "gpu", "cpu", "memory chip", "nvidia", "tsmc", "intel", "amd", "asml"],
      score: 1.0,
      reason: "Semiconductor or chip industry language detected.",
      tags: ["semiconductor", "technology"],
    },
    {
      keywords: ["advanced packaging", "node", "node size", "export controls", "chip supply"],
      score: 0.7,
      reason: "Chip supply chain or manufacturing language detected.",
      tags: ["semiconductor", "supply-chain"],
    },
  ],
  CRYPTO: [
    {
      keywords: ["crypto", "bitcoin", "ethereum", "stablecoin", "defi", "blockchain", "token", "exchange-traded fund", "etf approval", "miner", "wallet"],
      score: 1.0,
      reason: "Cryptocurrency or digital asset language detected.",
      tags: ["crypto", "digital-assets"],
    },
    {
      keywords: ["hashrate", "on-chain", "mempool", "layer 2"],
      score: 0.6,
      reason: "Crypto market plumbing language detected.",
      tags: ["crypto", "network"],
    },
  ],
  LIQUIDITY: [
    {
      keywords: ["liquidity", "funding market", "repo", "reverse repo", "cash shortage", "tight conditions", "liquidity squeeze", "margin call", "forced selling", "dealer balance sheet"],
      score: 1.0,
      reason: "Liquidity stress or liquidity regime language detected.",
      tags: ["liquidity", "markets"],
    },
    {
      keywords: ["cash demand", "money market", "short-term funding", "spread widening"],
      score: 0.7,
      reason: "Short-term funding pressure detected.",
      tags: ["funding"],
    },
  ],
  SUPPLY_CHAIN: [
    {
      keywords: ["supply chain", "logistics", "shipping", "freight", "port", "delay", "backlog", "inventory shortage", "component shortage", "factory outage", "disruption"],
      score: 1.0,
      reason: "Supply chain disruption language detected.",
      tags: ["supply-chain", "logistics"],
    },
    {
      keywords: ["lead times", "delivery delays", "shipment", "container"],
      score: 0.55,
      reason: "Logistics or delivery friction detected.",
      tags: ["logistics"],
    },
  ],
  MACRO_DATA: [
    {
      keywords: ["cpi", "ppi", "gdp", "retail sales", "pmi", "pmi data", "inflation data", "jobs report", "labor report", "macro data", "consumer confidence", "industrial production"],
      score: 1.0,
      reason: "Macro data release language detected.",
      tags: ["macro-data", "economic-release"],
    },
    {
      keywords: ["survey", "flash estimate", "revision", "print"],
      score: 0.45,
      reason: "Macro data reporting context detected.",
      tags: ["data-release"],
    },
  ],
  DEFENSE: [
    {
      keywords: ["defense", "military", "weapons", "missile defense", "fighter jet", "naval", "army", "air force", "pentagon", "contract award", "arms"],
      score: 1.0,
      reason: "Defense or military procurement language detected.",
      tags: ["defense", "security"],
    },
    {
      keywords: ["security assistance", "munitions", "drone", "radar", "interceptor"],
      score: 0.6,
      reason: "Defense systems or procurement language detected.",
      tags: ["defense-tech"],
    },
  ],
  COMMODITIES: [
    {
      keywords: ["commodities", "gold", "silver", "copper", "aluminum", "wheat", "corn", "soybeans", "metals", "agriculture", "spot price"],
      score: 1.0,
      reason: "Commodity-specific language detected.",
      tags: ["commodities", "real-assets"],
    },
    {
      keywords: ["futures", "spot market", "inventory"],
      score: 0.4,
      reason: "Commodity market structure language detected.",
      tags: ["futures"],
    },
  ],
  TECHNOLOGY: [
    {
      keywords: ["technology", "tech", "software", "platform", "cloud", "product launch", "developer", "saas", "ai model", "data platform", "digital transformation"],
      score: 1.0,
      reason: "General technology language detected.",
      tags: ["technology"],
    },
    {
      keywords: ["subscription", "user growth", "beta", "deployment"],
      score: 0.35,
      reason: "Technology product lifecycle language detected.",
      tags: ["product"],
    },
  ],
  HEALTHCARE: [
    {
      keywords: ["healthcare", "pharma", "biotech", "drug approval", "clinical trial", "fda", "medtech", "medical device", "hospital", "insurance"],
      score: 1.0,
      reason: "Healthcare or life sciences language detected.",
      tags: ["healthcare"],
    },
    {
      keywords: ["trial results", "phase 3", "pipeline", "therapeutic"],
      score: 0.55,
      reason: "Drug development language detected.",
      tags: ["biotech"],
    },
  ],
  CYBERSECURITY: [
    {
      keywords: ["cybersecurity", "cyber attack", "ransomware", "data breach", "malware", "phishing", "vulnerability", "zero day", "incident response", "security breach"],
      score: 1.0,
      reason: "Cybersecurity event language detected.",
      tags: ["cybersecurity", "security"],
    },
    {
      keywords: ["patch", "exploit", "threat actor", "credential", "encrypted"],
      score: 0.6,
      reason: "Security compromise language detected.",
      tags: ["threat"],
    },
  ],
};

const ENTITY_HINTS: Array<{
  match: RegExp;
  type: SupportedEventType;
  boost: number;
  reason: string;
  subtype?: string;
  tags?: string[];
}> = [
  {
    match: /\b(fed|federal reserve|ecb|boj|boe|central bank|fomc)\b/i,
    type: "MONETARY_POLICY",
    boost: 0.15,
    reason: "Named central bank entity reinforced monetary policy classification.",
    subtype: "central_bank_action",
    tags: ["central-bank"],
  },
  {
    match: /\b(reuters|bloomberg|financial times|ft|wsj|ap)\b/i,
    type: "MACRO_DATA",
    boost: 0.05,
    reason: "High-reliability source used as a weak general confidence boost.",
    tags: ["reliable-source"],
  },
  {
    match: /\b(opec|eia|iea|exxon|shell|chevron|bp|saudi aramco)\b/i,
    type: "ENERGY_SUPPLY",
    boost: 0.12,
    reason: "Energy producer or agency entity reinforced supply classification.",
    subtype: "supply_update",
    tags: ["energy"],
  },
  {
    match: /\b(nvidia|amd|tsmc|intel|arm|asml)\b/i,
    type: "SEMICONDUCTOR",
    boost: 0.15,
    reason: "Semiconductor company entity reinforced chip classification.",
    subtype: "chip_company_event",
    tags: ["chips"],
  },
  {
    match: /\b(sec|cftc|fca|doj|ftc|eu commission|finra)\b/i,
    type: "REGULATORY",
    boost: 0.15,
    reason: "Regulatory authority entity reinforced regulatory classification.",
    subtype: "regulatory_action",
    tags: ["regulator"],
  },
  {
    match: /\b(ukraine|russia|china|taiwan|israel|iran|gaza|nato|pentagon|defense department)\b/i,
    type: "GEOPOLITICAL_ESCALATION",
    boost: 0.14,
    reason: "Geopolitical or military entity reinforced escalation classification.",
    subtype: "state_actor_event",
    tags: ["geopolitics"],
  },
  {
    match: /\b(bitcoin|ethereum|coinbase|binance|stablecoin|etf)\b/i,
    type: "CRYPTO",
    boost: 0.15,
    reason: "Crypto ecosystem entity reinforced digital asset classification.",
    subtype: "crypto_market_event",
    tags: ["digital-assets"],
  },
  {
    match: /\b(google|amazon|microsoft|openai|meta|anthropic|oracle|coreweave)\b/i,
    type: "AI_INFRASTRUCTURE",
    boost: 0.12,
    reason: "AI/platform entity reinforced AI infrastructure classification.",
    subtype: "infrastructure_buildout",
    tags: ["ai", "cloud"],
  },
  {
    match: /\b(pfizer|moderna|eli lilly|jnj|johnson & johnson|novartis|roche|fda)\b/i,
    type: "HEALTHCARE",
    boost: 0.12,
    reason: "Healthcare entity reinforced healthcare classification.",
    subtype: "healthcare_event",
    tags: ["healthcare"],
  },
  {
    match: /\b(microsoft|crowdstrike|okta|zscaler|palo alto|splunk)\b/i,
    type: "CYBERSECURITY",
    boost: 0.1,
    reason: "Cybersecurity entity reinforced cyber classification.",
    subtype: "security_event",
    tags: ["cybersecurity"],
  },
  {
    match: /\b(cpi|ppi|gdp|payrolls|jobs report|unemployment|retail sales)\b/i,
    type: "MACRO_DATA",
    boost: 0.12,
    reason: "Macro data release entity or headline reinforced macro classification.",
    subtype: "data_release",
    tags: ["macro-data"],
  },
];

const CATEGORY_HINTS: Array<{
  match: RegExp;
  type: SupportedEventType;
  boost: number;
  reason: string;
  subtype?: string;
  tags?: string[];
}> = [
  { match: /\b(macro|economy|inflation|jobs|labor|employment)\b/i, type: "MACRO_DATA", boost: 0.08, reason: "Category language suggests macro data.", subtype: "macro_release", tags: ["macro"] },
  { match: /\b(policy|rates|central bank|fed)\b/i, type: "MONETARY_POLICY", boost: 0.08, reason: "Category language suggests monetary policy.", subtype: "policy_move", tags: ["policy"] },
  { match: /\b(earnings|results|guidance|quarter)\b/i, type: "EARNINGS", boost: 0.08, reason: "Category language suggests earnings.", subtype: "earnings_update", tags: ["earnings"] },
  { match: /\b(crypto|digital asset|bitcoin|ethereum)\b/i, type: "CRYPTO", boost: 0.08, reason: "Category language suggests crypto.", subtype: "crypto_market", tags: ["crypto"] },
  { match: /\b(ai|semiconductor|chip|data center)\b/i, type: "AI_INFRASTRUCTURE", boost: 0.08, reason: "Category language suggests AI infrastructure.", subtype: "compute_infrastructure", tags: ["ai"] },
  { match: /\b(defense|military|security|geopolitical)\b/i, type: "DEFENSE", boost: 0.08, reason: "Category language suggests defense.", subtype: "defense_activity", tags: ["defense"] },
  { match: /\b(cyber|security breach|ransomware)\b/i, type: "CYBERSECURITY", boost: 0.08, reason: "Category language suggests cybersecurity.", subtype: "security_incident", tags: ["cybersecurity"] },
];

function clamp(min: number, value: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(value: unknown): string {
  return (typeof value === "string" ? value : "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function countMatches(haystack: string, keywords: string[]): number {
  let count = 0;
  for (const keyword of keywords) {
    const pattern = keyword.trim().toLowerCase();
    if (!pattern) continue;
    const regex = new RegExp(`\\b${pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\s+/g, "\\s+")}\\b`, "gi");
    const matches = haystack.match(regex);
    if (matches) count += matches.length;
  }
  return count;
}

function collectEntityMentions(text: string, entities: string[]): string[] {
  const mentions: string[] = [];
  for (const entity of entities) {
    const normalized = normalizeText(entity);
    if (!normalized) continue;
    if (text.includes(normalized)) mentions.push(entity.trim());
  }
  return Array.from(new Set(mentions));
}

function inferSubtypeFromText(eventType: SupportedEventType, text: string): string | undefined {
  switch (eventType) {
    case "MONETARY_POLICY":
      if (/rate cut|cut rates|dovish/i.test(text)) return "rate_cut";
      if (/rate hike|hike rates|hawkish/i.test(text)) return "rate_hike";
      if (/balance sheet|qt|quantitative tightening/i.test(text)) return "balance_sheet";
      return "policy_decision";
    case "EARNINGS":
      if (/beat|beats|above estimates/i.test(text)) return "beat";
      if (/miss|missed|below estimates/i.test(text)) return "miss";
      if (/guidance|outlook/i.test(text)) return "guidance";
      return "results";
    case "MACRO_DATA":
      if (/cpi|inflation/i.test(text)) return "inflation_print";
      if (/jobs|payroll|unemployment/i.test(text)) return "labor_release";
      if (/gdp/i.test(text)) return "growth_print";
      return "data_release";
    case "GEOPOLITICAL_ESCALATION":
      if (/sanction/i.test(text)) return "sanctions";
      if (/strike|attack|missile/i.test(text)) return "military_action";
      return "conflict_update";
    case "ENERGY_SUPPLY":
      if (/opec/i.test(text)) return "opec_action";
      if (/pipeline|shipping|tankers/i.test(text)) return "transport_disruption";
      return "supply_change";
    case "CREDIT_STRESS":
      if (/default|bankruptcy/i.test(text)) return "distress_event";
      if (/spread/i.test(text)) return "spread_widening";
      return "stress_event";
    case "REGULATORY":
      if (/fine|penalt/i.test(text)) return "enforcement_action";
      if (/approval|license/i.test(text)) return "approval_action";
      return "regulatory_action";
    case "LABOR_MARKET":
      if (/layoff/i.test(text)) return "layoffs";
      if (/wage/i.test(text)) return "wage_growth";
      return "labor_data";
    case "SEMICONDUCTOR":
      if (/export control/i.test(text)) return "export_controls";
      if (/foundry|fab|wafer/i.test(text)) return "manufacturing";
      return "chip_update";
    case "CRYPTO":
      if (/etf/i.test(text)) return "etf_flow";
      if (/stablecoin/i.test(text)) return "stablecoin_event";
      return "crypto_market";
    case "LIQUIDITY":
      if (/repo/i.test(text)) return "funding_market";
      if (/margin call|forced selling/i.test(text)) return "forced_liquidation";
      return "liquidity_event";
    case "SUPPLY_CHAIN":
      if (/port|shipping|logistics/i.test(text)) return "logistics_disruption";
      if (/component|inventory/i.test(text)) return "inventory_shortage";
      return "supply_chain_disruption";
    case "DEFENSE":
      if (/contract/i.test(text)) return "procurement";
      if (/weapon|missile|drone/i.test(text)) return "military_systems";
      return "defense_event";
    case "COMMODITIES":
      if (/gold|silver|copper|oil|gas|wheat|corn/i.test(text)) return "commodity_move";
      return "commodity_event";
    case "TECHNOLOGY":
      if (/cloud|platform|software/i.test(text)) return "platform_event";
      return "technology_event";
    case "HEALTHCARE":
      if (/fda|trial|approval/i.test(text)) return "clinical_or_approval";
      return "healthcare_event";
    case "CYBERSECURITY":
      if (/breach|ransomware|attack/i.test(text)) return "incident";
      return "security_event";
    case "AI_INFRASTRUCTURE":
      if (/data center|datacenter|gpu|compute/i.test(text)) return "compute_buildout";
      return "ai_infrastructure_event";
    default:
      return undefined;
  }
}

function scoreTextForType(input: string, type: SupportedEventType): ScoredMatch | null {
  const rules = TYPE_RULES[type];
  let score = 0;
  const reasons: string[] = [];
  const tags = new Set<string>();
  let subtype: string | undefined;

  for (const rule of rules) {
    const hits = countMatches(input, rule.keywords);
    if (hits <= 0) continue;

    const contribution = rule.score * (1 + Math.min(2, hits - 1) * 0.25);
    score += contribution;
    reasons.push(rule.reason);
    subtype = subtype ?? rule.subtype;
    for (const tag of rule.tags ?? []) tags.add(tag);
  }

  if (score <= 0) return null;

  return {
    eventType: type,
    score,
    reason: reasons.join(" "),
    subtype,
    tags,
  };
}

function applyEntityBoosts(
  match: ScoredMatch,
  text: string,
  entities: string[],
  category?: string,
  source?: string,
): ScoredMatch {
  const normalizedCategory = normalizeText(category);
  const normalizedSource = normalizeText(source);

  for (const hint of ENTITY_HINTS) {
    if (hint.type !== match.eventType) continue;

    if (hint.match.test(text) || hint.match.test(normalizedCategory) || hint.match.test(normalizedSource)) {
      match.score += hint.boost;
      match.reason += ` ${hint.reason}`;
      if (hint.subtype) match.subtype = match.subtype ?? hint.subtype;
      for (const tag of hint.tags ?? []) match.tags.add(tag);
    }
  }

  const mentions = collectEntityMentions(text, entities);
  if (mentions.length > 0) {
    match.score += Math.min(0.18, mentions.length * 0.04);
    match.reason += ` Entity mentions matched: ${mentions.join(", ")}.`;
    for (const entity of mentions) {
      match.tags.add(entity.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""));
    }
  }

  return match;
}

function applyCategoryFallback(
  match: ScoredMatch,
  text: string,
  category?: string,
  source?: string,
): ScoredMatch {
  for (const hint of CATEGORY_HINTS) {
    if (hint.type !== match.eventType) continue;
    if (hint.match.test(text) || hint.match.test(normalizeText(category)) || hint.match.test(normalizeText(source))) {
      match.score += hint.boost;
      match.reason += ` ${hint.reason}`;
      if (hint.subtype) match.subtype = match.subtype ?? hint.subtype;
      for (const tag of hint.tags ?? []) match.tags.add(tag);
    }
  }
  return match;
}

function rankMatches(matches: ScoredMatch[]): ScoredMatch[] {
  return matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return TYPE_ORDER.indexOf(a.eventType) - TYPE_ORDER.indexOf(b.eventType);
  });
}

function computeConfidence(primary: ScoredMatch, runnerUp: ScoredMatch | null, signalCount: number): number {
  const normalizedScore = clamp(0, primary.score / 2.5, 1);
  const margin = runnerUp ? Math.max(0, primary.score - runnerUp.score) : primary.score;
  const marginScore = clamp(0, margin / 1.25, 1);
  const signalScore = clamp(0, signalCount / 4, 1);
  const confidence = normalizedScore * 0.55 + marginScore * 0.3 + signalScore * 0.15;
  return clamp(0.05, confidence, 0.99);
}

function finalizeOutput(
  primary: ScoredMatch,
  runnerUp: ScoredMatch | null,
  reasoning: string[],
  confidence: number,
): EventTypeOutput {
  const tags = Array.from(primary.tags);
  if (runnerUp && runnerUp.score >= primary.score * 0.7) {
    reasoning.push(`Secondary signal also matched ${runnerUp.eventType} with score ${runnerUp.score.toFixed(2)}.`);
    for (const tag of runnerUp.tags) {
      if (!tags.includes(tag)) tags.push(tag);
    }
  }

  return {
    event_type: primary.eventType,
    subtype: primary.subtype ?? inferSubtypeFromText(primary.eventType, reasoning.join(" ")),
    confidence: Number(confidence.toFixed(3)),
    reasoning,
    tags,
  };
}

export function classifyEventType(input: EventTypeInput): EventTypeOutput {
  const title = normalizeText(input.title);
  const description = normalizeText(input.description);
  const category = normalizeText(input.category);
  const source = normalizeText(input.source);
  const entities = Array.isArray(input.entities) ? input.entities.map((entity) => entity.toString().trim()).filter(Boolean) : [];

  const combinedText = [title, description, category, source, entities.join(" ")].filter(Boolean).join(" ");

  const scored = TYPE_ORDER.map((eventType) => scoreTextForType(combinedText, eventType)).filter((match): match is ScoredMatch => !!match);
if (scored.length === 0) {
  return {
    event_type: "MACRO_DATA",
    subtype: "unclassified",
    confidence: 0.05,
    reasoning: [
      "No sufficiently strong event-type evidence was detected.",
      "Classification intentionally downgraded to unclassified fallback to avoid taxonomy contamination."
    ],
    tags: ["unclassified", "low-confidence", "fallback"],
  };
}

  const enriched = scored.map((match) => applyCategoryFallback(applyEntityBoosts(match, combinedText, entities, input.category, input.source), combinedText, input.category, input.source));
  const ranked = rankMatches(enriched);
  const primary = ranked[0];
  const runnerUp = ranked[1] ?? null;

  const signalCount = TYPE_RULES[primary.eventType].reduce((count, rule) => count + countMatches(combinedText, rule.keywords), 0);
  const confidence = computeConfidence(primary, runnerUp, signalCount);

  const reasoning: string[] = [
    primary.reason,
    `Primary score ${primary.score.toFixed(2)} from weighted keyword and entity matches.`,
  ];

  if (runnerUp) {
    reasoning.push(`Runner-up signal ${runnerUp.eventType} scored ${runnerUp.score.toFixed(2)}.`);
  }

  const typeSpecificSubtype = primary.subtype ?? inferSubtypeFromText(primary.eventType, combinedText);
  const tags = Array.from(new Set(primary.tags));

  return {
    event_type: primary.eventType,
    subtype: typeSpecificSubtype,
    confidence,
    reasoning,
    tags,
  };
}

export function classifyEventFromText(
  title: string,
  description?: string,
  category?: string,
  entities?: string[],
  source?: string,
): EventTypeOutput {
  return classifyEventType({ title, description, category, entities, source });
}

export function getEventTypeCandidates(input: EventTypeInput): Array<EventTypeOutput & { score?: number }> {
  const title = normalizeText(input.title);
  const description = normalizeText(input.description);
  const category = normalizeText(input.category);
  const source = normalizeText(input.source);
  const entities = Array.isArray(input.entities) ? input.entities.map((entity) => entity.toString().trim()).filter(Boolean) : [];
  const combinedText = [title, description, category, source, entities.join(" ")].filter(Boolean).join(" ");

  return rankMatches(
    TYPE_ORDER.map((eventType) => scoreTextForType(combinedText, eventType))
      .filter((match): match is ScoredMatch => !!match)
      .map((match) => applyCategoryFallback(applyEntityBoosts(match, combinedText, entities, input.category, input.source), combinedText, input.category, input.source)),
  ).map((match, index, arr) => ({
    event_type: match.eventType,
    subtype: match.subtype,
    confidence: computeConfidence(match, arr[index + 1] ?? null, TYPE_RULES[match.eventType].reduce((count, rule) => count + countMatches(combinedText, rule.keywords), 0)),
    reasoning: [match.reason],
    tags: Array.from(match.tags),
    score: match.score,
  }));
}

export function isSupportedEventType(value: string): value is SupportedEventType {
  return TYPE_ORDER.includes(value as SupportedEventType);
}
