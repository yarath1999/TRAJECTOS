CREATE TABLE IF NOT EXISTS canonical_events (
  cluster_id uuid PRIMARY KEY REFERENCES event_clusters(id),
  canonical_title text,
  canonical_summary text,
  article_count integer,
  created_at timestamptz DEFAULT now()
);
