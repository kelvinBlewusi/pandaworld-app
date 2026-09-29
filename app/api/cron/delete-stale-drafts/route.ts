import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { clearOldLivePhotos, removeUnusedPhotos } from "@/lib/listings/retention";

export const dynamic = "force-dynamic";

// ─── GET /api/cron/delete-stale-drafts ────────────────────────────────────────
// Vercel cron — runs daily at 00:10 UTC (see vercel.json).
//
// Deletes any listing still in "draft" or "failed" status 2 days after
// creation — abandoned drafts (started on the web dashboard, the
// extension, or a WhatsApp chat batch that was never submitted) that
// would otherwise pile up forever on /listings and
// /extension/whatsapp-listings. Anything that ever reached Jumia
// (pending_approval, live, ...) is never touched, regardless of age.
//
// Nothing is refunded, same as a seller deleting one by hand
// (lib/actions/listings.ts's deleteListing): credits paid for the AI work.
//
// Also the photo side of retention (lib/listings/retention.ts): photos
// are removed from listings live on Jumia for 30 days, and photos no
// listing uses (including the ones these deletions leave behind) are
// deleted 7 days after upload.
//
// Security: Vercel sets `Authorization: Bearer <CRON_SECRET>`. If
// CRON_SECRET is unset we refuse — better than exposing a route that
// could be triggered by anyone to mass-delete drafts.

// 2 days, down from 30. A chat-drafted product is a snapshot of an
// intent the seller had in one sitting — photos taken in a shop, a price
// in mind. If it hasn't been submitted within a couple of days it is far
// more likely abandoned than pending, and the pile of them is what makes
// the listings page hard to read. Re-drafting is cheap (send the photos
// again); wading through weeks of dead drafts is not.
//
// Anything that ever reached Jumia is still never touched, at any age.
const STALE_DAYS = 2;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error(
      "[cron/delete-stale-drafts] CRON_SECRET is not set — refusing to run. " +
        "Configure it in your Vercel env vars.",
    );
    return new NextResponse("Server not configured", { status: 500 });
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  // Each step runs whatever happened to the others, and reports on its
  // own. Drafts go first so their photos count as unused on a later run.
  const errors: string[] = [];
  const step = async (name: string, run: () => Promise<number>): Promise<number> => {
    try {
      return await run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Unknown error";
      console.error(`[cron/delete-stale-drafts] ${name} failed:`, msg);
      errors.push(`${name}: ${msg}`);
      return 0;
    }
  };

  const deleted_count = await step("stale drafts", deleteStaleDrafts);
  const live_photos_cleared = await step("old live photos", () => clearOldLivePhotos());
  const unused_photos_removed = await step("unused photos", removeUnusedPhotos);

  if (deleted_count || live_photos_cleared || unused_photos_removed) {
    console.log(
      `[cron/delete-stale-drafts] deleted ${deleted_count} listing(s) older than ${STALE_DAYS}d, ` +
      `cleared photos from ${live_photos_cleared} old live listing(s), removed ${unused_photos_removed} unused photo(s)`,
    );
  }
  return NextResponse.json(
    { ok: errors.length === 0, deleted_count, live_photos_cleared, unused_photos_removed, ...(errors.length ? { errors } : {}) },
    { status: errors.length ? 500 : 200 },
  );
}

async function deleteStaleDrafts(): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const db = createServerClient();

  const { data: stale, error: selectError } = await db
    .from("listings")
    .select("id")
    .in("status", ["draft", "failed"])
    .lt("created_at", cutoff);

  if (selectError) throw new Error(selectError.message);
  if (!stale || stale.length === 0) return 0;

  const ids = stale.map((r) => r.id as string);
  const { error: deleteError } = await db.from("listings").delete().in("id", ids);
  if (deleteError) throw new Error(deleteError.message);
  return ids.length;
}
