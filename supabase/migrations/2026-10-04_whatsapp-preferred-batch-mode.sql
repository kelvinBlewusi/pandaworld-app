-- The way of sending (I: send it all / II: guide me each step) is now
-- remembered per number, and used when a batch's choice isn't tapped.
-- Live 2026-10-04: a seller who had picked I twice skipped the tap twice,
-- sent photos the I way, and the bot, assuming II, put one product's photo
-- and price on another. See handleAwaitingPhotos in lib/whatsapp/intake.ts.

-- null is now "not picked for this batch"; false is an explicit II.
alter table public.whatsapp_sessions alter column batch_quiet drop not null;
alter table public.whatsapp_sessions alter column batch_quiet set default null;
-- false was the old default, not a pick.
update public.whatsapp_sessions set batch_quiet = null where batch_quiet = false;

alter table public.whatsapp_sessions add column if not exists preferred_batch_quiet boolean;

comment on column public.whatsapp_sessions.batch_quiet is
  'The way of sending picked for this batch: true = I (quiet), false = II (guided), null = not picked yet.';
comment on column public.whatsapp_sessions.preferred_batch_quiet is
  'The way of sending this number picked last, used when a batch''s choice is not tapped. Null until one is picked.';

-- Each number's last pick so far, from the taps on record.
update public.whatsapp_sessions s
set preferred_batch_quiet = (last.body_text = 'batch_mode:quiet')
from (
  select distinct on (phone_number) phone_number, body_text
  from public.whatsapp_message_log
  where direction = 'inbound' and body_text in ('batch_mode:quiet', 'batch_mode:interactive')
  order by phone_number, created_at desc
) last
where last.phone_number = s.phone_number;
