-- Schedule retries for pipeline dead letters.

ALTER TABLE IF EXISTS public.pipeline_dead_letters
  ADD COLUMN IF NOT EXISTS retry_after timestamptz DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_pipeline_dead_letters_retry_after
  ON public.pipeline_dead_letters(retry_after);
