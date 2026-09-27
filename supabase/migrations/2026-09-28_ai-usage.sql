-- One row per Gemini call: tokens, search queries and cost, tagged with
-- the run it belongs to (one extension autofill, one listing draft). Lets
-- the admin billing page show what a listing actually costs, so credit
-- prices come from measured spend. Written by lib/ai/usage.ts.

create table if not exists public.ai_usage (
  id             bigint generated always as identity primary key,
  created_at     timestamptz not null default now(),
  feature        text        not null,           -- extension_fill | listing_draft | category_refill | other
  run_id         uuid,                            -- groups the calls of one autofill / one draft
  user_id        text,
  listing_id     uuid,
  model          text        not null,
  backend        text        not null,
  prompt_tokens  integer     not null default 0,
  output_tokens  integer     not null default 0,
  thought_tokens integer     not null default 0,
  search_queries integer     not null default 0,
  cost_usd       numeric(12, 8)                   -- tokens only; null for a model without a known price
);

create index if not exists ai_usage_feature_created_idx on public.ai_usage (feature, created_at desc);

-- Service-role only, like every other table here.
alter table public.ai_usage enable row level security;

comment on table public.ai_usage is
  'Per-call Gemini token usage and cost, grouped into runs (one autofill / one listing draft). See lib/ai/usage.ts.';
