/**
 * What PandaWorld keeps, and for how long. Run daily by
 * /api/cron/delete-stale-drafts.
 *
 *   - Drafts and failed listings: deleted 2 days after creation (see that
 *     route; unchanged here).
 *   - Listings live on Jumia for 30 days: photos deleted, the listing kept
 *     in the seller's history. Jumia downloaded its own copies when the
 *     feed was processed, so the live product doesn't need ours.
 *   - Photos no listing uses, 7 days after upload: deleted. Nothing needs
 *     one that long after upload (WhatsApp attaches photos within seconds,
 *     the web form within minutes), and deleting a draft never removed its
 *     photos, so they used to pile up: 223 of 429 files (16 of 25 MB) on
 *     2026-09-29.
 *
 * Why: Supabase's Free Plan gives Storage 1 GB that never resets, and a
 * listing's photos (~390 KB) are ~15x its database rows (~26 KB).
 * The privacy policy (app/privacy/page.tsx, section 4) states these
 * periods; change both together.
 */

import { createServerClient } from "@/lib/supabase/server";

const BUCKET = "product-images";
const DAY_MS = 24 * 60 * 60 * 1000;

export const LIVE_PHOTO_DAYS = 30;
export const UNUSED_PHOTO_DAYS = 7;
/** Storage's remove() takes a list; keep each request modest. */
const REMOVE_BATCH = 500;
/** Per run. A backlog bigger than this clears over the following days. */
const MAX_REMOVE_BATCHES = 10;

/**
 * Drop photos from listings that went live on Jumia 30+ days ago. The
 * files themselves go with the unused-photo sweep, once nothing points at
 * them. updated_at stands in for "went live": it's set when the status
 * turns live and only moves later if the seller edits the listing, which
 * just delays this.
 */
export async function clearOldLivePhotos(now = Date.now()): Promise<number> {
  const db = createServerClient();
  const cutoff = new Date(now - LIVE_PHOTO_DAYS * DAY_MS).toISOString();
  const { data, error } = await db
    .from("listings")
    .update({ images: [], image_variants: null })
    .eq("status", "live")
    .lt("updated_at", cutoff)
    .neq("images", "{}")
    .select("id");
  if (error) throw new Error(`clearing photos from old live listings: ${error.message}`);
  return data?.length ?? 0;
}

/**
 * Delete product photos older than UNUSED_PHOTO_DAYS that no listing
 * references (stale_product_photos(), supabase/migrations/2026-09-29_
 * stale-product-photos.sql). Deleted through the Storage API, which is
 * the only way to remove the files themselves.
 */
export async function removeUnusedPhotos(): Promise<number> {
  const db = createServerClient();
  let removed = 0;
  for (let batch = 0; batch < MAX_REMOVE_BATCHES; batch++) {
    const { data, error } = await db.rpc("stale_product_photos", {
      older_than: `${UNUSED_PHOTO_DAYS} days`,
      max_rows:   REMOVE_BATCH,
    });
    if (error) throw new Error(`finding unused photos: ${error.message}`);
    const names = ((data ?? []) as { name: string }[]).map((r) => r.name);
    if (names.length === 0) break;

    const { error: removeError } = await db.storage.from(BUCKET).remove(names);
    if (removeError) throw new Error(`deleting unused photos: ${removeError.message}`);
    removed += names.length;
    if (names.length < REMOVE_BATCH) break;
  }
  return removed;
}
