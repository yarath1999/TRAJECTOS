CREATE TABLE IF NOT EXISTS user_feed_cache (
  user_id uuid PRIMARY KEY,
  feed jsonb,
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_feed_cache_updated
  ON user_feed_cache(updated_at);
