-- ─── What a seller has been told about their credits ─────────────────────────
--
-- lib/billing/credit-status.ts (owner's rules, 2026-10-06):
--   - below 6 credits, one warning on WhatsApp (at their next message) and
--     one notice in the dashboard bell and the extension panel;
--   - at 0, one WhatsApp reply about their credits, then the bot stays
--     quiet until the balance is above 0 again (a purchase or a refund).
-- Each timestamp says the message went out; each is cleared when the
-- balance recovers, so the next drop is told again. Service role only.

create table if not exists public.credit_notices (
  user_id         text primary key,
  low_warned_at   timestamptz,  -- the dashboard/extension "running low" notice
  low_whatsapp_at timestamptz,  -- the WhatsApp "running low" warning
  out_noticed_at  timestamptz,  -- the dashboard/extension "out of credits" notice
  out_replied_at  timestamptz,  -- the one WhatsApp reply at 0; quiet after it
  updated_at      timestamptz not null default now()
);
alter table public.credit_notices enable row level security;
revoke all on public.credit_notices from anon, authenticated;

-- Which notices are about credits, so a top-up can take them down.
alter table public.user_notices add column if not exists kind text;
