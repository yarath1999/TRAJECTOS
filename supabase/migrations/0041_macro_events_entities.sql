-- Adds lightweight entity extraction storage.

ALTER TABLE public.macro_events_raw
  ADD COLUMN IF NOT EXISTS entities text[];

ALTER TABLE public.event_queue
  ADD COLUMN IF NOT EXISTS entities text[];
