-- ─── Onboarding & per-user Jumia credentials ──────────────────────────────────
-- Run this in Supabase SQL Editor before testing the onboarding flow.

-- 1. Per-user OAuth app credentials on jumia_connections
alter table jumia_connections
  add column if not exists app_id     text null,
  add column if not exists app_secret text null,
  add column if not exists country    text null default 'GH';

-- 2. Profiles table — tracks onboarding state so re-connects don't re-trigger onboarding
create table if not exists profiles (
  user_id             text primary key,
  onboarding_completed boolean not null default false,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);

-- Enable RLS so each user only sees their own profile
alter table profiles enable row level security;

create policy if not exists "profiles: user owns row"
  on profiles for all
  using (user_id = auth.uid()::text);
