-- Bucket-filtered vector search overload (keeps existing match_macro_events intact)

CREATE OR REPLACE FUNCTION match_macro_events(
  query_embedding vector(384),
  match_threshold float,
  match_count int,
  bucket_filter timestamptz
)
RETURNS TABLE (
  id text,
  title text,
  similarity float
)
LANGUAGE sql STABLE
AS $$
  SELECT
    id,
    title,
    1 - (embedding <=> query_embedding) AS similarity
  FROM macro_events_raw
  WHERE embedding IS NOT NULL
    AND 1 - (embedding <=> query_embedding) > match_threshold
    AND (bucket_filter IS NULL OR time_bucket = bucket_filter)
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
