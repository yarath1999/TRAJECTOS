CREATE TABLE IF NOT EXISTS insight_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  insight_id uuid REFERENCES event_insights(id),
  tag text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_insight_tags_tag
ON insight_tags(tag);
