import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { getValidJumiaCredentials, getFeedStatus } from "@/lib/jumia/api";

// ─── POST /api/jumia/feeds/poll ───────────────────────────────────────────────
// Body: { listingIds: string[] }
//
// For each listing:
//   1. Fetches the jumia_ref (feedId) from DB
//   2. Calls GET /feeds/{feedId} on the Jumia API
//   3. Updates listing status:
//      - DONE + success > 0  → "live"
//      - DONE + failed > 0   → "failed" (with error detail)
//      - ERROR               → "failed"
//      - PROCESSING / other  → no change (still pending_approval)
//
// Returns: { results: { id, status, error? }[] }

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  let listingIds: string[];
  try {
    const body = await req.json();
    listingIds = body.listingIds;
    if (!Array.isArray(listingIds) || listingIds.length === 0) {
      throw new Error("listingIds must be a non-empty array");
    }
  } catch {
    return NextResponse.json({ error: "listingIds is required" }, { status: 400 });
  }

  // ── Get Jumia credentials ─────────────────────────────────────────────────
  let accessToken: string;
  try {
    ({ accessToken } = await getValidJumiaCredentials(userId));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 403 });
  }

  const db = createServerClient();

  // ── Fetch listings (must belong to this user) ─────────────────────────────
  const { data: rows } = await db
    .from("listings")
    .select("id, status, jumia_ref")
    .in("id", listingIds)
    .eq("user_id", userId)
    .eq("status", "pending_approval")
    .not("jumia_ref", "is", null);

  if (!rows || rows.length === 0) {
    return NextResponse.json({ results: [] });
  }

  const results: { id: string; status: string; error?: string }[] = [];

  // ── Poll each feed ────────────────────────────────────────────────────────
  for (const row of rows) {
    const feedId = row.jumia_ref as string;
    const feedStatus = await getFeedStatus(accessToken, feedId);

    if (!feedStatus) {
      // Can't reach Jumia API — leave as-is
      results.push({ id: row.id, status: row.status });
      continue;
    }

    console.info(
      `[Feed Poll] listingId=${row.id} feedId=${feedId} status=${feedStatus.status} success=${feedStatus.success} failed=${feedStatus.failed}`
    );

    let newStatus: string | null = null;
    let errorMsg: string | null = null;

    if (feedStatus.status === "DONE") {
      if (feedStatus.failed > 0) {
        newStatus = "failed";
        const firstError = feedStatus.errors[0];
        errorMsg = firstError
          ? JSON.stringify(firstError).slice(0, 500)
          : "Jumia rejected one or more products in the feed";
      } else {
        newStatus = "live";
      }
    } else if (feedStatus.status === "ERROR") {
      newStatus = "failed";
      errorMsg = feedStatus.errors.length
        ? JSON.stringify(feedStatus.errors[0]).slice(0, 500)
        : "Jumia feed processing error";
    }
    // PROCESSING / QUEUED / unknown → leave as pending_approval

    if (newStatus) {
      await db
        .from("listings")
        .update({
          status:      newStatus,
          jumia_error: errorMsg,
          updated_at:  new Date().toISOString(),
        })
        .eq("id", row.id);

      results.push({ id: row.id, status: newStatus, ...(errorMsg ? { error: errorMsg } : {}) });
    } else {
      results.push({ id: row.id, status: row.status });
    }
  }

  return NextResponse.json({ results });
}
