import { NextRequest, NextResponse } from "next/server";
import { resetStaleQuotas, expireOverduePlans } from "@/lib/billing/quota";

export const dynamic = "force-dynamic";

// ─── GET /api/cron/reset-quotas ──────────────────────────────────────────────
// Vercel cron — runs daily at 00:05 UTC (see vercel.json).
//
// Two sweeps per run:
//
//   1. resetStaleQuotas()
//      Resets per-period counters for idle ACTIVE subscriptions whose
//      period_start is > 30 days old. Lazy reset in quota.ts already
//      handles this for active users; the cron is for idle sellers who
//      log in expecting "0 / 30" instead of "27 / 30 (last period)".
//
//   2. expireOverduePlans()
//      Downgrades paid plans to "free" + status="expired" when
//      current_period_end has passed. Handles:
//        - One-time Page payments that weren't renewed (30 days after pay)
//        - Cancelled subscriptions whose grace period ended
//        - Any paid row stuck with status=active past its period
//      The lazy enforcement in getEffectivePlan() handles correctness at
//      request time; this cron keeps the DB row truthful for the billing
//      UI's plan badge + any admin queries against Supabase directly.
//
// Idempotency: both sweeps are safe to re-run. They only update rows
// that need it (WHERE clauses), so re-runs are no-ops on already-clean
// rows.
//
// Security: Vercel sets `Authorization: Bearer <CRON_SECRET>`. If
// CRON_SECRET is unset we refuse — better than exposing a route that
// could be triggered by anyone to downgrade everyone's subscription.

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
    // Run both sweeps in parallel — they touch different rows
    // (active-and-stale vs. paid-and-overdue) so they can't race.
    const [resetResult, expireResult] = await Promise.all([
      resetStaleQuotas(),
      expireOverduePlans(),
    ]);

    console.log(
      `[cron/reset-quotas] reset ${resetResult.reset_count} idle row(s); ` +
        `expired ${expireResult.expired_count} overdue paid plan(s) to free`,
    );

    return NextResponse.json({
      ok:            true,
      reset_count:   resetResult.reset_count,
      expired_count: expireResult.expired_count,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    console.error(`[cron/reset-quotas] failed:`, msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
