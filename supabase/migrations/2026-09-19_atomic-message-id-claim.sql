-- Make the WhatsApp inbound-message dedupe atomic.
--
-- THE PROBLEM, from a real two-day session log (2026-09-17/18): the same
-- "Fix & resubmit" tap produced multiple interleaved "Fixing and
-- resubmitting..." messages and redundant AI reruns for one product, and
-- once (product 19, 2:13:19 AM) an "already submitted" collision appeared
-- immediately after a successful resubmit.
--
-- handleFixAndResubmit does an AI rerun (runAutoAnalyze) then a Jumia push
-- — routinely several seconds, sometimes past Meta's own webhook ack
-- timeout (~20s), at which point WhatsApp redelivers the ORIGINAL button
-- tap. The existing dedupe (`session.lastMessageId === messageId`, read at
-- the top of handleLinkedMessage) could not catch this: it only WROTE
-- last_message_id back to the row after the whole handler finished
-- (lib/whatsapp/intake.ts). Two deliveries of the same wamid, arriving
-- before either finished, both read the OLD last_message_id, both passed
-- the check, and both ran the full rerun+push. Jumia's own claim on the
-- listing's status (push-listing.ts's conditional UPDATE) stopped a real
-- duplicate PRODUCT from being created, but not the duplicate work or the
-- confusing interleaved chat messages.
--
-- THE FIX: the exact same pattern as claim_photo_confirmation
-- (2026-09-15_session-last-image-at.sql) — a single conditional UPDATE
-- that only one concurrent caller can win, checked BEFORE any slow work
-- starts rather than written after it finishes.
create or replace function claim_message_id(
  p_phone      text,
  p_message_id text
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  claimed boolean;
begin
  update whatsapp_sessions
  set last_message_id = p_message_id
  where phone_number = p_phone
    and last_message_id is distinct from p_message_id
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;

-- Same lockdown as every other server-only session function — see
-- 2026-09-15_lock-down-definer-functions.sql and
-- claim_photo_confirmation's own grant revocation just above it.
revoke execute on function public.claim_message_id(text, text) from public;
revoke execute on function public.claim_message_id(text, text) from anon;
revoke execute on function public.claim_message_id(text, text) from authenticated;
