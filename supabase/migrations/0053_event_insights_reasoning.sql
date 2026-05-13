BEGIN;

-- Add structured reasoning for insights.
-- Safe/idempotent: no-op if table/column already exists.
ALTER TABLE IF EXISTS public.event_insights
  ADD COLUMN IF NOT EXISTS reasoning jsonb;

COMMENT ON COLUMN public.event_insights.reasoning IS
  'Structured explanation / reasoning for the generated insight (JSONB).';

COMMIT;
