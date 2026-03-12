-- Temporal bucketing for macro events (10-minute buckets)

ALTER TABLE public.macro_events_raw
ADD COLUMN IF NOT EXISTS time_bucket timestamptz;

-- Backfill existing rows
UPDATE public.macro_events_raw
SET time_bucket = to_timestamp(floor(extract(epoch from published_at) / 600) * 600)
WHERE time_bucket IS NULL;

CREATE OR REPLACE FUNCTION public.set_macro_events_raw_time_bucket()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.published_at IS NULL THEN
    RETURN NEW;
  END IF;

  NEW.time_bucket := to_timestamp(floor(extract(epoch from NEW.published_at) / 600) * 600);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS macro_events_raw_time_bucket_trg ON public.macro_events_raw;

CREATE TRIGGER macro_events_raw_time_bucket_trg
BEFORE INSERT OR UPDATE OF published_at
ON public.macro_events_raw
FOR EACH ROW
EXECUTE FUNCTION public.set_macro_events_raw_time_bucket();
