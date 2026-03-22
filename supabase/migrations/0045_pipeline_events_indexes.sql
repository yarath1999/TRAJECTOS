-- Indexes to speed up pipeline worker/orchestrator polling.

CREATE INDEX IF NOT EXISTS idx_pipeline_events_event_processed
ON pipeline_events(event_type, processed);

CREATE INDEX IF NOT EXISTS idx_pipeline_events_cluster
ON pipeline_events((payload->>'cluster_id'));
