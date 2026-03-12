import { createSupabaseServerClient } from "@/services/newsFetcher";

export async function findSimilarEvents(
  embedding: number[],
  bucketFilter?: string | Date | null,
) {
  const supabase = createSupabaseServerClient();

  const { data } = await supabase.rpc("match_macro_events", {
    query_embedding: embedding,
    match_threshold: 0.85,
    match_count: 5,
    bucket_filter:
      bucketFilter instanceof Date
        ? bucketFilter.toISOString()
        : (bucketFilter ?? null),
  });

  return data ?? [];
}
