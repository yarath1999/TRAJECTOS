import { extract } from "@extractus/article-extractor";

export async function extractArticleContent(url: string): Promise<string | null> {
  try {
    const result = await extract(url);

    if (!result) return null;

    const maybeText = (result as unknown as { text?: string }).text;
    return result.content ?? maybeText ?? null;
  } catch (error) {
    console.warn("Article extraction failed:", url);
    return null;
  }
}
