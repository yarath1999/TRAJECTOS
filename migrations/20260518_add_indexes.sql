-- Recommended indexes to speed up dashboard queries
-- 1) Fast count of unprocessed pipeline events (partial index)
CREATE INDEX IF NOT EXISTS idx_pipeline_events_unprocessed ON pipeline_events (id) WHERE processed = false;

-- 2) Support queries filtering by status and end_time
CREATE INDEX IF NOT EXISTS idx_pipeline_stage_runtime_status_end_time ON pipeline_stage_runtime (status, end_time DESC);

-- 3) Range queries on failures by occurred_at
CREATE INDEX IF NOT EXISTS idx_pipeline_failures_occurred_at ON pipeline_failures (occurred_at DESC);

-- 4) Quickly fetch latest pipeline metrics by window_start
CREATE INDEX IF NOT EXISTS idx_pipeline_metrics_window_start ON pipeline_metrics (window_start DESC);

-- 5) Recent insights/allocations/clusters ordering
CREATE INDEX IF NOT EXISTS idx_event_insights_created_at ON event_insights (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_allocations_created_at ON event_allocations (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_event_clusters_created_at ON event_clusters (created_at DESC);

-- 6) If pipeline_events is often filtered by created_at or cluster_id, add:
CREATE INDEX IF NOT EXISTS idx_pipeline_events_created_at ON pipeline_events (created_at DESC);
-- CREATE INDEX IF NOT EXISTS idx_pipeline_events_cluster_id ON pipeline_events (cluster_id);

-- Notes:
-- The partial index on processed=false gives fast counts for unprocessed events without indexing all rows.
-- Composite indexes like (status, end_time DESC) help queries that filter by status and recent window.
-- Adjust index names if your DB schema naming conventions differ.
