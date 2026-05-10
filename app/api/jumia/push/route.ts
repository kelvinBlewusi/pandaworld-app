import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  getValidJumiaCredentials,
  pushProductsToJumia,
} from "@/lib/jumia/api";
import type { ListingRow, VariantRow } from "@/lib/supabase/types";

// ─── POST /api/jumia/push ─────────────────────────────────────────────────────
// Body: { listingId: string }
//
// 1. Validates the listing belongs to the requesting user
// 2. Checks required fields (title, price, category)
// 3. Gets a valid Jumia access token (auto-refreshes if needed)
// 4. Maps listing + variants → Jumia API payload
// 5. Pushes to Jumia Vendor Center API
// 6. Updates listing status + jumia_ref/jumia_error in DB
// 7. Returns { success, jumia_ref?, error? }

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  let listingId: string;
  try {
    const body = await req.json();
    listingId = body.listingId;
    if (!listingId) throw new Error("missing listingId");
  } catch {
    return NextResponse.json({ error: "listingId is required" }, { status: 400 });
  }

  const db = createServerClient();

  // ── Fetch listing (must belong to this user) ──────────────────────────────
  const { data: listing, error: listingErr } = await db
    .from("listings")
    .select("*")
    .eq("id", listingId)
    .eq("user_id", userId)
    .single();

  if (listingErr || !listing) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }

  const row = listing as ListingRow;

  // ── Validate required fields (mirrors Jumia API constraints exactly) ──────
  const errors: string[] = [];
  if (!row.title)          errors.push("title is required");
  else if (row.title.length < 15) errors.push(`title must be at least 15 characters (you have ${row.title.length})`);
  else if (row.title.length > 70) errors.push(`title must be 70 characters or fewer (you have ${row.title.length})`);

  if (!row.description)    errors.push("description is required");
  else if (row.description.length < 50) errors.push(`description must be at least 50 characters (you have ${row.description.length}) — Jumia hard limit`);
  else if (row.description.length > 9000) errors.push(`description must be 9,000 characters or fewer (you have ${row.description.length})`);

  if (!row.selling_price)  errors.push("price is required");
  if (!row.category_path && !row.category_id) errors.push("category is required");
  if (!row.brand)          errors.push("brand is required");
  if ((row.images ?? []).length === 0) errors.push("at least one image is required");

  if (errors.length > 0) {
    return NextResponse.json(
      { error: errors.join(". ") + "." },
      { status: 422 }
    );
  }

  // ── Fetch variants ────────────────────────────────────────────────────────
  const { data: variantsData } = await db
    .from("variants")
    .select("*")
    .eq("listing_id", listingId);

  const variants = (variantsData ?? []) as VariantRow[];

  // ── Get valid Jumia token + shopId ───────────────────────────────────────
  let accessToken: string;
  let shopId: string;
  let currency: string;
  try {
    ({ accessToken, shopId, currency } = await getValidJumiaCredentials(userId));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    if (msg === "JUMIA_NOT_CONNECTED") {
      return NextResponse.json(
        { error: "Jumia account not connected. Go to Settings → Integrations to connect." },
        { status: 403 }
      );
    }
    if (msg === "JUMIA_OAUTH_REQUIRED") {
      return NextResponse.json(
        { error: "Jumia authorisation required. Go to Settings → Integrations → Authorise." },
        { status: 403 }
      );
    }
    if (msg === "JUMIA_TOKEN_EXPIRED") {
      return NextResponse.json(
        { error: "Jumia access token expired. Go to Settings → Integrations → Re-authorise." },
        { status: 403 }
      );
    }
    if (msg === "JUMIA_NO_SHOP_ID") {
      return NextResponse.json(
        { error: "Could not retrieve your Jumia shop ID. Try disconnecting and reconnecting in Settings → Integrations." },
        { status: 403 }
      );
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // ── Generate a fresh parentSku on retry ────────────────────────────────────
  // Jumia rejects duplicate (parentSku, variation) pairs with
  // "Product with variation [X] already exists in parent sku [Y]". A previous
  // push attempt for this listing may have partially persisted on Jumia's side
  // even though our DB shows "failed". Append a short suffix so every push
  // gets a guaranteed-unique parentSku.
  //
  // We MUTATE the row.sku on the in-memory object so buildBaseProduct picks
  // it up, then persist the new SKU back so the user sees a consistent SKU in
  // their UI matching what Jumia has.
  const isRetry = row.status === "failed" || (row.jumia_synced_at != null);
  if (isRetry) {
    const suffix = Date.now().toString(36).slice(-4).toUpperCase();
    const baseSku = row.sku.replace(/-R[A-Z0-9]{4}$/i, "");  // strip any prior -RXXXX suffix
    row.sku = `${baseSku}-R${suffix}`;
    console.info(`[push] Retry detected — using fresh SKU ${row.sku} (was ${baseSku})`);
  }

  // Mark as processing while we wait for Jumia (also persist any new SKU)
  await db
    .from("listings")
    .update({
      status:     "processing",
      sku:        row.sku,
      updated_at: new Date().toISOString(),
    })
    .eq("id", listingId);

  // ── Push to Jumia API (brand resolution + payload mapping done internally) ─
  const result = await pushProductsToJumia(accessToken, shopId, row, variants, currency);

  // ── Update listing with result ────────────────────────────────────────────
  if (result.success) {
    await db
      .from("listings")
      .update({
        status:           "pending_approval",
        jumia_ref:        result.jumia_ref,
        jumia_error:      null,
        jumia_synced_at:  new Date().toISOString(),
        updated_at:       new Date().toISOString(),
      })
      .eq("id", listingId);

    return NextResponse.json({
      success:   true,
      jumia_ref: result.jumia_ref,
      message:   "Listing submitted to Jumia. It will appear as Pending Approval.",
    });
  } else {
    await db
      .from("listings")
      .update({
        status:      "failed",
        jumia_error: result.error ?? "Unknown error from Jumia",
        updated_at:  new Date().toISOString(),
      })
      .eq("id", listingId);

    return NextResponse.json(
      {
        success: false,
        error:   result.error ?? "Jumia rejected the submission",
        raw:     result.raw,
      },
      { status: 502 }
    );
  }
}
