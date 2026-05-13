CREATE TABLE IF NOT EXISTS public.event_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id uuid NOT NULL REFERENCES public.event_clusters(id),
  asset text NOT NULL,
  action text,
  weight numeric,
  confidence numeric,
  created_at timestamptz DEFAULT now()
);

-- Compatibility column for existing allocation engine payloads ({ allocation, ... }).
ALTER TABLE public.event_allocations
  ADD COLUMN IF NOT EXISTS allocation numeric;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'event_allocations_action_check'
      AND conrelid = 'public.event_allocations'::regclass
  ) THEN
    ALTER TABLE public.event_allocations
      ADD CONSTRAINT event_allocations_action_check
      CHECK (action IS NULL OR action IN ('BUY', 'SELL', 'NEUTRAL'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_event_allocations_cluster
  ON public.event_allocations(cluster_id);

-- Optional uniqueness requested for one row per cluster/asset.
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_allocations_cluster_asset_unique
  ON public.event_allocations(cluster_id, asset);

CREATE OR REPLACE FUNCTION public.sync_event_allocations_weight_allocation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.weight IS NULL AND NEW.allocation IS NOT NULL THEN
    NEW.weight := NEW.allocation;
  ELSIF NEW.allocation IS NULL AND NEW.weight IS NOT NULL THEN
    NEW.allocation := NEW.weight;
  END IF;

  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_event_allocations_sync_weight_allocation'
      AND tgrelid = 'public.event_allocations'::regclass
  ) THEN
    CREATE TRIGGER trg_event_allocations_sync_weight_allocation
    BEFORE INSERT OR UPDATE ON public.event_allocations
    FOR EACH ROW
    EXECUTE FUNCTION public.sync_event_allocations_weight_allocation();
  END IF;
END
$$;
