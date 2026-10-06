-- A pack feature given to one seller without the pack, by the owner: first
-- Image Polish, free, for a seller on free credits until he had spent his
-- last 8 (2026-10-06). Read by lib/billing/feature-grants.ts. Added by hand;
-- there is no page for it.
create table if not exists public.feature_grants (
  id               uuid primary key default gen_random_uuid(),
  user_id          text not null,
  -- A FeatureId (lib/billing/features.ts), e.g. image_polish_extension.
  feature          text not null,
  -- Used without being charged credits.
  free_use         boolean not null default false,
  -- Ends once the seller has spent this many credits since the grant began.
  -- Null: no such end.
  credit_allowance numeric,
  ends_at          timestamptz,
  -- Free uses so far, so what a grant costs us shows.
  uses             integer not null default 0,
  note             text,
  created_at       timestamptz not null default now()
);

create index if not exists feature_grants_user_feature on public.feature_grants (user_id, feature);

-- Server only (the service role), like the credit ledger.
alter table public.feature_grants enable row level security;
revoke all on public.feature_grants from anon, authenticated;
