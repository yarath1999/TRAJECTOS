import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import Parser from "rss-parser";

type MacroEventRow = {
  id: string;
  title: string;
  description: string;
  source: string;
  url: string;
  published_at: string;
  category: string;
  geography?: string | null;
  industries?: string[] | null;
};

type EventSourceRow = {
  id: string;
  name: string;
  rss_url: string;
  category: string | null;
  active: boolean;
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function createSupabaseServerClient(): SupabaseClient {
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");

  // Prefer a server-only key for scripts; fall back to anon for local testing.
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SERVICE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!key) {
    throw new Error(
      "Missing Supabase key. Set SUPABASE_SERVICE_ROLE_KEY (recommended) or NEXT_PUBLIC_SUPABASE_ANON_KEY.",
    );
  }
  console.log("Using key type:",
  process.env.SUPABASE_SERVICE_ROLE_KEY ? "service_role" : "anon");

  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

async function getActiveEventSources(
  supabase: SupabaseClient,
): Promise<EventSourceRow[]> {
  const { data, error } = await supabase
    .from("event_sources")
    .select("id,name,rss_url,category,active")
    .eq("active", true);

  if (error) {
    throw new Error(`Failed to load event_sources: ${error.message}`);
  }

  return (data as EventSourceRow[] | null) ?? [];
}

function toEpochMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;

  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  if (value instanceof Date) {
    const ms = value.getTime();
    if (Number.isFinite(ms)) return ms;
  }

  return Date.now();
}

function stableId(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export type FetchAndStoreNewsResult = {
  sourcesProcessed: number;
  articlesInserted: number;
};

/**
 * Fetches configured RSS feeds (from `event_sources`) and upserts items into
 * the `macro_events` table.
 *
 * Configuration:
 * - NEXT_PUBLIC_SUPABASE_URL
 * - SUPABASE_SERVICE_ROLE_KEY (recommended for scripts) OR NEXT_PUBLIC_SUPABASE_ANON_KEY
 */
export async function fetchAndStoreNews(): Promise<FetchAndStoreNewsResult> {
  const supabase = createSupabaseServerClient();
  const sources = await getActiveEventSources(supabase);
  const parser = new Parser({
    headers: {
      "User-Agent": "Mozilla/5.0 (Trajectos Macro Intelligence Engine)",
    },
    timeout: 15000,
    xml2js: {
      normalize: true,
      normalizeTags: true,
      explicitArray: false,
    },
  });

  let sourcesProcessed = 0;
  let articlesInserted = 0;

  for (const src of sources) {
    sourcesProcessed += 1;
    console.log(`Fetching source: ${src.name}`);

    try {
      const feed = await parser.parseURL(src.rss_url);
      const sourceLabel =
        src.name?.trim() || feed.title?.trim() || new URL(src.rss_url).host;
      const category = (src.category ?? "unknown").toString();

      const rows: MacroEventRow[] = [];
      const seenUrls = new Set<string>();

      const items = Array.isArray(feed.items) ? feed.items : [];

      for (const item of items) {
        const title = (item.title ?? "").toString().trim();
        const description = (item.contentSnippet ?? item.content ?? "")
          .toString()
          .trim();
        const link = (item.link ?? item.guid ?? "").toString().trim();

        if (link && seenUrls.has(link)) continue;
        if (link) seenUrls.add(link);

        if (!title) continue;

        const timestamp = toEpochMs(
          (item as any).isoDate ?? (item as any).pubDate,
        );
        const id = stableId(`${sourceLabel}::${title}::${link}::${timestamp}`);

        rows.push({
          id,
          title,
          description,
          source: sourceLabel,
          url: link,
          published_at: new Date(timestamp).toISOString(),
          category,
          geography: null,
          industries: null,
        });
      }

      if (rows.length === 0) {
        continue;
      }

      // Upsert requires a unique constraint on `id` in `macro_events`.
      const { data, error } = await supabase
        .from("macro_events")
        .upsert(rows, { onConflict: "id" })
        .select("id");

      if (error) {
        throw new Error(`Supabase insert failed: ${error.message}`);
      }

      articlesInserted += data?.length ?? rows.length;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Feed error", {
        source: src.name,
        url: src.rss_url,
        error: message,
      });
      continue;
    }
  }

  return { sourcesProcessed, articlesInserted };
}
