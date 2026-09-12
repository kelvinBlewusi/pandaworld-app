import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { decrementUsage } from "@/lib/billing/quota";

export const dynamic = "force-dynamic";

// ─── GET /api/cron/delete-stale-drafts ────────────────────────────────────────
// Vercel cron — runs daily at 00:10 UTC (see vercel.json).
//
// Deletes any listing still in "draft" or "failed" status 30 days after
// creation — abandoned drafts (started on the web dashboard, the
// extension, or a WhatsApp chat batch that was never submitted) that
// would otherwise pile up forever on /listings and
// /extension/whatsapp-listings. Anything that ever reached Jumia
// (pending_approval, live, ...) is never touched, regardless of age.
//
// Quota refund mirrors deleteListing()'s existing single-delete policy
// (lib/actions/listings.ts) exactly: only "draft"/"processing" statuses
// count as refundable there, so "failed" listings swept up here are
// deleted without a refund, same as a seller manually deleting one today.
//
// Security: Vercel sets `Authorization: Bearer <CRON_SECRET>`. If
// CRON_SECRET is unset we refuse — better than exposing a route that
// could be triggered by anyone to mass-delete drafts.

const STALE_DAYS = 30;
const REFUNDABLE_STATUSES = new Set(["draft", "processing"]);

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
      .select("id, user_id, status")
      .in("status", ["draft", "failed"])
      .lt("created_at", cutoff);

    if (selectError) throw new Error(selectError.message);
    if (!stale || stale.length === 0) {
      return NextResponse.json({ ok: true, deleted_count: 0, refunded_count: 0 });
    }

    const ids = stale.map((r) => r.id as string);
    const { error: deleteError } = await db.from("listings").delete().in("id", ids);
    if (deleteError) throw new Error(deleteError.message);

    const refundable = stale.filter((r) => REFUNDABLE_STATUSES.has(r.status as string));
    await Promise.all(refundable.map((r) => decrementUsage(r.user_id as string, "listing")));

    console.log(
      `[cron/delete-stale-drafts] deleted ${ids.length} listing(s) older than ${STALE_DAYS}d; refunded ${refundable.length}`,
    );
    return NextResponse.json({ ok: true, deleted_count: ids.length, refunded_count: refundable.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error(`[cron/delete-stale-drafts] failed:`, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
