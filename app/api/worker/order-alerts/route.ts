import { NextRequest, NextResponse } from "next/server";
import { runOrderAlerts } from "@/lib/whatsapp/order-alerts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─── POST /api/worker/order-alerts ────────────────────────────────────────────
//
// New Jumia orders to WhatsApp, for sellers with the order_alerts feature.
// Called every 10 minutes by pg_cron (supabase/migrations/2026-10-06_order-
// alerts.sql). See lib/whatsapp/order-alerts.ts.
//
// Security: same Bearer CRON_SECRET contract as the other workers, and
// fail-secure if the secret isn't configured.

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[order alerts] CRON_SECRET is not set — refusing to run.");
    return new NextResponse("Server not configured", { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const run = await runOrderAlerts();
    if (run.alerted || run.held || run.failed) console.info(`[order alerts] ${JSON.stringify(run)}`);
    return NextResponse.json({ ok: true, ...run });
  } catch (e) {
    console.error(`[order alerts] failed: ${(e as Error).message}`);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
