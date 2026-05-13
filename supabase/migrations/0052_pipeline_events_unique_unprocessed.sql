-- Enforce partial uniqueness: only one UNPROCESSED event per cluster per type.
-- This prevents duplicate *_REQUIRED events from being enqueued concurrently.
--
-- If an equivalent older index exists under a previous name, rename it to avoid
-- creating redundant duplicate indexes.

DO $$
BEGIN
  IF to_regclass('public.idx_pipeline_events_unique_unprocessed') IS NULL THEN
    IF to_regclass('public.idx_pipeline_event_unique_cluster') IS NOT NULL THEN
      ALTER INDEX public.idx_pipeline_event_unique_cluster
        RENAME TO idx_pipeline_events_unique_unprocessed;
    ELSE
      EXECUTE '
        CREATE UNIQUE INDEX idx_pipeline_events_unique_unprocessed
        ON public.pipeline_events(event_type, (payload->>''cluster_id''))
        WHERE processed = false
      ';
    END IF;
  END IF;
END
$$;
