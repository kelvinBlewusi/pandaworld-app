import { NextRequest, NextResponse } from "next/server";
import { polishListing, polishQueue } from "@/lib/whatsapp/chat-polish";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─── POST /api/worker/polish-images ──────────────────────────────────────────
//
// Polishes the photos of chat listings whose notes asked for it (queued at
// drafting, lib/whatsapp/chat-polish.ts): two at a time, each about 30
// seconds, so a run stays inside the 60s budget. Nudged when one is queued,
// and called by pg_cron's every-minute job while any is waiting
// (supabase/migrations/2026-10-07_chat-polish-cron.sql).
//
// Security: same Bearer CRON_SECRET contract as the other workers, and
// fail-secure if the secret isn't configured: this spends sellers' credits.

const CLAIM_LIMIT = 2;

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[polish worker] CRON_SECRET is not set — refusing to run.");
    return new NextResponse("Server not configured", { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  try {
    const ids = await polishQueue(CLAIM_LIMIT);
    const outcomes = await Promise.all(ids.map((id) => polishListing(id).catch((e) => {
      console.error(`[polish worker] ${id}: ${(e as Error).message}`);
      return "failed" as const;
    })));
    if (ids.length > 0) console.info(`[polish worker] ${ids.map((id, i) => `${id}=${outcomes[i]}`).join(" ")}`);
    return NextResponse.json({ ok: true, polished: ids.length });
  } catch (e) {
    console.error(`[polish worker] failed: ${(e as Error).message}`);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
