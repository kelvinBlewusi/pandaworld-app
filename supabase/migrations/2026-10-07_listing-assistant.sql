-- The Listing Assistant (owner, 2026-10-07): the WhatsApp bot as a chat on the
-- website, under the address web:<userId> (lib/whatsapp/channel.ts). Its
-- messages go in whatsapp_message_log and its session in whatsapp_sessions,
-- keyed by that address. A listing made there is marked 'web', so its updates
-- (live, rejected, fixed) come back to the web chat instead of WhatsApp.
alter table public.listings add column if not exists chat_channel text;
comment on column public.listings.chat_channel is
  '''web'' when made in the Listing Assistant (its updates go there); null for WhatsApp and the web app.';

-- The page reads one address's messages, newest last.
create index if not exists whatsapp_message_log_phone_created_idx on public.whatsapp_message_log (phone_number, created_at desc);
