CREATE TABLE IF NOT EXISTS portfolio_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id uuid REFERENCES event_clusters(id),
  asset text,
  allocation numeric,
  confidence numeric,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portfolio_allocations_cluster
ON portfolio_allocations(cluster_id);
