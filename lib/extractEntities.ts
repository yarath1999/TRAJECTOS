function uniqLimit(values: string[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const key = v.toLowerCase();
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
    if (out.length >= limit) break;
  }
  return out;
}

function normalizeSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function addIfFound(out: string[], haystack: string, label: string, patterns: RegExp[]): void {
  for (const p of patterns) {
    if (p.test(haystack)) {
      out.push(label);
      return;
    }
  }
}

/**
 * Lightweight entity extraction.
 *
 * Heuristics:
 * - Companies: sequences of capitalized tokens, plus common suffixes.
 * - Countries: predefined list.
 * - Commodities: keyword list.
 * - Major institutions: Fed/ECB/IMF/etc.
 */
export function extractEntities(text: string): string[] {
  const raw = normalizeSpace((text ?? "").toString());
  if (!raw) return [];

  const out: string[] = [];
  const lower = raw.toLowerCase();

  // Countries (keep list compact but useful).
  const countries = [
    "United States",
    "US",
    "U.S.",
    "United Kingdom",
    "UK",
    "China",
    "India",
    "Japan",
    "Germany",
    "France",
    "Italy",
    "Spain",
    "Canada",
    "Australia",
    "Brazil",
    "Mexico",
    "Russia",
    "Ukraine",
    "Israel",
    "Iran",
    "Iraq",
    "Saudi Arabia",
    "UAE",
    "United Arab Emirates",
    "Turkey",
    "South Africa",
    "Nigeria",
    "Argentina",
    "South Korea",
    "Korea",
    "Indonesia",
    "Vietnam",
    "Thailand",
    "Singapore",
    "Malaysia",
    "Philippines",
    "Pakistan",
    "Bangladesh",
    "Sri Lanka",
    "Switzerland",
    "Sweden",
    "Norway",
    "Denmark",
    "Netherlands",
    "Belgium",
    "Poland",
    "Czech Republic",
    "Hungary",
    "Austria",
    "Greece",
    "Portugal",
    "Ireland",
  ];

  for (const c of countries) {
    const needle = c.toLowerCase();
    if (needle.length <= 2) {
      // Short forms: require word boundary.
      const re = new RegExp(`\\b${needle.replace(/\./g, "\\.")}\\b`, "i");
      if (re.test(raw)) out.push(c);
    } else if (lower.includes(needle)) {
      out.push(c);
    }
  }

  // Commodities.
  addIfFound(out, lower, "Oil", [/\boil\b/, /\bcrude\b/, /\bbrent\b/, /\bwti\b/]);
  addIfFound(out, lower, "Natural Gas", [/\bnatural gas\b/, /\bgas\b/]);
  addIfFound(out, lower, "Gold", [/\bgold\b/]);
  addIfFound(out, lower, "Silver", [/\bsilver\b/]);
  addIfFound(out, lower, "Copper", [/\bcopper\b/]);
  addIfFound(out, lower, "Wheat", [/\bwheat\b/]);
  addIfFound(out, lower, "Corn", [/\bcorn\b/]);
  addIfFound(out, lower, "Soy", [/\bsoy\b/, /\bsoybean\b/, /\bsoybeans\b/]);

  // Major financial institutions.
  addIfFound(out, raw, "Fed", [/\bFed\b/, /Federal Reserve/i, /federalreserve\.gov/i]);
  addIfFound(out, raw, "ECB", [/\bECB\b/, /European Central Bank/i]);
  addIfFound(out, raw, "IMF", [/\bIMF\b/, /International Monetary Fund/i]);
  addIfFound(out, raw, "World Bank", [/World Bank/i]);
  addIfFound(out, raw, "BoE", [/\bBoE\b/, /Bank of England/i]);
  addIfFound(out, raw, "BoJ", [/\bBoJ\b/, /Bank of Japan/i]);
  addIfFound(out, raw, "PBoC", [/\bPBoC\b/, /People'?s Bank of China/i]);
  addIfFound(out, raw, "OPEC", [/\bOPEC\b/]);
  addIfFound(out, raw, "IEA", [/\bIEA\b/, /International Energy Agency/i]);

  // Company names (very lightweight): capture sequences of capitalized tokens.
  // Exclude common sentence starters and short tokens.
  const stop = new Set([
    "The",
    "A",
    "An",
    "And",
    "Or",
    "Of",
    "To",
    "In",
    "For",
    "On",
    "At",
    "By",
    "With",
    "From",
    "As",
    "After",
    "Before",
    "Amid",
  ]);

  const companySuffix = /(Inc\.|Inc|Corp\.|Corp|Corporation|Ltd\.|Ltd|PLC|Group|Holdings|Bank|Partners|Capital|Technologies|Systems|Energy|Motors|Airlines)$/;

  const tokens = raw
    .replace(/[\(\)\[\]"'“”‘’]/g, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);

  const candidates: string[] = [];
  let current: string[] = [];

  function flush(): void {
    if (current.length === 0) return;
    const phrase = current.join(" ");
    current = [];

    const cleaned = phrase.replace(/[^A-Za-z0-9&\.\-\s]/g, "").trim();
    if (!cleaned) return;

    // Require at least two tokens, or a known suffix.
    const parts = cleaned.split(/\s+/).filter(Boolean);
    const hasSuffix = companySuffix.test(parts[parts.length - 1] ?? "");
    if (parts.length < 2 && !hasSuffix) return;

    // Avoid adding if it matches known non-company entities.
    const lowerClean = cleaned.toLowerCase();
    if (lowerClean.includes("federal reserve") || lowerClean === "imf") return;
    candidates.push(cleaned);
  }

  for (const t of tokens) {
    const plain = t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9\.\-&]+$/g, "");
    if (!plain) {
      flush();
      continue;
    }

    const isCap = /^[A-Z][A-Za-z0-9\.&\-]*$/.test(plain);
    if (!isCap || stop.has(plain)) {
      flush();
      continue;
    }

    current.push(plain);
    if (current.length >= 4) {
      // cap phrase length
      flush();
    }
  }
  flush();

  // Prefer longer company candidates first.
  candidates.sort((a, b) => b.length - a.length);
  out.push(...candidates.slice(0, 10));

  return uniqLimit(out, 30);
}
