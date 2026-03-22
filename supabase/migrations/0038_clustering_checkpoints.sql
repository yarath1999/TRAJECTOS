-- Ensures clustering_checkpoints exists with the expected schema.
-- Safe to run on databases where the table (or some columns) already exist.

CREATE TABLE IF NOT EXISTS public.clustering_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  last_processed_event timestamptz,
  created_at timestamptz DEFAULT now()
);

-- If an older migration created the table with a different schema, add missing columns.
ALTER TABLE public.clustering_checkpoints
  ADD COLUMN IF NOT EXISTS last_processed_event timestamptz;

ALTER TABLE public.clustering_checkpoints
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- Backfill from legacy column name if present.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'clustering_checkpoints'
      AND column_name = 'last_processed_at'
  ) THEN
    UPDATE public.clustering_checkpoints
      SET last_processed_event = last_processed_at
      WHERE last_processed_event IS NULL
        AND last_processed_at IS NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_clustering_checkpoints_last_processed_event
  ON public.clustering_checkpoints (last_processed_event);
