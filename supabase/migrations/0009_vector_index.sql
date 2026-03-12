CREATE INDEX idx_macro_events_embedding
ON macro_events_raw
USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);
