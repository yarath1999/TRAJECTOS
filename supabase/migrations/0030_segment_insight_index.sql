CREATE TABLE IF NOT EXISTS segment_insight_index (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  segment text,
  insight_id uuid REFERENCES event_insights(id),
  relevance_score numeric,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_segment_insight_segment
ON segment_insight_index(segment);
