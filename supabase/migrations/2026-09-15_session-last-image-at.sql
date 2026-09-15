-- Debounce the per-photo confirmation the bot sends during an album.
--
-- THE PROBLEM, from a seller's transcript on 2026-09-15:
--
--   📸 Product 4: got it (2 photos). Send more photos, or reply done…
--   📸 Product 4: got it (3 photos). Send more photos, or reply done…
--   📸 Product 4: got it (4 photos). Send more photos, or reply done…
--   📸 Product 4: got it (5 photos). Send more photos, or reply done…
--   📸 Product 4: got it (6 photos). Send more photos, or reply done…
--
-- Five near-identical messages, each with its own "Done ✅" button, for ONE
-- album. WhatsApp delivers an album as N independent webhook deliveries and
-- the bot answers every one of them.
--
-- It is not only noise. Each is a billable WhatsApp send, each pushes the
-- seller's own photos further up the scroll, and the repetition makes the
-- bot look like it is malfunctioning at exactly the moment the seller is
-- deciding whether to trust it.
--
-- THE FIX: confirm the FIRST photo of a burst, then stay quiet, and report
-- the real total once on "done" ("✅ Product 4 saved (6 photos)"). The
-- count is what the seller actually needs — it is the number that tells
-- them nothing was dropped, which is why it was added in the first place —
-- and it is more trustworthy delivered once, at the end, than five times
-- mid-flight.
--
-- This column is the burst marker: the moment the last photo for the
-- current product landed. Nullable, and null simply means "no burst in
-- progress", which is the correct reading both for a fresh session and for
-- every row that already exists.
alter table public.whatsapp_sessions
  add column if not exists last_image_at timestamptz;

comment on column public.whatsapp_sessions.last_image_at is
  'When the most recent photo for the current product arrived. Used to '
  'suppress duplicate "got it (N photos)" replies while an album is still '
  'being delivered; see handleAwaitingPhotos in lib/whatsapp/intake.ts.';

-- Win the right to send ONE confirmation per burst.
--
-- A plain read-then-write cannot do this. Album deliveries arrive as
-- separate webhook requests that run as separate Vercel invocations, each
-- of which read the session before any of them wrote — the same
-- read-your-own-writes race that produced one listing per photo
-- (2026-09-14_one-listing-per-batch-slot.sql) and then lost two photos out
-- of three (2026-09-15_atomic-image-append.sql). Third time, same lesson:
-- the row lock has to be what decides.
--
-- A single conditional UPDATE does it. Exactly one caller inside the
-- window matches a row and gets true; everyone else matches nothing and
-- stays quiet.
--
-- Note the window is anchored on the FIRST photo of a burst, not slid
-- forward by each one — the update only fires when it wins, so it only
-- writes then. That is the better behaviour on purpose: it guarantees at
-- most one confirmation per window no matter how many photos arrive, while
-- a genuinely long upload still reassures the seller once the window rolls
-- over instead of going silent for minutes.
create or replace function claim_photo_confirmation(
  p_phone  text,
  p_window interval default interval '8 seconds'
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  claimed boolean;
begin
  update whatsapp_sessions
  set last_image_at = now()
  where phone_number = p_phone
    and (last_image_at is null or last_image_at < now() - p_window)
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

-- Callable only by the server (service role). The WhatsApp webhook is the
-- sole caller and runs with the service key; anon/authenticated have no
-- business touching another seller's conversation state. Matches the
-- lockdown applied in 2026-09-15_lock-down-definer-functions.sql — Supabase
-- grants EXECUTE to these roles directly, so revoking from PUBLIC alone
-- would do nothing.
revoke execute on function public.claim_photo_confirmation(text, interval) from public;
revoke execute on function public.claim_photo_confirmation(text, interval) from anon;
revoke execute on function public.claim_photo_confirmation(text, interval) from authenticated;
