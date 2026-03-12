import { createSupabaseServerClient } from "./newsFetcher";

type ClusterRow = {
  id: string;
};

type ArticleRow = {
  title: string | null;
  description: string | null;
  published_at?: string | null;
};

function normalizeTitlePattern(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickCanonicalTitle(articles: ArticleRow[]): string {
  // Prefer the most frequent title "pattern"; fallback to first non-empty title.
  const counts = new Map<string, { count: number; firstIndex: number; raw: string }>();

  for (let index = 0; index < articles.length; index += 1) {
    const raw = (articles[index]?.title ?? "").toString().trim();
    if (!raw) continue;

    const pattern = normalizeTitlePattern(raw);
    if (!pattern) continue;

    const existing = counts.get(pattern);
    if (existing) {
      existing.count += 1;
      continue;
    }

    counts.set(pattern, { count: 1, firstIndex: index, raw });
  }

  let best: { count: number; firstIndex: number; raw: string } | null = null;
  for (const entry of counts.values()) {
    if (!best) {
      best = entry;
      continue;
    }

    if (entry.count > best.count) {
      best = entry;
      continue;
    }

    if (entry.count === best.count && entry.firstIndex < best.firstIndex) {
      best = entry;
    }
  }

  if (best?.raw) return best.raw;

  for (const a of articles) {
    const t = (a.title ?? "").toString().trim();
    if (t) return t;
  }

  return "";
}

function buildCanonicalSummary(articles: ArticleRow[]): string {
  const parts: string[] = [];

  for (const a of articles) {
    const d = (a.description ?? "").toString().trim();
    if (!d) continue;
    parts.push(d);
    if (parts.length >= 5) break;
  }

  return parts.join(" ");
}

export async function runCanonicalizer(): Promise<void> {
  const supabase = createSupabaseServerClient();

  // 1) Load clusters that do not yet have canonical entries.
  // Supabase/PostgREST doesn't support NOT IN (subquery) directly via the query builder,
  // so we use a left join and filter nulls (equivalent semantics).
  const { data: clusters, error: clustersError } = await supabase
    .from("event_clusters")
    .select("id, canonical_events!left(cluster_id)")
    .is("canonical_events.cluster_id", null)
    .limit(20);

  if (clustersError) {
    throw new Error(`Failed to load clusters: ${clustersError.message}`);
  }

  const clusterRows = (clusters as Array<ClusterRow & { canonical_events?: unknown }> | null) ?? [];
  if (clusterRows.length === 0) return;

  for (const cluster of clusterRows) {
    const clusterId = (cluster.id ?? "").toString().trim();
    if (!clusterId) continue;

    // 2) Fetch articles in each cluster
    const { data: articles, error: articlesError } = await supabase
      .from("macro_events_raw")
      .select("title,description,published_at")
      .eq("cluster_id", clusterId)
      .order("published_at", { ascending: true })
      .limit(200);

    if (articlesError) {
      throw new Error(
        `Failed to load cluster articles: ${articlesError.message} (cluster_id=${clusterId})`,
      );
    }

    const articleRows = (articles as ArticleRow[] | null) ?? [];
    if (articleRows.length === 0) continue;

    // 3) Choose canonical title
    const canonicalTitle = pickCanonicalTitle(articleRows);

    // 4) Generate canonical summary
    const canonicalSummary = buildCanonicalSummary(articleRows);

    // 5) Insert canonical event
    const { error: insertError } = await supabase.from("canonical_events").insert({
      cluster_id: clusterId,
      canonical_title: canonicalTitle,
      canonical_summary: canonicalSummary,
      article_count: articleRows.length,
    });

    if (insertError) {
      throw new Error(
        `Failed to insert canonical event: ${insertError.message} (cluster_id=${clusterId})`,
      );
    }
  }
}
