-- Deduplication fingerprints for macro events.
-- Fingerprint is computed in app code as hash(title + normalized_description).

CREATE TABLE IF NOT EXISTS public.event_fingerprints (
  fingerprint text PRIMARY KEY,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_event_fingerprints_last_seen_at
ON public.event_fingerprints(last_seen_at);
