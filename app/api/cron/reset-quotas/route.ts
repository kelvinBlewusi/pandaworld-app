import { NextRequest, NextResponse } from "next/server";
import { resetStaleQuotas } from "@/lib/billing/quota";

export const dynamic = "force-dynamic";

// ─── GET /api/cron/reset-quotas ──────────────────────────────────────────────
// Vercel cron — runs daily at 00:05 UTC (see vercel.json).
//
// What it does: Sweeps the subscriptions table for any active row whose
// period_start is more than 30 days in the past, resets that row's
// listings_used_this_period + polishes_used_this_period to 0, and bumps
// period_start to now().
//
// Why we need this: lib/billing/quota.ts already does a LAZY reset on
// every quota check, so for ACTIVE users the period resets organically
// as soon as they create their next listing or polish. This cron is the
// backup for IDLE accounts — sellers who took a month off but log in and
// look at their billing page expecting "used: 0 / 30" instead of
// "used: 27 / 30 (last period)". The cron also keeps Supabase reports
// accurate for any admin queries against the table directly.
//
// Idempotency: safe to run any number of times. The SQL only updates
// rows whose period_start is genuinely stale, so re-runs are no-ops.
//
// Security: Vercel sets `Authorization: Bearer <CRON_SECRET>`. If
// CRON_SECRET is unset we refuse — better than exposing a route that
// could be triggered to reset all idle accounts on demand.

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error(
      "[cron/reset-quotas] CRON_SECRET is not set — refusing to run. " +
        "Configure it in your Vercel env vars.",
    );
    return new NextResponse("Server not configured", { status: 500 });
  }

  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const { reset_count } = await resetStaleQuotas();
    console.log(`[cron/reset-quotas] reset ${reset_count} idle row(s)`);
    return NextResponse.json({ ok: true, reset_count });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error(`[cron/reset-quotas] failed:`, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
