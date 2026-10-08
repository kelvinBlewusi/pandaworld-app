-- The products the assistant just listed for a seller (owner's web chat,
-- 2026-10-08: "change the stock of the last 10 to 20" after the bot listed
-- their 10 newest products). { sids, what, at }: "those", "them" and "the
-- last 10" mean these for 30 minutes (lib/whatsapp/assistant.ts, bulk scope
-- "listed"). Kept through a restart.
alter table public.whatsapp_sessions add column if not exists last_listed jsonb;
