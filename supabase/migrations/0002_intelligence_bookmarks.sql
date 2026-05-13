-- Migration: create intelligence_bookmarks table
create table if not exists public.intelligence_bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  feed_item_id text not null,
  created_at timestamptz default now()
);

create unique index if not exists intelligence_bookmarks_user_item_idx on public.intelligence_bookmarks(user_id, feed_item_id);
