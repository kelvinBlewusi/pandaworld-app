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

/**
 * Database objects the CODE requires, each probed through the same
 * interface the app uses.
 *
 * This is the migration ledger, and it is executable on purpose. Migrations
 * here are applied by hand, and nothing recorded which had actually landed
 * — so the repository and production could disagree indefinitely with no
 * signal at all. A checked-in list of "migrations we believe are applied"
 * would rot the first time someone forgot to update it; a probe cannot,
 * because it asks the database.
 *
 * A missing object is reported the same way a stuck queue is: loudly, once
 * every five minutes, until someone runs the migration. That is the whole
 * point — shipping code whose migration was never applied should be noisy
 * within minutes, not discovered by a seller weeks later.
 *
 * Each probe must be harmless to run repeatedly against production, so they
 * either read, or write against a key that cannot exist.
 */
const SCHEMA_PROBES: { object: string; migration: string; probe: (db: ReturnType<typeof createServerClient>) => PromiseLike<{ error: { message: string; code?: string } | null }> }[] = [
  {
    object:    "whatsapp_sessions.last_image_at",
    migration: "2026-09-15_session-last-image-at.sql",
    probe:     (db) => db.from("whatsapp_sessions").select("last_image_at").limit(1),
  },
  {
    object:    "claim_photo_confirmation()",
    migration: "2026-09-15_session-last-image-at.sql",
    // A phone number that cannot exist: the function returns false and
    // writes nothing, so this is safe on every tick.
    probe:     (db) => db.rpc("claim_photo_confirmation", { p_phone: "__healthcheck__" }),
  },
  {
    object:    "append_listing_image()",
    migration: "2026-09-15_atomic-image-append.sql",
    // An all-zero uuid matches no listing, so the function no-ops.
    probe:     (db) => db.rpc("append_listing_image", {
      p_listing_id: "00000000-0000-0000-0000-000000000000",
      p_url:        "https://healthcheck.invalid/probe.jpg",
      p_max:        1,
    }),
  },
  {
    object:    "claim_analysis_jobs()",
    migration: "2026-09-13_analysis-jobs-queue.sql",
    // claim_limit 0 claims nothing.
    probe:     (db) => db.rpc("claim_analysis_jobs", { claim_limit: 0 }),
  },
];

/** PostgREST's codes for "that object does not exist", as distinct from a
 *  transient failure. Only these mean a migration is missing; anything else
 *  is reported as unreadable rather than as drift, because calling a
 *  timeout "schema drift" would send someone to the wrong problem. */
const MISSING_OBJECT_CODES = new Set(["PGRST202", "PGRST204", "42883", "42703"]);

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

  // ── Schema drift ────────────────────────────────────────────────────────
  const drift: string[] = [];
  const probeFailures: string[] = [];
  await Promise.all(SCHEMA_PROBES.map(async (p) => {
    try {
      const { error } = await p.probe(db);
      if (!error) return;
      if (error.code && MISSING_OBJECT_CODES.has(error.code)) {
        drift.push(`${p.object} is missing — run ${p.migration}`);
      } else {
        probeFailures.push(`${p.object} (${error.message})`);
      }
    } catch (e) {
      probeFailures.push(`${p.object} (${(e as Error).message})`);
    }
  }));

  if (drift.length > 0) {
    console.error(`[health] SCHEMA DRIFT: ${drift.join("; ")}`);
  }
  if (probeFailures.length > 0) {
    console.warn(`[health] could not probe ${probeFailures.length} object(s): ${probeFailures.join("; ")}`);
  }

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
  } else if (unreadable.length === 0 && drift.length === 0) {
    // Logged on the healthy path too, so "the watchdog is fine" and "the
    // watchdog is not running" cannot look the same — the exact mistake
    // that hid the feed-poll outage.
    console.info("[health] all clear");
  }

  return NextResponse.json({
    ok: breached.length === 0 && unreadable.length === 0 && drift.length === 0,
    checks: Object.fromEntries(
      checks.map((c) => [c.name, c.error ? { error: c.error } : c.count]),
    ),
    ...(drift.length ? { schemaDrift: drift } : {}),
    thresholds: STUCK_AFTER,
  });
}
