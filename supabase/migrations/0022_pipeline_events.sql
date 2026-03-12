CREATE TABLE IF NOT EXISTS pipeline_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text,
  payload jsonb,
  processed boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pipeline_events_processed
ON pipeline_events(processed);
