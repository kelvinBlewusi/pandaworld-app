-- Append a photo to a listing ATOMICALLY.
--
-- Three photos of one product arrived and one survived. The webhook did
-- a read-modify-write:
--
--   select images        -> every concurrent delivery reads the SAME array
--   [...current, url]    -> each builds a one-element array
--   update set images    -> last write wins, the other two are gone
--
-- WhatsApp delivers an album as separate webhook messages within the same
-- second, so all three ran between each other's read and write. This is
-- the same race as the one listings_whatsapp_batch_slot_uniq closed for
-- listing CREATION, one level down: that fix made the three photos land
-- on a single listing, which is correct, and made this second race the
-- visible one.
--
-- A single UPDATE statement is the fix, not a tidier read-modify-write.
-- Concurrent updates to one row serialise on its lock, and under READ
-- COMMITTED the blocked statement re-evaluates against the committed
-- value — so `images || p_url` appends to whatever is actually there
-- rather than to a snapshot taken before the wait.
--
-- Photos land in commit order, which is not necessarily the order they
-- were sent. Nothing downstream depends on that order beyond images[0]
-- being the primary, and the alternative — sequencing an album whose
-- parts arrive out of order anyway — buys nothing a seller would notice.

create or replace function public.append_listing_image(
  p_listing_id uuid,
  p_url        text,
  p_max        int default 8
)
returns table (image_count int, at_cap boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_after int;
begin
  update public.listings
     set images = case
           -- At the cap, or this exact URL is already there (Meta retries
           -- a delivery it thinks we were too slow to ack), leave it be.
           when coalesce(array_length(images, 1), 0) >= p_max then images
           when array_position(images, p_url) is not null     then images
           else images || p_url
         end,
         updated_at = now()
   where id = p_listing_id
  returning coalesce(array_length(images, 1), 0) into v_after;

  -- No such listing: report nothing rather than inventing a count.
  if v_after is null then
    return query select 0, false;
    return;
  end if;

  -- Only the post-update count is reported. An earlier draft also
  -- returned "was this call the one that appended", computed from a
  -- second SELECT — which is read under a NEW snapshot and can already
  -- include another delivery's photo, so it answered a different question
  -- than the one it was asked. The count plus the cap flag is everything
  -- the caller actually needs, and both are true at the moment of write.
  return query select v_after, (v_after >= p_max);
end;
$$;

comment on function public.append_listing_image is
  'Atomic image append for the WhatsApp photo path. Replaces a read-modify-write that lost every photo of an album but the last.';
