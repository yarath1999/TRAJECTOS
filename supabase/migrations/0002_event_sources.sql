-- Event sources for RSS ingestion (Trajectos)

-- Needed for gen_random_uuid() on Postgres.
create extension if not exists pgcrypto;

create table if not exists public.event_sources (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  rss_url text not null,
  category text,
  active boolean default true,
  created_at timestamptz default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'event_sources_rss_url_unique'
  ) then
    alter table public.event_sources
      add constraint event_sources_rss_url_unique unique (rss_url);
  end if;
end $$;

insert into public.event_sources (name, rss_url, category, active)
values
  (
    'Reuters Business',
    'https://www.reutersagency.com/feed/?best-topics=business-finance',
    'market',
    true
  ),
  (
    'CNBC Markets',
    'https://www.cnbc.com/id/100003114/device/rss/rss.html',
    'market',
    true
  ),
  (
    'Federal Reserve',
    'https://www.federalreserve.gov/feeds/press_all.xml',
    'policy',
    true
  ),
  ('IMF News', 'https://www.imf.org/en/News/RSS', 'macro', true),
  ('World Bank News', 'https://www.worldbank.org/en/news/rss', 'macro', true)
on conflict (rss_url) do nothing;
