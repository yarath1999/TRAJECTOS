-- Raw RSS ingestion table (Trajectos)

create table if not exists public.macro_events_raw (
  id text primary key,
  title text not null,
  description text not null,
  source text not null,
  url text not null,
  published_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  processed boolean not null default false,
  category text not null,
  geography text,
  industries text[]
);

create index if not exists macro_events_raw_processed_idx
  on public.macro_events_raw (processed);

create index if not exists macro_events_raw_published_at_idx
  on public.macro_events_raw (published_at desc);
