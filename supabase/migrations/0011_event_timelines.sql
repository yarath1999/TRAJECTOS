CREATE TABLE event_timelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  cluster_id uuid REFERENCES event_clusters(id),

  stage integer,
  title text,
  description text,

  event_timestamp timestamptz,

  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_event_timelines_cluster
ON event_timelines(cluster_id);
