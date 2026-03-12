CREATE TABLE IF NOT EXISTS event_insights (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id uuid REFERENCES event_clusters(id),
  insight text,
  confidence numeric,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_insights_cluster
ON event_insights(cluster_id);
