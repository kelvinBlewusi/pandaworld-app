-- ─── Fixing what Jumia's quality check rejected ─────────────────────────────
--
-- lib/jumia/qc-remedy.ts decides what to do about a QC rejection (a table
-- of Jumia's known reasons, the AI for the rest), and the WhatsApp flow
-- asks the seller for what only they know: an FDA number, the real brand,
-- a price, new photos, or the reason itself when Jumia gave none.
--
--   listings.jumia_qc_reason / jumia_qc_comment
--     Jumia's own words (businessClients[].qc.rejectionReason and
--     .rejectionComment), kept apart from jumia_error's seller-facing text
--     so the decision reads exactly what Jumia said.
--   listings.qc_new_images
--     Replacement photos the seller is sending after a photo rejection,
--     held apart until they reply "done" so an abandoned answer never
--     leaves the listing without its photos.
--   whatsapp_sessions.awaiting_qc_answer
--     The question the bot is waiting on: {"listingId", "kind", "field",
--     "fieldLabel"}. Null when none.

alter table public.listings add column if not exists jumia_qc_reason  text;
alter table public.listings add column if not exists jumia_qc_comment text;
alter table public.listings add column if not exists qc_new_images    text[];
alter table public.whatsapp_sessions add column if not exists awaiting_qc_answer jsonb;

-- Atomic append for replacement photos, the same way append_listing_image
-- (2026-09-15_atomic-image-append.sql) does it for new listings: an album
-- arrives as concurrent deliveries, and a read-modify-write would keep
-- only the last photo.
create or replace function public.append_qc_photo(
  p_listing_id uuid,
  p_url        text,
  p_max        int default 8
)
returns table (image_count int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_after int;
begin
  update public.listings
     set qc_new_images = case
           when coalesce(array_length(qc_new_images, 1), 0) >= p_max then qc_new_images
           when array_position(qc_new_images, p_url) is not null     then qc_new_images
           else coalesce(qc_new_images, '{}') || p_url
         end
   where id = p_listing_id
  returning coalesce(array_length(qc_new_images, 1), 0) into v_after;
  return query select coalesce(v_after, 0);
end;
$$;

revoke execute on function public.append_qc_photo(uuid, text, int) from public, anon, authenticated;
grant execute on function public.append_qc_photo(uuid, text, int) to service_role;
