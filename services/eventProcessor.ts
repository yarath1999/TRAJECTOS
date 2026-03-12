import { createHash } from "node:crypto";
import { createSupabaseServerClient } from "./newsFetcher";
import { generateClusterKey } from "@/lib/clusterKey";

type QueuedEvent = {
  id: string;
  title: string | null;
  description: string | null;
  source: string | null;
  url: string | null;
  category: string | null;
  geography: string | null;
  industries: string[] | null;
  published_at: string | null;
  processed: boolean | null;
};

function stableId(input: string): string {
  return createHash("sha256").update(input).digest("hex");
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

export async function processEventQueue(): Promise<void> {
  const supabase = createSupabaseServerClient();

  const { data, error } = await supabase
    .from("event_queue")
    .select(
      "id,title,description,source,url,category,geography,industries,published_at,processed",
    )
    .eq("processed", false)
    .limit(50);

  if (error) {
    throw new Error(`Failed to load event_queue: ${error.message}`);
  }

  if (!data?.length) return;

  for (const event of data as QueuedEvent[]) {
    if (!event.url || !event.title || !event.description || !event.source) {
      await supabase
        .from("event_queue")
        .update({ processed: true })
        .eq("id", event.id);
      continue;
    }

    const clusterKey = generateClusterKey(event.title);

    const timestamp = toEpochMs(event.published_at);
    const id = stableId(
      `${event.source}::${event.title}::${event.url}::${timestamp}`,
    );

    const { error: upsertError } = await supabase.from("macro_events_raw").upsert(
      {
        id,
        title: event.title,
        description: event.description,
        source: event.source,
        url: event.url,
        published_at: new Date(timestamp).toISOString(),
        processed: false,
        category: (event.category ?? "unknown").toString(),
        geography: event.geography,
        industries: event.industries,
        cluster_key: clusterKey,
      },
      { onConflict: "url" },
    );

    if (upsertError) {
      throw new Error(`Failed to upsert macro_events_raw: ${upsertError.message}`);
    }

    const { error: markError } = await supabase
      .from("event_queue")
      .update({ processed: true })
      .eq("id", event.id);

    if (markError) {
      throw new Error(`Failed to mark queue processed: ${markError.message}`);
    }
  }
}
