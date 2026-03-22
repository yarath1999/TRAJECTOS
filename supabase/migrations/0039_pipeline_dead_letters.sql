CREATE TABLE IF NOT EXISTS public.pipeline_dead_letters (
  id uuid PRIMARY KEY,
  event_type text,
  payload jsonb,
  error_message text,
  failed_at timestamptz DEFAULT now()
);
