import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isAdmin } from "@/lib/billing/admin";
import { embedPendingCategories } from "@/lib/jumia/embed-categories";

// Embedding ~10k categories takes a few minutes total. Bump the
// serverless timeout above the default 10s. Each batch is processed
// in parallel (5 in flight) so total wall time ≈ 10k / 5 * 0.4s ≈ 13min
// — but we limit per-call to 200 categories, so a single invocation
// takes ~16s. Call repeatedly until done.
export const maxDuration = 60;

// ─── POST /api/admin/embed-categories ────────────────────────────────────────
//
// One-time (and ongoing) manual backfill of jumia_categories.embedding —
// same underlying pipeline (lib/jumia/embed-categories.ts) the daily
// app/api/cron/embed-categories cron now runs automatically, kept here
// as an admin-triggered way to catch up immediately rather than waiting
// for the next scheduled run (e.g. right after a manual category sync).
// Idempotent — re-running only touches rows where embedding IS NULL.
//
// Auth:
//   - Requires authenticated Clerk user
//   - Requires that user to be in ADMIN_USER_IDS (env-var allowlist)
//
// Body (optional):
//   { batch_size: number }   // how many categories to embed this call
//                            // (default 200; max 500 to stay inside the
//                            // 60s serverless timeout)
//
// Returns:
//   {
//     embedded: number,      // rows updated this run
//     remaining: number,     // rows still without an embedding
//     done: boolean,         // true if remaining === 0
//   }
//
// Usage:
//   curl -X POST https://pandaworldai.site/api/admin/embed-categories \
//        -H "Cookie: __session=..."   (your Clerk session cookie)
//   Repeat until { done: true }.

const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE     = 500;

export async function POST(req: NextRequest) {
  // Admin gate — env-var allowlist (lib/billing/admin.ts)
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });
  if (!isAdmin(userId)) {
    return new NextResponse("Forbidden — admin only", { status: 403 });
  }

  // Parse optional batch_size from the body
  let batchSize = DEFAULT_BATCH_SIZE;
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body.batch_size === "number" && body.batch_size > 0) {
      batchSize = Math.min(MAX_BATCH_SIZE, Math.floor(body.batch_size));
    }
  } catch { /* no body — that's fine */ }

  try {
    const result = await embedPendingCategories(batchSize);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
