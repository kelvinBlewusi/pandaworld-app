import { NextRequest, NextResponse } from "next/server";
import { runAndReport } from "@/lib/jumia/api-checks";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─── POST /api/worker/jumia-api-checks ───────────────────────────────────────
//
// Once a day (pg_cron, supabase/migrations/2026-10-09_jumia-api-checks.sql):
// every read request the chat relies on, against the owner's own shop
// (lib/jumia/api-checks.ts). Results go to jumia_api_checks and
// /admin/jumia-api. A failure is logged with console.error (Sentry) and sent
// to the owner on WhatsApp, so a Jumia change is known the same morning.
//
// Security: the same Bearer CRON_SECRET contract as the other workers, and
// fail-secure without it.

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[jumia api checks] CRON_SECRET is not set — refusing to run.");
    return new NextResponse("Server not configured", { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const { userId, results } = await runAndReport();
  if (!userId) return NextResponse.json({ ok: false, error: "no admin account with Jumia connected" });
  return NextResponse.json({ ok: results.every((r) => r.ok), checks: results.length, failed: results.filter((r) => !r.ok).length });
}
