import { NextRequest, NextResponse } from "next/server";
import { renewExpiringConnections } from "@/lib/jumia/keepalive";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─── POST /api/worker/jumia-keepalive ─────────────────────────────────────────
//
// Renews Self Authorization Jumia connections before their tokens expire,
// so sellers stay connected without ever logging in again. Called every
// 30 minutes by pg_cron (supabase/migrations/2026-09-28_jumia-self-
// authorization.sql). See lib/jumia/keepalive.ts.
//
// Security: same Bearer CRON_SECRET contract as the other workers, and
// fail-secure if the secret isn't configured.

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[jumia keepalive] CRON_SECRET is not set — refusing to run.");
    return new NextResponse("Server not configured", { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const result = await renewExpiringConnections();
    if (result.renewed || result.lost || result.failed) {
      console.info(`[jumia keepalive] checked ${result.checked}, renewed ${result.renewed}, lost ${result.lost}, failed ${result.failed}`);
    }
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    console.error(`[jumia keepalive] failed: ${(e as Error).message}`);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
