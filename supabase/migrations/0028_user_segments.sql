CREATE TABLE IF NOT EXISTS user_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  segment text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_segments_user
ON user_segments(user_id);
