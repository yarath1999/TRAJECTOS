import { createSupabaseServerClient } from "./newsFetcher";

type UntaggedInsightRow = {
  id: string;
  insight: string | null;
  insight_tags?: Array<{ insight_id: string | null }> | null;
};

function extractTags(insight: string): string[] {
  const text = insight.toLowerCase();
  const tags = new Set<string>();

  if (text.includes("inflation")) tags.add("inflation");
  if (text.includes("bond")) tags.add("bonds");
  if (text.includes("equity")) tags.add("equities");
  if (text.includes("oil") || text.includes("energy")) tags.add("commodities");
  if (text.includes("dollar") || text.includes("usd")) tags.add("currency");
  if (text.includes("interest") || text.includes("rate")) tags.add("interest_rates");

  return Array.from(tags);
}

export async function runInsightTagEngine(): Promise<void> {
  const supabase = createSupabaseServerClient();

  // Load insights that do not yet have tags.
  // Supabase doesn't support NOT IN subqueries directly; use left join + null filter.
  const { data, error } = await supabase
    .from("event_insights")
    .select("id,insight, insight_tags!left(insight_id)")
    .is("insight_tags.insight_id", null)
    .order("created_at", { ascending: true })
    .limit(20);

  if (error) {
    throw new Error(`Failed to load untagged insights: ${error.message}`);
  }

  const rows = (data as UntaggedInsightRow[] | null) ?? [];
  if (rows.length === 0) return;

  for (const row of rows) {
    const insightId = (row.id ?? "").toString().trim();
    const insight = (row.insight ?? "").toString();

    if (!insightId || !insight) continue;

    const tags = extractTags(insight);
    if (tags.length === 0) continue;

    const inserts = tags.map((tag) => ({
      insight_id: insightId,
      tag,
    }));

    const { error: insertError } = await supabase.from("insight_tags").insert(inserts);

    if (insertError) {
      throw new Error(`Failed to insert insight tags: ${insertError.message}`);
    }

    const { error: emitError } = await supabase.from("pipeline_events").insert({
      event_type: "INSIGHT_TAGGED",
      payload: { insight_id: insightId },
    });

    if (emitError) {
      throw new Error(`Failed to emit INSIGHT_TAGGED event: ${emitError.message}`);
    }
  }
}
