import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

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

  const cutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const db = createServerClient();

  try {
    const { data: stale, error: selectError } = await db
      .from("listings")
      .select("id")
      .in("status", ["draft", "failed"])
      .lt("created_at", cutoff);

    if (selectError) throw new Error(selectError.message);
    if (!stale || stale.length === 0) {
      return NextResponse.json({ ok: true, deleted_count: 0 });
    }

    const ids = stale.map((r) => r.id as string);
    const { error: deleteError } = await db.from("listings").delete().in("id", ids);
    if (deleteError) throw new Error(deleteError.message);

    console.log(`[cron/delete-stale-drafts] deleted ${ids.length} listing(s) older than ${STALE_DAYS}d`);
    return NextResponse.json({ ok: true, deleted_count: ids.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error(`[cron/delete-stale-drafts] failed:`, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
