-- Feed health monitoring fields (Trajectos)

alter table public.event_sources
  add column if not exists last_checked timestamptz;

alter table public.event_sources
  add column if not exists last_success timestamptz;

alter table public.event_sources
  add column if not exists error_count integer not null default 0;
