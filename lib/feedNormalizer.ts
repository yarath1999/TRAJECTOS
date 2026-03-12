export type NormalizedFeedItem = {
  title: string;
  url: string;
  description: string;
  publishedAt: string | null;
  source: string;
};

export function normalizeFeedItem(
  item: any,
  source: string,
): NormalizedFeedItem | null {
  const title = (item?.title ?? "").toString().trim();
  const url = (item?.link ?? item?.guid ?? "").toString().trim();

  if (!title || !url) return null;

  const description = (
    item?.contentSnippet ?? item?.content ?? item?.summary ?? ""
  )
    .toString()
    .trim();

  const publishedAt = (item?.isoDate ?? item?.pubDate ?? null) as string | null;

  return {
    title,
    url,
    description,
    publishedAt,
    source,
  };
}
