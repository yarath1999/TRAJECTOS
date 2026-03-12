CREATE TABLE IF NOT EXISTS portfolio_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id uuid REFERENCES event_clusters(id),
  asset text,
  signal text,
  confidence numeric,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_portfolio_signals_cluster
ON portfolio_signals(cluster_id);
