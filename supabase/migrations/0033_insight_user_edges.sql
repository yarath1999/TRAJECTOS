CREATE TABLE IF NOT EXISTS insight_user_edges (
  insight_id uuid,
  user_id uuid,
  relevance_score numeric,
  PRIMARY KEY(insight_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_insight_user_edges_user
  ON insight_user_edges(user_id);
