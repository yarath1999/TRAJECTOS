-- Archive table for old macro events (additive)

create table if not exists public.macro_events_archive (
  id text primary key,
  title text not null,
  description text not null,
  source text not null,
  url text not null,
  published_at timestamptz not null,
  ingested_at timestamptz not null,
  processed boolean not null,
  category text not null,
  geography text,
  industries text[],
  archived_at timestamptz not null default now()
);

create index if not exists macro_events_archive_published_at_idx
  on public.macro_events_archive (published_at desc);
