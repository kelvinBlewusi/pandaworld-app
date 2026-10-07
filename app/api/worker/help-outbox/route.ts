import { NextRequest, NextResponse } from "next/server";
import { sendQueuedHelp } from "@/lib/whatsapp/help";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─── POST /api/worker/help-outbox ────────────────────────────────────────────
//
// Sends each seller named in app_settings `help_outbox` their own help
// message (lib/whatsapp/help.ts), then empties it: the owner's way to reach
// a seller who got stuck (2026-10-07). Called once by hand after the key is
// set (pg_net with the vault's cron_secret, as the minute workers do).
// WhatsApp only delivers it within 24 hours of the seller's last message.
//
// Security: the same Bearer CRON_SECRET contract as the other workers.

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return new NextResponse("Server not configured", { status: 500 });
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) return new NextResponse("Unauthorized", { status: 401 });
  try {
    const sent = await sendQueuedHelp();
    if (sent.length > 0) console.info(`[help outbox] sent to ${sent.join(", ")}`);
    return NextResponse.json({ ok: true, sent: sent.length });
  } catch (e) {
    console.error(`[help outbox] failed: ${(e as Error).message}`);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
