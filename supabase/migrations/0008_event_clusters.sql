-- Minimal clustering tables/fields (Trajectos)

CREATE TABLE IF NOT EXISTS public.event_clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text UNIQUE NOT NULL,
  summary text,
  article_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.macro_events_raw
  ADD COLUMN IF NOT EXISTS cluster_id uuid;

CREATE INDEX IF NOT EXISTS idx_macro_events_raw_cluster_id
  ON public.macro_events_raw (cluster_id);
