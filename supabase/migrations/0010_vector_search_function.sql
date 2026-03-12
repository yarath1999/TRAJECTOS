CREATE OR REPLACE FUNCTION match_macro_events(
  query_embedding vector(384),
  match_threshold float,
  match_count int
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
  ORDER BY embedding <=> query_embedding
  LIMIT match_count;
$$;
