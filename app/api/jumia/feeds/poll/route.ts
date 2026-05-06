import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { getValidJumiaCredentials, getFeedStatus } from "@/lib/jumia/api";

// ─── POST /api/jumia/feeds/poll ───────────────────────────────────────────────
// Body: { listingIds: string[] }
//
// For each listing, polls TWO feed types:
//   A. Create feed (jumia_ref)     — status pending_approval
//      DONE+success → "live" | DONE+failed → "failed" | ERROR → "failed"
//   B. Update feed (update_feed_ref) — update_feed_status pending
//      DONE → update_feed_status='done' | ERROR → update_feed_status='error'
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
  // ── Fetch create-pending and update-pending listings ─────────────────────
  const { data: rows } = await db
    .from("listings")
    .select("id, status, jumia_ref, update_feed_ref, update_feed_status")
    .in("id", listingIds)
    .eq("user_id", userId)
    .or(
      "and(status.eq.pending_approval,jumia_ref.not.is.null)," +
      "and(update_feed_status.eq.pending,update_feed_ref.not.is.null)"
    );

  if (!rows || rows.length === 0) {
    return NextResponse.json({ results: [] });
  }

  const results: { id: string; status: string; error?: string }[] = [];

  for (const row of rows) {
    let currentStatus = row.status;

    // ── A. Poll create feed (pending_approval) ──────────────────────────────
    if (row.status === "pending_approval" && row.jumia_ref) {
      const feedStatus = await getFeedStatus(accessToken, row.jumia_ref as string);

      if (feedStatus) {
        console.info(
          `[Feed Poll] listingId=${row.id} feedId=${row.jumia_ref} status=${feedStatus.status} success=${feedStatus.success} failed=${feedStatus.failed}`
        );

        let newStatus: string | null = null;
        let errorMsg:  string | null = null;

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

        if (newStatus) {
          await db.from("listings").update({
            status:      newStatus,
            jumia_error: errorMsg,
            updated_at:  new Date().toISOString(),
          }).eq("id", row.id);
          currentStatus = newStatus;
          results.push({ id: row.id, status: newStatus, ...(errorMsg ? { error: errorMsg } : {}) });
          continue;
        }
      }
    }

    // ── B. Poll update feed (update_feed_status=pending) ────────────────────
    if (row.update_feed_status === "pending" && row.update_feed_ref) {
      const feedStatus = await getFeedStatus(accessToken, row.update_feed_ref as string);

      if (feedStatus) {
        console.info(
          `[Feed Poll] UPDATE listingId=${row.id} feedId=${row.update_feed_ref} status=${feedStatus.status}`
        );

        let newUpdateStatus: string | null = null;

        if (feedStatus.status === "DONE") {
          newUpdateStatus = "done";
        } else if (feedStatus.status === "ERROR") {
          newUpdateStatus = "error";
        }

        if (newUpdateStatus) {
          await db.from("listings").update({
            update_feed_status: newUpdateStatus,
            updated_at:         new Date().toISOString(),
          }).eq("id", row.id);
        }
      }
    }

    results.push({ id: row.id, status: currentStatus });
  }

  return NextResponse.json({ results });
}
