ALTER TABLE public.event_clusters
ADD COLUMN IF NOT EXISTS validated boolean DEFAULT false;

ALTER TABLE public.event_clusters
ADD COLUMN IF NOT EXISTS validation_score numeric DEFAULT 0;
