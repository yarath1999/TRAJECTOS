-- Exponential backoff for dead-letter retries.

ALTER TABLE IF EXISTS public.pipeline_dead_letters
  ADD COLUMN IF NOT EXISTS retry_count integer DEFAULT 0;
