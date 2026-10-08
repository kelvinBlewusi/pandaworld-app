import { NextRequest, NextResponse } from "next/server";
import { workOnRuns } from "@/lib/evals/assistant-eval";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─── POST /api/worker/assistant-eval ─────────────────────────────────────────
//
// Works through a queued run of the assistant's test set
// (lib/evals/assistant-eval.ts): ten cases at a time against the real AI,
// saved as it goes, for about 45 seconds a call. Called by pg_cron each
// minute while a run is queued or running
// (supabase/migrations/2026-10-08_assistant-eval.sql), and nudged when one is
// queued from /admin/assistant-tests.
//
// Security: the same Bearer CRON_SECRET contract as the other workers, and
// fail-secure without it: each run spends AI calls.

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[assistant eval] CRON_SECRET is not set — refusing to run.");
    return new NextResponse("Server not configured", { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  try {
    const r = await workOnRuns(45_000);
    if (r.runId) console.info(`[assistant eval] run ${r.runId}: ${r.done}/${r.total}`);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    console.error(`[assistant eval] failed: ${(e as Error).message}`);
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
