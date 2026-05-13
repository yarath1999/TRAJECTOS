# Trajectos Intelligence Feed V1

This document describes the V1 Intelligence Feed backend.

Design goals
- Reuse existing ingestion pipeline (no separate news fetch).
- Provide concise, factual, mobile-friendly summaries (60–70 words).
- Deduplicate near-identical items.
- Keep allocation and regime engines isolated.

Source
- The feed reads from `event_insights` (existing ingestion outputs and reasoning).

Feed model
```
{
  id,
  title,
  summary,
  category,
  source,
  published_at,
  importance_score, // High | Medium | Low
  sentiment,
  affected_assets,
  regime_hint,
  bookmarkable
}
```

Categories
- Markets, Economy, Geopolitics, Technology, Energy, Crypto, AI, Global

Summaries
- Deterministic, local summarizer in `services/newsSummarizer.ts`.
- 60–70 words, short sentences, truncated if needed; no external LLMs used.

Deduplication
- In-memory canonicalization + simple overlap scoring (Jaccard-like) to suppress near-duplicates.
- Threshold tuned to 0.65 overlap.

Importance scoring
- Derived from insight confidence and a `breaking` flag when present.
- High / Medium / Low buckets.

Isolation
- The feed is read-only and does not alter pipeline tables or behavior.
- No coupling to allocation or regime engines; `regime_hint` is read-only diagnostic.

Files
- `services/feedEngine.ts` — feed loading, mapping, dedupe, scoring
- `services/newsSummarizer.ts` — summary and dedupe helpers
- `app/intelligence/page.tsx` — simple feed UI (SSR)

Additions in V1.1
- `supabase/migrations/0002_intelligence_bookmarks.sql` — DB migration to store user bookmarks
- `services/bookmarks.ts` — bookmark helpers using Supabase auth
- `app/api/intelligence/bookmark` — API endpoints to toggle/list bookmarks
- `app/api/intelligence/feed` — paginated feed API used by the UI
- `app/api/intelligence/related` — lightweight read-only allocation cluster lookup
- `app/intelligence/FeedClient.tsx` — client-side interactive feed with filters, search, infinite scroll, bookmark toggles, related allocation preview, and "why this matters" excerpt

Notes
- Bookmarks are stored per-user and require authentication (access token).
- The feed UI is now client-side to support interactive filters and infinite scroll. Server-side rendering kept minimal for SEO.

Mobile-First V1.1 Optimization
- **Card-based UI**: Each feed item rendered as a responsive card with proper spacing for touch interaction (min 44px tap targets).
- **Dark mode**: Auto-detects user preference via `prefers-color-scheme`; toggle button included in header.
- **Skeleton loaders**: Placeholder cards shown during initial load and infinite scroll to reduce perceived latency.
- **Pull-to-refresh**: Gesture support on mobile; drag from top to refresh feed while at scroll position 0.
- **Category tabs**: Horizontal scrollable category filter strip for quick browsing (no dropdown on mobile).
- **Swipe-friendly**: Buttons use flex layout for responsive sizing; touch targets min 44x44px as per accessibility guidelines.
- **Share support**: Native Web Share API on supported platforms; fallback to copy-to-clipboard.
- **Bookmark animations**: Visual feedback (scale + color) when saving items; copy feedback shows "✓ Copied" with color transition.
- **Typography**: Responsive font sizes; summaries tuned to 5–7 second read time using 14px body text and 1.5 line-height.
- **Color scheme**: Text, borders, and backgrounds adapt to dark mode; high contrast maintained for accessibility.
- **Related Allocation**: Collapsible section to keep card height manageable on mobile.

Performance Notes
- Feed pagination uses offset/limit for simplicity; consider cursor-based pagination if feed grows >10k items.
- Dark mode preference stored in component state; can be persisted to localStorage if desired.
- Bookmarks require auth token; implement graceful fallback or prompt if user not signed in.
- Summary copy uses `navigator.clipboard`; fallback to alert() for older browsers if needed.

Intelligence Enrichment V1.2
- **Market Impact Indicators**: Critical/Moderate/Low badges derived from breaking flag, confidence score, and affected asset count.
- **Confidence Signal Labels**: Strong Signal (>0.7 confidence or breaking), Mixed Signal (0.45–0.7), Weak Signal (<0.45).
- **Regime Hint Badges**: Show regime context from `event_insights.reasoning.regime` as read-only informational tags.
- **Affected Asset Tags**: Display all assets impacted by the event; limited to 8 visible with count overflow.
- **Daily Intelligence Digest**: `services/intelligenceDigest.ts` generates deterministic daily summaries (not real-time) with:
  - Total item count by category
  - Critical impact count per category
  - Top mentioned assets
  - Signal breakdown (strong/mixed/weak)
  - Key stories (critical + strong signal)
- **Cross-Linking API** (`/api/intelligence/related-items`):
  - Related stories: same category, within 7 days
  - Related sectors: overlapping affected assets
  - Related themes: macro themes and regime contexts
  - All deterministic and read-only; no predictions or ML
- **Isolation Guarantees**: Feed enrichment does NOT:
  - Trigger allocations or regime engine changes
  - Use AI/ML for predictions or recommendations
  - Modify event_insights, event_clusters, or macro_events tables
  - Interfere with allocation determinism

Implementation Notes
- Market impact = f(breaking, confidence, asset_count); tuned for quick scanability
- Confidence signal = f(confidence_score, breaking); communicates signal reliability
- Cross-linking uses in-memory deduplication (same as feed); O(n²) with n<500 items
- Digest generation is daily-only; not real-time to avoid coupling with ingestion
- All badges and tags are deterministic; same inputs always produce same output

Validation
- `npm run typecheck` should succeed after adding these files.
