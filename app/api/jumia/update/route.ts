import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { getValidJumiaCredentials, updateProductOnJumia } from "@/lib/jumia/api";

// ─── POST /api/jumia/update ───────────────────────────────────────────────────
// Body: { listingId: string }
//
// 1. Auth (Clerk)
// 2. Fetch listing + variants (must belong to user, status must be "live")
// 3. getValidJumiaCredentials
// 4. updateProductOnJumia → feedId
// 5. DB: update_feed_ref=feedId, update_feed_status='pending'
// 6. Return { success, feedId }

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  let listingId: string;
  try {
    const body = await req.json();
    listingId = body.listingId;
    if (!listingId || typeof listingId !== "string") throw new Error();
  } catch {
    return NextResponse.json({ error: "listingId is required" }, { status: 400 });
  }

  const db = createServerClient();

  // ── Fetch listing ─────────────────────────────────────────────────────────
  const { data: listing } = await db
    .from("listings")
    .select("*")
    .eq("id", listingId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!listing) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }
  if (listing.status !== "live") {
    return NextResponse.json(
      { error: "Only live listings can be synced" },
      { status: 422 }
    );
  }

  // ── Fetch variants ────────────────────────────────────────────────────────
  const { data: variants } = await db
    .from("variants")
    .select("*")
    .eq("listing_id", listingId);

  // ── Get Jumia credentials ─────────────────────────────────────────────────
  let accessToken: string;
  let shopId:      string;
  try {
    ({ accessToken, shopId } = await getValidJumiaCredentials(userId));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 403 });
  }

  // ── Push update feed ──────────────────────────────────────────────────────
  const result = await updateProductOnJumia(accessToken, shopId, listing, variants ?? []);

  if (!result.success) {
    return NextResponse.json({ error: result.error ?? "Jumia update failed" }, { status: 502 });
  }

  // ── Record feed ref ───────────────────────────────────────────────────────
  await db.from("listings").update({
    update_feed_ref:    result.jumia_ref,
    update_feed_status: "pending",
    updated_at:         new Date().toISOString(),
  }).eq("id", listingId);

  return NextResponse.json({ success: true, feedId: result.jumia_ref });
}
