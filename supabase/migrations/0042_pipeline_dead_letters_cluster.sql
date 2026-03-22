-- Cluster/stage-level dead letters for pipeline engines.
-- Note: the table may already exist from 0039_pipeline_dead_letters.sql (event-level DLQ).
-- This migration evolves it to support cluster/stage failures without breaking existing rows.

ALTER TABLE IF EXISTS public.pipeline_dead_letters
  ADD COLUMN IF NOT EXISTS cluster_id uuid,
  ADD COLUMN IF NOT EXISTS stage_name text,
  ADD COLUMN IF NOT EXISTS created_at timestamptz;

-- Ensure new rows can omit id.
ALTER TABLE IF EXISTS public.pipeline_dead_letters
  ALTER COLUMN id SET DEFAULT gen_random_uuid();

-- Backfill created_at from prior schema, if present.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'pipeline_dead_letters'
      AND column_name = 'failed_at'
  ) THEN
    UPDATE public.pipeline_dead_letters
    SET created_at = failed_at
    WHERE created_at IS NULL;
  END IF;
END $$;

ALTER TABLE IF EXISTS public.pipeline_dead_letters
  ALTER COLUMN created_at SET DEFAULT now();
