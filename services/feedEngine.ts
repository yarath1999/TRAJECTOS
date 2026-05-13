import { createSupabaseServerClient } from "./newsFetcher";
import { summarizeForFeed, canonicalizeForDedup, dedupeScore } from "./newsSummarizer";

export type FeedItem = {
  id: string;
  title: string;
  summary: string;
  category: string;
  source: string | null;
  published_at: string | null;
  importance_score: "High" | "Medium" | "Low";
  sentiment: number | null;
  affected_assets: string[];
  regime_hint: string | null;
  bookmarkable: boolean;
  market_impact?: "Critical" | "Moderate" | "Low";
  confidence_signal?: "Strong Signal" | "Mixed Signal" | "Weak Signal";
  why_this_matters?: string;
  cluster_id?: string | null;
};

const CATEGORIES = ["Markets","Economy","Geopolitics","Technology","Energy","Crypto","AI","Global"] as const;

function guessCategory(tags: string[] | null | undefined, text?: string): string {
  const t = (text ?? "").toLowerCase();
  const tagset = (tags ?? []).map((s) => s.toString().toLowerCase());

  // Crypto
  if (
    tagset.includes('crypto') ||
    t.includes('crypto') ||
    t.includes('bitcoin') ||
    t.includes('ethereum') ||
    t.includes('solana') ||
    t.includes('binance')
  ) {
    return 'Crypto';
  }

  // AI
  if (
    tagset.includes('ai') ||
    t.includes('artificial intelligence') ||
    t.includes('openai') ||
    t.includes('chatgpt') ||
    t.includes('llm') ||
    t.includes('nvidia') ||
    t.includes('anthropic')
  ) {
    return 'AI';
  }

  // Energy
  if (
    t.includes('oil') ||
    t.includes('gas') ||
    t.includes('energy') ||
    t.includes('opec') ||
    tagset.includes('energy')
  ) {
    return 'Energy';
  }

  // Economy
  if (
    t.includes('inflation') ||
    t.includes('interest rate') ||
    t.includes('fed') ||
    t.includes('central bank') ||
    t.includes('gdp') ||
    t.includes('economy') ||
    t.includes('recession')
  ) {
    return 'Economy';
  }

  // Markets
  if (
    t.includes('market') ||
    t.includes('stocks') ||
    t.includes('equities') ||
    t.includes('nasdaq') ||
    t.includes('s&p') ||
    t.includes('dow jones')
  ) {
    return 'Markets';
  }

  // Geopolitics
  if (
    t.includes('war') ||
    t.includes('conflict') ||
    t.includes('sanctions') ||
    t.includes('military') ||
    t.includes('china') ||
    t.includes('russia') ||
    t.includes('iran') ||
    t.includes('ukraine')
  ) {
    return 'Geopolitics';
  }

  // Technology
  if (
    t.includes('technology') ||
    t.includes('software') ||
    t.includes('semiconductor') ||
    t.includes('chip') ||
    t.includes('cloud')
  ) {
    return 'Technology';
  }

  return 'Global';
}

function importanceFromSignals(
  insightConfidence?: number | null,
  hasBreaking?: boolean
): "High" | "Medium" | "Low" {

  if (hasBreaking) return 'High';

  const conf = Number(insightConfidence ?? 0);

  if (conf >= 0.8) return 'High';

  if (conf >= 0.6) return 'Medium';

  return 'Low';
}

function calculateMarketImpact(affectedAssets: string[] | null, breaking: boolean, confidence: number | null): "Critical" | "Moderate" | "Low" {
  const assetCount = Array.isArray(affectedAssets) ? affectedAssets.length : 0;
  const conf = Number(confidence ?? 0.5);
  if (breaking || (conf >= 0.8 && assetCount >= 3)) return 'Critical';
  if (conf >= 0.65 || assetCount >= 2) return 'Moderate';
  return 'Low';
}

function getConfidenceSignal(confidence: number | null, breaking: boolean): "Strong Signal" | "Mixed Signal" | "Weak Signal" {
  const conf = Number(confidence ?? 0.5);
  if (breaking) return 'Strong Signal';
  if (conf >= 0.7) return 'Strong Signal';
  if (conf >= 0.45) return 'Mixed Signal';
  return 'Weak Signal';
}

export type QueryFeedOpts = {
  limit?: number;
  offset?: number;
  category?: string | null;
  importance?: string | null;
  q?: string | null;
};

export async function queryIntelligenceFeed(opts: QueryFeedOpts = {}): Promise<FeedItem[]> {
  const supabase = createSupabaseServerClient();
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  let query = supabase
    .from('event_insights')
    .select('id,cluster_id,insight,reasoning,confidence,created_at')
.order('confidence', { ascending: false })
.order('created_at', { ascending: false });
  // if (opts.category) {
  //   query = query.eq('reasoning->>category', opts.category as string);
  // }

  if (opts.importance) {
    // importance is derived server-side; we filter by confidence bands
    if (opts.importance === 'High') query = query.gte('confidence', 0.75);
    else if (opts.importance === 'Medium') query = query.gte('confidence', 0.45).lt('confidence', 0.75);
    else if (opts.importance === 'Low') query = query.lt('confidence', 0.45);
  }

  if (opts.q) {
    const q = opts.q.toLowerCase();
    query = query.ilike('insight', `%${q}%`);
  }

  // range uses start..end indexes
  const start = offset;
  const end = Math.max(0, offset + limit - 1);
  const { data, error } = await query.range(start, end);
  if (error) throw new Error(`Failed to load insights: ${error.message}`);

  const rows = (data ?? []) as any[];
  console.log("RAW ROW SAMPLE:", rows[0]);

  // Deduplicate near-duplicates in-memory using canonicalization + threshold
  const items: Array<{ id:string; title:string; text:string; row:any }> = [];
  for (const r of rows) {
    const insightText = String(r.insight ?? '').toLowerCase();

if (
  insightText.includes('mixed macro exposures') &&
  Number(r.confidence ?? 0) < 0.7
) {
  continue;
}
const title =
  (
    r.reasoning &&
    (
      r.reasoning.event_summary ||
      r.reasoning.summary ||
      r.reasoning.title
    )
  ) ??
  r.insight ??
  'Market Intelligence';

const text =
  r.insight ??
  (r.reasoning && JSON.stringify(r.reasoning)) ??
  '';
    items.push({ id: r.id, title: String(title), text: String(text), row: r });
  }

const picked: any[] = [];
const seenCanon = new Set<string>();

for (const it of items) {
  const canon = canonicalizeForDedup(it.title, it.text);

  // Prevent exact duplicates
  if (seenCanon.has(canon)) {
    continue;
  }

  let isDup = false;

  for (const s of seenCanon) {
    const score = dedupeScore(canon, s);

    if (score > 0.45) {
      isDup = true;
      break;
    }
  }

  if (isDup) continue;

  seenCanon.add(canon);
  picked.push(it.row);
}

  // Map to FeedItem
  const out: FeedItem[] = picked.map((r) => {
    const title = (
  (
    r.reasoning &&
    (
      r.reasoning.event_summary ||
      r.reasoning.summary ||
      r.reasoning.title
    )
  ) ??
  r.insight ??
  'Market Intelligence'
) as string;
const text =
  (
    r.reasoning &&
    (
      Array.isArray(r.reasoning.market_implications)
        ? r.reasoning.market_implications.join(' ')
        : null
    )
  ) ||
  (
    r.reasoning &&
    (
      r.reasoning.text ||
      r.reasoning.body ||
      r.reasoning.summary ||
      r.reasoning.insight ||
      r.reasoning.event_summary
    )
  ) ||
  r.insight ||
  '';
    const summary = summarizeForFeed(text || title);
    const category = guessCategory((r.reasoning && r.reasoning.tags) ?? null, title + ' ' + text);
    const importance = importanceFromSignals(Number(r.confidence ?? null), !!r.breaking);
    const sentiment = typeof r.sentiment === 'number' ? r.sentiment : null;
    // const affected = Array.isArray(r.affected_assets) ? r.affected_assets.map(String) : [];
    const affected: string[] = [];
    const why = (() => {
      const candidate = (r.reasoning && (r.reasoning.summary || r.reasoning.insight)) ?? '';
      if (!candidate) return '';
      // Extract up to two short sentences
      const sents = String(candidate).split(/[\.\!\?]+\s/).map((s:any)=>s.trim()).filter(Boolean);
      return (sents.slice(0,2).join('. ') + (sents.slice(0,2).length ? '.' : '')).slice(0,280);
    })();

    return {
      id: String(r.id),
      title: title,
      summary,
      category,
      source: null,
      published_at: r.created_at ?? null,
      importance_score: importance,
      sentiment,
      affected_assets: affected,
      regime_hint: (r.reasoning && r.reasoning.regime) ?? null,
      bookmarkable: true,
      why_this_matters: why,
      cluster_id: r.cluster_id ?? null,
      market_impact: calculateMarketImpact(affected, false, Number(r.confidence ?? null)),
      confidence_signal: getConfidenceSignal(Number(r.confidence ?? null), false),
    } as FeedItem;
  });

  let filtered = out;

if (opts.category) {
  filtered = filtered.filter(
    (item) => item.category === opts.category
  );
}

return filtered;
}

export const FEED_CATEGORIES = CATEGORIES;
