import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import Parser from "rss-parser";
import { normalizeFeedItem } from "@/lib/feedNormalizer";
import { extractArticleContent } from "@/lib/articleExtractor";

const BATCH_SIZE = 50;
let batchBuffer: any[] = [];

type MacroEventRow = {
  title: string;
  description: string;
  source: string;
  url: string;
  published_at: string;
  processed: boolean;
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
  last_checked?: string | null;
  last_success?: string | null;
  error_count?: number | null;
};

function isDuplicateUrlConstraintError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("duplicate key value") &&
    (
      m.includes("event_queue_url_key") ||
      m.includes("macro_events_raw_url_key") ||
      m.includes("unique constraint")
    )
  );
}

async function getExistingUrls(
  supabase: SupabaseClient,
  urls: string[],
): Promise<Set<string>> {
  const unique = Array.from(new Set(urls.filter(Boolean)));
  if (unique.length === 0) return new Set();

  const { data, error } = await supabase
    .from("event_queue")
    .select("url")
    .in("url", unique);

  if (error) {
    // If this pre-check fails, fall back to relying on upsert behavior.
    return new Set();
  }

  const existing = new Set<string>();
  for (const row of (data as Array<{ url: string }> | null) ?? []) {
    if (row?.url) existing.add(row.url);
  }
  return existing;
}

async function flushBatch(supabase: SupabaseClient) {
  if (batchBuffer.length === 0) return;

  const { error } = await supabase.from("event_queue").upsert(batchBuffer, {
    onConflict: "url",
    ignoreDuplicates: true,
  });

  if (error) {
    throw new Error(`Supabase batch upsert failed: ${error.message}`);
  }

  batchBuffer = [];
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function createSupabaseServerClient(): SupabaseClient {
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
    .select("id,name,rss_url,category,active,last_checked,last_success,error_count")
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Feed fetch timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
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
      "User-Agent": "Mozilla/5.0 TrajectosBot",
    },
    timeout: 10000,
    customFields: {
      item: [
        ["media:content", "mediaContent"],
        ["media:thumbnail", "mediaThumbnail"],
      ],
    },
  });

  let sourcesProcessed = 0;
  let articlesInserted = 0;

  for (const src of sources) {
    sourcesProcessed += 1;
    console.log(`Fetching source: ${src.name}`);

    const checkedAt = new Date().toISOString();
    try {
      await supabase
        .from("event_sources")
        .update({ last_checked: checkedAt })
        .eq("id", src.id);
    } catch {
      // Monitoring updates should never break ingestion.
    }

    try {
      await sleep(750);
      const feed = await withTimeout(parser.parseURL(src.rss_url), 10000);
      const sourceLabel =
        src.name?.trim() || feed.title?.trim() || new URL(src.rss_url).host;
      const category = (src.category ?? "unknown").toString();

      const rows: MacroEventRow[] = [];
      const seenUrls = new Set<string>();

      const rawItems =
        feed.items ?? (feed as any).entries ?? (feed as any).entry ?? [];
      const items = Array.isArray(rawItems) ? rawItems : [];

      if (!items.length) {
        console.warn("Feed returned no items", {
          source: src.name,
          url: src.rss_url,
        });
        continue;
      }

      console.log("Feed structure:", Object.keys(feed));
      console.log("Items found:", items.length);
      console.log("First item:", items[0]);

      for (const item of items) {
        const normalized = normalizeFeedItem(item, sourceLabel);
        if (!normalized) continue;

        const url = normalized.url;
        if (!url) continue;
        if (seenUrls.has(url)) {
          continue;
        }
        seenUrls.add(url);

        const fullContent = await extractArticleContent(url);
        await sleep(500);

        const title = normalized.title;
        const description = fullContent ?? normalized.description;
        const link = normalized.url;

        const timestamp = toEpochMs(normalized.publishedAt);

        rows.push({
          title,
          description,
          source: sourceLabel,
          url,
          published_at: new Date(timestamp).toISOString(),
          processed: false,
          category,
          geography: null,
          industries: null,
        });
      }

      if (rows.length === 0) {
        continue;
      }

      const existingUrls = await getExistingUrls(
        supabase,
        rows.map((r) => r.url),
      );
      const rowsToInsert = rows.filter((r) => !existingUrls.has(r.url));

      for (const row of rowsToInsert) {
        batchBuffer.push(row);

        if (batchBuffer.length >= BATCH_SIZE) {
          await flushBatch(supabase);
        }
      }

      articlesInserted += rowsToInsert.length;

      try {
        await supabase
          .from("event_sources")
          .update({ last_success: new Date().toISOString() })
          .eq("id", src.id);
      } catch {
        // Monitoring updates should never break ingestion.
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Feed error", {
        source: src.name,
        url: src.rss_url,
        error: message,
      });

      try {
        const nextErrorCount = (src.error_count ?? 0) + 1;
        await supabase
          .from("event_sources")
          .update({ error_count: nextErrorCount })
          .eq("id", src.id);
      } catch {
        // Monitoring updates should never break ingestion.
      }
      continue;
    }
  }

  await flushBatch(supabase);

  return { sourcesProcessed, articlesInserted };
}
