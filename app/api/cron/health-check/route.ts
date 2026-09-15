import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// ─── GET /api/cron/health-check ───────────────────────────────────────────────
//
// The watchdog. Counts the states that mean something is stuck, and logs
// loudly when any of them is non-zero.
//
// WHY THIS EXISTS: every serious failure this system has had was silent.
// Not unreported — silent. The pattern repeats:
//
//   * a batch whose last job parked in 'queued' with its attempts spent,
//     so the seller's session never left "analyzing"
//   * a feed poll that returned 200 {checked: 0} every minute for 26
//     minutes while four listings sat at pending_approval
//   * a listing stranded at 'processing' because the push bailed after
//     claiming the row
//
// None of those throw. Nothing goes red. A seller notices, eventually, and
// tells us. This route is the thing that notices first.
//
// It deliberately does NOT try to repair anything. A watchdog that fixes
// things hides the rate at which they break, and these counts are the only
// measure of whether the fixes shipped alongside it actually worked. Repair
// belongs in the code that owns each state.
//
// Alerting rides on console.error, which sentry.server.config.ts now
// captures as an event — so a breach becomes a Sentry alert with no extra
// wiring, and the same line is queryable in Vercel logs and in
// net._http_response.
//
// Security: same bearer-CRON_SECRET contract as every other /api/cron
// route, fail-secure when the secret is missing. It reads across all
// users, so an unauthenticated caller must never reach it.

/**
 * How long each state may last before it counts as stuck.
 *
 * Each is well clear of the healthy case, so a breach means something is
 * actually wrong rather than merely slow:
 *
 *   analysisJobMinutes  — a job is claimed within ~10s of settling and a
 *                         product takes ~23s. Five minutes is the stale
 *                         reclaim window; ten is two of those.
 *   analyzingMinutes    — the biggest batch we accept, drained three wide,
 *                         finishes well inside this.
 *   processingMinutes   — a push is a single API call. Anything still here
 *                         after five minutes was stranded, not slow.
 *   pendingHours        — Jumia usually resolves a feed in minutes. A day
 *                         means the poll is not reaching it.
 */
const STUCK_AFTER = {
  analysisJobMinutes: 10,
  analyzingMinutes:   20,
  processingMinutes:   5,
  pendingHours:       24,
} as const;

interface Check {
  name:   string;
  count:  number;
  detail: string;
  /** Set when the count could not be read at all — an unknown is not the
   *  same as a zero, and must never be reported as healthy. */
  error?: string;
}

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60_000).toISOString();
}

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[health] CRON_SECRET is not set — refusing to run.");
    return new NextResponse("Server not configured", { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const db = createServerClient();

  const count = async (
    name: string,
    detail: string,
    build: () => PromiseLike<{ count: number | null; error: { message: string } | null }>,
  ): Promise<Check> => {
    const { count: n, error } = await build();
    if (error) return { name, count: 0, detail, error: error.message };
    return { name, count: n ?? 0, detail };
  };

  const checks = await Promise.all([
    // A job nobody is working. Covers both halves of the stall fixed in
    // 2026-09-15_analysis-settle-window.sql: attempts spent and parked in
    // 'queued', or 'running' with a dead worker behind it.
    count(
      "analysis_jobs_stuck",
      `analysis jobs queued or running for over ${STUCK_AFTER.analysisJobMinutes}m`,
      () => db.from("analysis_jobs")
        .select("id", { count: "exact", head: true })
        .in("status", ["queued", "running"])
        .lt("created_at", minutesAgo(STUCK_AFTER.analysisJobMinutes)),
    ),

    // The seller-visible consequence of the above: a chat that answers
    // "Still drafting your products" forever.
    count(
      "sessions_stuck_analyzing",
      `WhatsApp sessions in "analyzing" for over ${STUCK_AFTER.analyzingMinutes}m`,
      () => db.from("whatsapp_sessions")
        .select("phone_number", { count: "exact", head: true })
        .eq("state", "analyzing")
        .lt("updated_at", minutesAgo(STUCK_AFTER.analyzingMinutes)),
    ),

    // A push that claimed the row and never released it. Nothing else
    // looks at 'processing', so without this it is invisible forever.
    count(
      "listings_stuck_processing",
      `listings stuck mid-push for over ${STUCK_AFTER.processingMinutes}m`,
      () => db.from("listings")
        .select("id", { count: "exact", head: true })
        .eq("status", "processing")
        .lt("updated_at", minutesAgo(STUCK_AFTER.processingMinutes)),
    ),

    // The exact symptom reported on 2026-09-15: submitted listings that
    // never stop saying "pending Jumia review".
    count(
      "listings_pending_too_long",
      `listings awaiting Jumia review for over ${STUCK_AFTER.pendingHours}h`,
      () => db.from("listings")
        .select("id", { count: "exact", head: true })
        .eq("status", "pending_approval")
        .not("jumia_ref", "is", null)
        .lt("updated_at", minutesAgo(STUCK_AFTER.pendingHours * 60)),
    ),
  ]);

  const unreadable = checks.filter((c) => c.error);
  const breached   = checks.filter((c) => !c.error && c.count > 0);

  // A check that could not run is reported separately and just as loudly.
  // "I don't know" answering as "all clear" is the failure mode this whole
  // route exists to end.
  if (unreadable.length > 0) {
    console.error(
      `[health] could not read ${unreadable.length} check(s): ` +
      unreadable.map((c) => `${c.name} (${c.error})`).join("; "),
    );
  }

  if (breached.length > 0) {
    console.error(
      "[health] STUCK: " +
      breached.map((c) => `${c.count} ${c.detail}`).join("; "),
    );
  } else if (unreadable.length === 0) {
    // Logged on the healthy path too, so "the watchdog is fine" and "the
    // watchdog is not running" cannot look the same — the exact mistake
    // that hid the feed-poll outage.
    console.info("[health] all clear");
  }

  return NextResponse.json({
    ok: breached.length === 0 && unreadable.length === 0,
    checks: Object.fromEntries(
      checks.map((c) => [c.name, c.error ? { error: c.error } : c.count]),
    ),
    thresholds: STUCK_AFTER,
  });
}
