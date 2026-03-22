ALTER TABLE IF EXISTS public.user_feed
ADD COLUMN IF NOT EXISTS ranking_score numeric;

CREATE INDEX IF NOT EXISTS idx_user_feed_user_ranking
ON public.user_feed (user_id, ranking_score DESC NULLS LAST);
