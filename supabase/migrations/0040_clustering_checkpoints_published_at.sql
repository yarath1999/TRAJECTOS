-- Refactor clustering checkpoints to track last processed published_at timestamp.
-- Keeps legacy columns (last_processed_at / last_processed_event) if they exist,
-- but introduces last_processed_published_at as the canonical checkpoint.

CREATE TABLE IF NOT EXISTS public.clustering_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  last_processed_published_at timestamptz,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.clustering_checkpoints
  ADD COLUMN IF NOT EXISTS last_processed_published_at timestamptz;

ALTER TABLE public.clustering_checkpoints
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

-- Backfill from legacy timestamp columns if present.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'clustering_checkpoints'
      AND column_name = 'last_processed_event'
  ) THEN
    UPDATE public.clustering_checkpoints
      SET last_processed_published_at = last_processed_event
      WHERE last_processed_published_at IS NULL
        AND last_processed_event IS NOT NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'clustering_checkpoints'
      AND column_name = 'last_processed_at'
  ) THEN
    UPDATE public.clustering_checkpoints
      SET last_processed_published_at = last_processed_at
      WHERE last_processed_published_at IS NULL
        AND last_processed_at IS NOT NULL;
  END IF;
END $$;

-- Ensure there is at least one checkpoint row.
INSERT INTO public.clustering_checkpoints (last_processed_published_at)
SELECT now() - interval '7 days'
WHERE NOT EXISTS (SELECT 1 FROM public.clustering_checkpoints);

CREATE INDEX IF NOT EXISTS idx_clustering_checkpoints_last_processed_published_at
  ON public.clustering_checkpoints (last_processed_published_at);
