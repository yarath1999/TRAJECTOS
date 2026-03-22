-- Adds retry counter for pipeline event processing.

ALTER TABLE IF EXISTS public.pipeline_events
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0;
