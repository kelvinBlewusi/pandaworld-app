-- Logs every time a seller overrides the category the AI pipeline picked
-- for a listing (drawer, focused editor, or a WhatsApp alternate-category
-- button — all three funnel through refillAttributesForCategory(), see
-- lib/jumia/refill-attributes.ts). Write-only telemetry: nothing reads this
-- yet, but it's the data needed to catch systematic miscategorization
-- (e.g. a canvas art print landing under "Icing & Decorating Spatulas" at
-- 0.95 confidence — a category the retrieval pipeline keeps offering
-- wrongly for some product family would show up here as the same
-- previous_category_code getting corrected away from repeatedly).

create table if not exists category_corrections (
  id                      uuid primary key default gen_random_uuid(),
  listing_id              uuid not null references listings(id) on delete cascade,
  previous_category_code  integer,
  previous_category_path  text,
  previous_confidence     numeric,
  new_category_code       integer not null,
  new_category_path       text,
  created_at              timestamptz not null default now()
);

create index if not exists category_corrections_previous_code_idx
  on category_corrections (previous_category_code);

alter table category_corrections enable row level security;
-- No policies defined — only the service-role client (refillAttributesForCategory,
-- called from a server action / API route / WhatsApp webhook) ever writes or
-- reads this; no anon/authenticated client needs direct access.
