CREATE TABLE event_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  title text,
  description text,
  source text,
  url text UNIQUE,

  category text,
  geography text,
  industries text[],

  published_at timestamptz,

  queued_at timestamptz DEFAULT now(),
  processed boolean DEFAULT false
);
