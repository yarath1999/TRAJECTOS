BEGIN;

-- Enforce one insight row per cluster.
-- First, delete duplicates (keep the newest per cluster_id).
WITH ranked AS (
  SELECT
    id,
    cluster_id,
    created_at,
    ROW_NUMBER() OVER (
      PARTITION BY cluster_id
      ORDER BY created_at DESC NULLS LAST, id DESC
    ) AS rn
  FROM public.event_insights
  WHERE cluster_id IS NOT NULL
)
DELETE FROM public.event_insights e
USING ranked r
WHERE e.id = r.id
  AND r.rn > 1;

-- DB-level uniqueness. Multiple NULL cluster_id values are still allowed.
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_insights_cluster_id_unique
  ON public.event_insights (cluster_id);

COMMIT;
