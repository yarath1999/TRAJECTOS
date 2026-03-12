CREATE TABLE event_impact_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  cluster_id uuid REFERENCES event_clusters(id),

  asset_class text,
  impact_score numeric,

  confidence numeric DEFAULT 0.5,

  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_event_impact_cluster
ON event_impact_scores(cluster_id);
