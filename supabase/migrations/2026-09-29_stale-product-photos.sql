-- ─── Product photos no listing uses any more ────────────────────────────────
--
-- Storage has its own non-resetting 1 GB on the Free Plan, and photos are
-- ~15x the database footprint of a listing (~390 KB vs ~26 KB). On
-- 2026-09-29, 223 of the 429 files in product-images (16 of 25 MB) weren't
-- referenced by any listing: WhatsApp photos from chats that were never
-- finished, web uploads never saved to a listing, discarded enhanced
-- versions, and photos of deleted listings.
--
-- Returns the names of product-images objects older than `older_than` that
-- no listing references, in `images` or in `image_variants` (both the
-- original-URL keys and the polish/rebuild values). lib/listings/
-- retention.ts deletes them through the Storage API; objects can't be
-- deleted from SQL. Oldest first, `max_rows` at a time.
--
-- The retention job runs this after clearing photos from listings live for
-- 30+ days and deleting stale unsubmitted ones, so their photos are
-- unreferenced by then and go in the same pass.

create or replace function public.stale_product_photos(
  older_than interval default interval '30 days',
  max_rows   int      default 500
)
returns table (name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with refs as (
    select distinct split_part(substring(u from '/product-images/(.*)$'), '?', 1) as name
    from (
      select unnest(l.images) as u from public.listings l
      union all
      select v.value ->> k
      from public.listings l,
           jsonb_each(coalesce(l.image_variants, '{}'::jsonb)) v,
           unnest(array['polish', 'rebuild']) k
      union all
      select v.key
      from public.listings l,
           jsonb_each(coalesce(l.image_variants, '{}'::jsonb)) v
    ) x
    where u like '%/product-images/%'
  )
  select o.name
  from storage.objects o
  where o.bucket_id = 'product-images'
    and o.created_at < now() - older_than
    and not exists (select 1 from refs r where r.name = o.name)
  order by o.created_at
  limit max_rows;
$$;

-- It reads every seller's listings and the storage catalogue: server only.
revoke execute on function public.stale_product_photos(interval, int) from public, anon, authenticated;
grant execute on function public.stale_product_photos(interval, int) to service_role;
