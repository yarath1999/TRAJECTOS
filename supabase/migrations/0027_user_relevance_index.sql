CREATE TABLE IF NOT EXISTS user_relevance_index (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid,
  insight_id uuid REFERENCES event_insights(id),
  relevance_score numeric,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_relevance_user
ON user_relevance_index(user_id);
