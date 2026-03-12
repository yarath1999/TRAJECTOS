ALTER TABLE macro_events_raw
ADD COLUMN clustered boolean DEFAULT false;

CREATE INDEX idx_unclustered_events
ON macro_events_raw(clustered)
WHERE clustered = false;
