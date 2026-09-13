-- ─── Per-user Jumia OAuth app credentials ──────────────────────────────────────
-- Run this in Supabase SQL Editor before testing the onboarding flow.
--
-- (This file used to also create a `profiles` table for tracking onboarding
-- state. That table was never queried anywhere in the app and was dropped
-- 2026-09-13 — onboarding/connection state is read directly off
-- jumia_connections instead, see lib/jumia/credentials.ts.)

alter table jumia_connections
  add column if not exists app_id     text null,
  add column if not exists app_secret text null,
  add column if not exists country    text null default 'GH';
