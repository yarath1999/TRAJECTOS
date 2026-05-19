import { queryIntelligenceFeed } from "./feedEngine";

export type DigestSummary = {
  generated_at: string;
  period: string; // e.g., "2026-05-11"
  total_items: number;
  by_category: Record<string, { count: number; critical_count: number }>;
  top_assets: Array<{ asset: string; mention_count: number }>;
  signal_breakdown: { strong: number; mixed: number; weak: number };
  key_stories: Array<{ id: string; title: string; category: string; impact: string }>;
};

export async function generateDailyDigest(): Promise<DigestSummary> {
  // Load all insights from today (deterministic, no predictions)
  const today = new Date().toISOString().split('T')[0];
  const items = (await queryIntelligenceFeed({ limit: 200 })).items;

  const categoryCounts: Record<string, { count: number; critical_count: number }> = {};
  const assetMentions: Record<string, number> = {};
  const signals = { strong: 0, mixed: 0, weak: 0 };
  const keyStories: Array<{ id: string; title: string; category: string; impact: string }> = [];

  for (const item of items) {
    // Category stats
    const cat = item.category;
    if (!categoryCounts[cat]) categoryCounts[cat] = { count: 0, critical_count: 0 };
    categoryCounts[cat].count++;
    if (item.market_impact === 'Critical') categoryCounts[cat].critical_count++;

    // Asset mentions
    for (const asset of item.affected_assets) {
      assetMentions[asset] = (assetMentions[asset] ?? 0) + 1;
    }

    // Signal breakdown
    if (item.confidence_signal === 'Strong Signal') signals.strong++;
    else if (item.confidence_signal === 'Mixed Signal') signals.mixed++;
    else if (item.confidence_signal === 'Weak Signal') signals.weak++;

    // Top stories (critical + strong signal)
    if (item.market_impact === 'Critical' || item.confidence_signal === 'Strong Signal') {
      if (keyStories.length < 10) {
        keyStories.push({
          id: item.id,
          title: item.title,
          category: item.category,
          impact: item.market_impact ?? 'Moderate',
        });
      }
    }
  }

  // Sort top assets by mention count
  const topAssets = Object.entries(assetMentions)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([asset, mention_count]) => ({ asset, mention_count }));

  return {
    generated_at: new Date().toISOString(),
    period: today,
    total_items: items.length,
    by_category: categoryCounts,
    top_assets: topAssets,
    signal_breakdown: signals,
    key_stories: keyStories,
  };
}

// Store digest in a simple JSON format (could use DB if needed)
export async function saveDailyDigest(digest: DigestSummary): Promise<void> {
  // In production, save to Supabase or blob storage
  // For now, this is a deterministic log-only function
  console.info("Daily digest generated", {
    period: digest.period,
    generated_at: digest.generated_at,
    total_items: digest.total_items,
    category_count: Object.keys(digest.by_category).length,
    key_story_count: digest.key_stories.length,
  });
}
