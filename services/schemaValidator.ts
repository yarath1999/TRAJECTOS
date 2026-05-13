import { createSupabaseServerClient } from "./newsFetcher";

type RequiredTable = {
  table: string;
  probeColumn: string;
  migration: string;
};

const REQUIRED_TABLES: RequiredTable[] = [
  { table: "event_clusters", probeColumn: "id", migration: "supabase/migrations/0008_event_clusters.sql" },
  { table: "canonical_events", probeColumn: "cluster_id", migration: "supabase/migrations/0018_canonical_events.sql" },
  { table: "clustering_checkpoints", probeColumn: "last_processed_published_at", migration: "supabase/migrations/0040_clustering_checkpoints_published_at.sql" },
  { table: "event_queue", probeColumn: "entities", migration: "supabase/migrations/0041_macro_events_entities.sql" },
  { table: "macro_events_raw", probeColumn: "entities", migration: "supabase/migrations/0041_macro_events_entities.sql" },
  { table: "pipeline_dead_letters", probeColumn: "cluster_id", migration: "supabase/migrations/0042_pipeline_dead_letters_cluster.sql" },
  { table: "pipeline_events", probeColumn: "retry_count", migration: "supabase/migrations/0043_pipeline_events_retry_count.sql" },
  { table: "event_fingerprints", probeColumn: "fingerprint", migration: "supabase/migrations/0044_event_fingerprints.sql" },
  { table: "event_factor_exposures", probeColumn: "id", migration: "supabase/migrations/0013_event_factor_exposures.sql" },
  { table: "event_impact_scores", probeColumn: "id", migration: "supabase/migrations/0012_event_impact_scores.sql" },
  { table: "portfolio_signals", probeColumn: "strength", migration: "supabase/migrations/0055_portfolio_signals_strength.sql" },
  { table: "event_insights", probeColumn: "reasoning", migration: "supabase/migrations/0053_event_insights_reasoning.sql" },
  { table: "portfolio_allocations", probeColumn: "id", migration: "supabase/migrations/0023_portfolio_allocations.sql" },
  { table: "event_allocations", probeColumn: "id", migration: "supabase/migrations/0056_event_allocations.sql" },
  { table: "insight_tags", probeColumn: "id", migration: "supabase/migrations/0025_insight_tags.sql" },
  { table: "asset_tags", probeColumn: "id", migration: "supabase/migrations/0026_asset_tags.sql" },
  { table: "user_segments", probeColumn: "id", migration: "supabase/migrations/0028_user_segments.sql" },
  { table: "user_relevance_index", probeColumn: "id", migration: "supabase/migrations/0027_user_relevance_index.sql" },
  { table: "user_feed", probeColumn: "id", migration: "supabase/migrations/0031_user_feed.sql" },
  { table: "user_feed_cache", probeColumn: "user_id", migration: "supabase/migrations/0032_user_feed_cache.sql" },
];


type ValidationFailure = {
  table: string;
  migration: string;
  errorMessage: string;
};

async function probeTable(table: RequiredTable): Promise<ValidationFailure | null> {
  const supabase = createSupabaseServerClient();

  const { error } = await supabase
    .from(table.table)
    .select(table.probeColumn)
    .limit(1);

  if (!error) return null;

  return {
    table: table.table,
    migration: table.migration,
    errorMessage: error.message,
  };
}

/**
 * Verifies required pipeline tables exist.
 *
 * Throws if any table is missing/unreadable.
 */
export async function validatePipelineSchemaOrThrow(): Promise<void> {
  const failures: ValidationFailure[] = [];

  for (const t of REQUIRED_TABLES) {
    const failure = await probeTable(t);
    if (failure) failures.push(failure);
  }

  if (failures.length === 0) {
    console.log("[schemaValidator] schema ok");
    return;
  }

  console.error("[schemaValidator] schema invalid; missing required tables:");
  for (const f of failures) {
    console.error(
      `- ${f.table}: apply ${f.migration} (probe error: ${f.errorMessage})`,
    );
  }

  throw new Error(`Pipeline schema validation failed (missing=${failures.length})`);
}
