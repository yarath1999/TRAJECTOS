-- Foundational core schema guards (Trajectos)
-- Ensures key pipeline tables/columns exist for end-to-end runs.

-- Ensure event_clusters exists before creating dependent tables.
CREATE TABLE IF NOT EXISTS public.event_clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text UNIQUE NOT NULL,
  summary text,
  article_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  validated boolean DEFAULT false,
  validation_score numeric DEFAULT 0,
  processed boolean DEFAULT false
);

-- Create pipeline_events table + indexes.
CREATE TABLE IF NOT EXISTS public.pipeline_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  payload jsonb,
  processed boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_events_type
  ON public.pipeline_events(event_type);

CREATE INDEX IF NOT EXISTS idx_pipeline_events_processed
  ON public.pipeline_events(processed);

-- Ensure event_clusters validation/processed columns exist.
ALTER TABLE public.event_clusters
  ADD COLUMN IF NOT EXISTS validated boolean DEFAULT false;

ALTER TABLE public.event_clusters
  ADD COLUMN IF NOT EXISTS validation_score numeric DEFAULT 0;

ALTER TABLE public.event_clusters
  ADD COLUMN IF NOT EXISTS processed boolean DEFAULT false;

-- Ensure canonical_events exists (used by feed-card cache layer).
CREATE TABLE IF NOT EXISTS public.canonical_events (
  cluster_id uuid PRIMARY KEY REFERENCES public.event_clusters(id),
  canonical_title text,
  canonical_summary text,
  article_count integer,
  created_at timestamptz DEFAULT now()
);

-- Ensure insight_user_edges exists (used for delta feed propagation).
CREATE TABLE IF NOT EXISTS public.insight_user_edges (
  insight_id uuid,
  user_id uuid,
  relevance_score numeric,
  PRIMARY KEY(insight_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_insight_user_edges_user
  ON public.insight_user_edges(user_id);
