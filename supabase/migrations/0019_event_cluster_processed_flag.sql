ALTER TABLE public.event_clusters
ADD COLUMN IF NOT EXISTS processed boolean DEFAULT false;
