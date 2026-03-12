CREATE TABLE IF NOT EXISTS segment_tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  segment text,
  tag text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_segment_tags_segment
ON segment_tags(segment);
