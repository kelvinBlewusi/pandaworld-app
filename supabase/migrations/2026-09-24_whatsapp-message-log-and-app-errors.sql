-- Two tables closing a gap hit repeatedly during live testing: neither the
-- app nor Vercel's own runtime logs keep a queryable record of what a
-- WhatsApp conversation actually said, or a structured trail of server
-- errors — Vercel's logs are ephemeral, rate-limited, and never capture
-- message bodies at all. Both are service-role only (no RLS policies): the
-- content here is operational/debugging data for staff, not something any
-- authenticated app user should read directly, seller included — a phone
-- number seeing its own conversation replayed is not the product.

create table if not exists whatsapp_message_log (
  id           uuid primary key default gen_random_uuid(),
  -- Loosely typed to match every other WhatsApp table's own convention
  -- (whatsapp_sessions.phone_number, whatsapp_connections.phone_number) —
  -- the join key across this whole subsystem, not a FK to any one table.
  phone_number text not null,
  direction    text not null check (direction in ('inbound', 'outbound')),
  -- 'text' | 'button' | 'list' | 'cta_url' | 'image' | 'unsupported' | ... —
  -- deliberately not an enum: Meta adds message types over time, and a
  -- CHECK constraint would need a migration every time one does.
  message_type text not null,
  -- Normalized, human-readable text — what a person reading this table
  -- would want to see, not the raw Graph API JSON. For a button/list send
  -- this is the body text; for a tapped button/row on the inbound side,
  -- it's the tapped title (the same normalization intake.ts's own command
  -- parsers already treat as canonical — see message-content.ts).
  body_text    text,
  -- Meta's message id — reliably present on inbound (used elsewhere for
  -- webhook dedup), absent on most outbound sends since callGraphApi
  -- doesn't get one back before logging.
  wamid        text,
  listing_id   uuid references listings(id) on delete set null,
  batch_id     text,
  -- Full structure beyond body_text — buttons offered, list rows, a
  -- cta_url's target, an inbound image's media id. Kept alongside rather
  -- than instead of body_text so a quick scan never needs to parse JSON.
  payload      jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists whatsapp_message_log_phone_created_idx
  on whatsapp_message_log (phone_number, created_at desc);
create index if not exists whatsapp_message_log_listing_idx
  on whatsapp_message_log (listing_id) where listing_id is not null;

alter table whatsapp_message_log enable row level security;

create table if not exists app_errors (
  id         uuid primary key default gen_random_uuid(),
  -- Where it happened, e.g. "whatsapp-webhook", "worker-analyze-jobs" —
  -- free text, not an enum, for the same reason message_type is: routes
  -- get added and renamed without a migration to match.
  source     text not null,
  message    text not null,
  stack      text,
  -- Whatever identifies the affected row is worth carrying along —
  -- phone_number, listing_id, batch_id, user_id — kept as jsonb since
  -- which of those apply depends entirely on where the error was raised.
  context    jsonb,
  created_at timestamptz not null default now()
);

create index if not exists app_errors_source_created_idx
  on app_errors (source, created_at desc);

alter table app_errors enable row level security;
