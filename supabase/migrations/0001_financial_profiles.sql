-- Trajectos — Supabase setup (SQL)
--
-- How to apply this in Supabase:
-- 1) Create a Supabase project: https://supabase.com/dashboard → New project
-- 2) In the project: SQL Editor → New query
-- 3) Paste this file contents and run
--
-- Note: `gen_random_uuid()` requires `pgcrypto`.

create extension if not exists pgcrypto;

create table financial_profiles (
 id uuid primary key default gen_random_uuid(),
 user_id uuid references auth.users(id) on delete cascade,
 current_savings numeric,
 monthly_savings numeric,
 expected_return numeric,
 target_amount numeric,
 time_horizon integer,
 created_at timestamp default now(),
 updated_at timestamp default now()
);

create unique index financial_profiles_user_id_key
on financial_profiles(user_id);

alter table financial_profiles enable row level security;

create policy "Users manage own financial profile"
on financial_profiles
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);
