CREATE TABLE event_factor_exposures (

  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  cluster_id uuid REFERENCES event_clusters(id),

  factor text,
  exposure numeric,

  confidence numeric DEFAULT 0.5,

  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_factor_cluster
ON event_factor_exposures(cluster_id);
