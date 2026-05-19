/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from 'next/server';
import { queryIntelligenceFeed } from '../../../../services/feedEngine';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const feedItemId = url.searchParams.get('feed_item_id');
    const type = url.searchParams.get('type') ?? 'all'; // 'stories', 'sectors', 'themes'

    if (!feedItemId) return new NextResponse('Missing feed_item_id', { status: 400 });

    // Load feed to find the source item
    const feed = (await queryIntelligenceFeed({ limit: 100 })).items;
    const sourceItem = feed.find((it) => it.id === feedItemId);
    if (!sourceItem) return new NextResponse('Item not found', { status: 404 });

    const related: any = { stories: [], sectors: [], themes: [] };

    // Related stories: same category, different source, within 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (type === 'all' || type === 'stories') {
      related.stories = feed
        .filter(
          (it) =>
            it.id !== feedItemId &&
            it.category === sourceItem.category &&
            new Date(it.published_at ?? '') > sevenDaysAgo
        )
        .slice(0, 5)
        .map((it) => ({ id: it.id, title: it.title, source: it.source }));
    }

    // Related sectors: overlapping affected_assets
    if (type === 'all' || type === 'sectors') {
      const sourceAssets = new Set(sourceItem.affected_assets);
      const sectorMap: Record<string, number> = {};
      for (const it of feed) {
        if (it.id === feedItemId) continue;
        let overlap = 0;
        for (const asset of it.affected_assets) {
          if (sourceAssets.has(asset)) overlap++;
        }
        if (overlap > 0) {
          for (const asset of it.affected_assets) {
            sectorMap[asset] = (sectorMap[asset] ?? 0) + overlap;
          }
        }
      }
      related.sectors = Object.entries(sectorMap)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([asset]) => asset);
    }

    // Related themes: common categories and regime hints
    if (type === 'all' || type === 'themes') {
      const themeMap: Record<string, number> = {};
      // Extract from reasoning/tags or use category as theme
      for (const it of feed) {
        if (it.id === feedItemId) continue;
        if (it.category === sourceItem.category) {
          themeMap['Category: ' + it.category] = (themeMap['Category: ' + it.category] ?? 0) + 1;
        }
        if (it.regime_hint && sourceItem.regime_hint && it.regime_hint === sourceItem.regime_hint) {
          themeMap['Regime: ' + it.regime_hint.slice(0, 20)] = (themeMap['Regime: ' + it.regime_hint.slice(0, 20)] ?? 0) + 1;
        }
      }
      related.themes = Object.entries(themeMap)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([theme]) => theme);
    }

    return NextResponse.json({ related });
  } catch (err: any) {
    return new NextResponse(JSON.stringify({ error: err?.message ?? String(err) }), { status: 500 });
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */