-- Enforce uniqueness of pipeline events per cluster per event type.
-- Prevents race-condition duplicates when multiple workers emit concurrently.

CREATE UNIQUE INDEX IF NOT EXISTS idx_pipeline_event_unique_cluster
ON pipeline_events(event_type, (payload->>'cluster_id'))
WHERE processed = false;
