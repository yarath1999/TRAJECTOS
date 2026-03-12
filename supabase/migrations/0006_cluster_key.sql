ALTER TABLE macro_events_raw
ADD COLUMN cluster_key text;

CREATE INDEX idx_cluster_key
ON macro_events_raw(cluster_key);
