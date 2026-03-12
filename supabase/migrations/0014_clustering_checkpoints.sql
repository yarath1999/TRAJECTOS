CREATE TABLE IF NOT EXISTS clustering_checkpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  last_processed_at timestamptz
);

INSERT INTO clustering_checkpoints(last_processed_at)
SELECT NOW() - interval '7 days'
WHERE NOT EXISTS (SELECT 1 FROM clustering_checkpoints);
