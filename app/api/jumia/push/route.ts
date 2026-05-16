import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  getValidJumiaCredentials,
  pushProductsToJumia,
  markNeedsReconnect,
} from "@/lib/jumia/api";
import type { ListingRow, VariantRow } from "@/lib/supabase/types";

// ─── POST /api/jumia/push ─────────────────────────────────────────────────────
//
// Body: {
//   listingId: string,
//   variants?: Array<{                ← preferred path: UI sends current state
//     variation:       string,         (non-empty required)
//     sellerSku:       string,
//     gtin?:           string | null,
//     quantity?:       number,
//     globalPrice?:    number | null,
//     salePrice?:      number | null,
//     saleStartDate?:  string | null,
//     saleEndDate?:    string | null,
//   }>,
// }
//
// When variants are provided in the body, push uses THOSE directly — the
// variants table is just persistence, not the source of truth for this
// push. This guarantees that whatever the seller saw on screen at click
// time is what reaches Jumia, even if a previous save failed to persist
// for any reason.
//
// When variants aren't provided (legacy callers), falls back to reading
// the variants table.
//
// 1. Validates the listing belongs to the requesting user
// 2. Checks required fields (title, price, category)
// 3. Validates variants: each variation non-empty, all variations unique
// 4. Gets a valid Jumia access token (auto-refreshes if needed)
// 5. Maps listing + variants → Jumia API payload
// 6. Pushes to Jumia Vendor Center API
// 7. Updates listing status + jumia_ref/jumia_error in DB
// 8. Returns { success, jumia_ref?, error? }

interface BodyVariant {
  variation:      string;
  sellerSku:      string;
  gtin?:          string | null;
  quantity?:      number;
  globalPrice?:   number | null;
  salePrice?:     number | null;
  saleStartDate?: string | null;
  saleEndDate?:   string | null;
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  let listingId: string;
  let bodyVariants: BodyVariant[] | null = null;
  try {
    const body = await req.json();
    listingId = body.listingId;
    if (!listingId) throw new Error("missing listingId");
    if (Array.isArray(body.variants)) {
      bodyVariants = body.variants as BodyVariant[];
    }
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
  // Removed hard max-70 — Jumia's official spec doesn't enforce a max
  // on name.value. We only block below the empirical min of 15.

  if (!row.description)    errors.push("description is required");
  else if (row.description.length < 50) errors.push(`description must be at least 50 characters (you have ${row.description.length}) — Jumia hard limit`);
  else if (row.description.length > 9000) errors.push(`description must be 9,000 characters or fewer (you have ${row.description.length})`);

  if (!row.selling_price)  errors.push("price is required");

  // Category: must have a numeric category_code that resolves to a real
  // Jumia leaf. The PandaWorld category drawer always sets category_code;
  // older drafts may only have category_path / category_id (legacy mock
  // IDs like "cat-mob") which Jumia will reject with code 0.
  const catCode = row.category_code ? parseInt(row.category_code, 10) : 0;
  if (!catCode || isNaN(catCode) || catCode <= 0) {
    errors.push(
      "category is required — open the listing, click the Category field, and pick a leaf from the drawer (legacy listings need a re-pick)"
    );
  }

  if (!row.brand)          errors.push("brand is required");
  if ((row.images ?? []).length === 0) errors.push("at least one image is required");

  if (errors.length > 0) {
    return NextResponse.json(
      { error: errors.join(". ") + "." },
      { status: 422 }
    );
  }

  // ── Resolve variants: prefer body (live UI state), fall back to DB ───────
  //
  // The UI state is the source of truth for what the seller actually saw
  // at click time. Reading from the variants table introduces a window
  // where a silent save failure leaves stale rows that get pushed instead
  // of the typed values.
  let variants: VariantRow[];
  if (bodyVariants && bodyVariants.length > 0) {
    variants = bodyVariants.map((v, i) => ({
      id:              `body-${i}`,
      listing_id:      listingId,
      variation:       v.variation,
      seller_sku:      v.sellerSku,
      gtin:            v.gtin            ?? null,
      quantity:        v.quantity        ?? 1,
      global_price:    v.globalPrice     ?? null,
      sale_price:      v.salePrice       ?? null,
      sale_start_date: v.saleStartDate   ?? null,
      sale_end_date:   v.saleEndDate     ?? null,
      created_at:      new Date().toISOString(),
    }));
  } else {
    const { data: variantsData } = await db
      .from("variants")
      .select("*")
      .eq("listing_id", listingId);
    variants = (variantsData ?? []) as VariantRow[];
  }

  // ── Validate variants: variation non-empty + unique within the listing ──
  //
  // Empty variation triggers the colour fallback in buildBaseProduct,
  // which silently substitutes listing.color. Duplicate variations cause
  // Jumia to dedup-reject all but one. Catching both here means the
  // seller sees a clear error instead of a confused Jumia response.
  if (variants.length > 0) {
    const variationErrors: string[] = [];
    const seenVariations = new Set<string>();
    for (let i = 0; i < variants.length; i++) {
      const v       = variants[i];
      const trimmed = (v.variation ?? "").trim();
      if (!trimmed) {
        variationErrors.push(`Variant ${i + 1} has no Variation label — type one before submitting.`);
        continue;
      }
      const lower = trimmed.toLowerCase();
      if (seenVariations.has(lower)) {
        variationErrors.push(
          `Two variants share the same Variation label "${trimmed}". ` +
          `Jumia treats them as duplicates — rename one (e.g. add a suffix).`,
        );
      }
      seenVariations.add(lower);
    }
    if (variationErrors.length > 0) {
      return NextResponse.json(
        { error: variationErrors.join(" ") },
        { status: 422 }
      );
    }
  }

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
        { error: "Jumia authorisation required. Go to Settings → Integrations → Authorise.", needsReconnect: true },
        { status: 401 }
      );
    }
    if (msg === "JUMIA_TOKEN_EXPIRED") {
      return NextResponse.json(
        { error: "Jumia access token expired. Reconnect in Settings → Integrations.", needsReconnect: true },
        { status: 401 }
      );
    }
    if (msg === "JUMIA_RECONNECT_REQUIRED") {
      return NextResponse.json(
        { error: "Your Jumia OAuth app was deleted or revoked. Please reconnect.", needsReconnect: true },
        { status: 401 }
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
  // CRITICAL: when we rename the parentSku, we MUST also rewrite every
  // variant's seller_sku to use the new prefix. Otherwise the variant
  // sellerSkus stay tied to the OLD parentSku (which Jumia may have already
  // committed) and Jumia treats the retry as a brand-new product whose
  // variants are orphaned from the parent — exactly the "2 different
  // products" the seller complained about. The variation label they typed
  // gets stuck on the orphan record while the new product takes whatever
  // base.variation fallback evaluates to.
  const isRetry = row.status === "failed" || (row.jumia_synced_at != null);
  if (isRetry) {
    const suffix    = Date.now().toString(36).slice(-4).toUpperCase();
    const oldPrefix = row.sku.replace(/-R[A-Z0-9]{4}$/i, "");  // strip any prior -RXXXX suffix
    const newSku    = `${oldPrefix}-R${suffix}`;
    row.sku = newSku;

    // Realign each variant's seller_sku to the new parentSku prefix and
    // persist the change back so a subsequent re-read (e.g. update flow)
    // stays consistent. Variants whose seller_sku didn't start with the
    // old prefix get a synthesised one to guarantee uniqueness within
    // this parent.
    if (variants.length > 0) {
      const skuPatches: { id: string; seller_sku: string }[] = [];
      for (let i = 0; i < variants.length; i++) {
        const v = variants[i];
        const existing = v.seller_sku ?? "";
        const tag      =
          existing.startsWith(oldPrefix)
            ? existing.slice(oldPrefix.length).replace(/^-/, "")  // "BLK1" from "PA-MP82-BLK1"
            : `V${i + 1}`;
        const realigned = `${newSku}-${tag}`;
        variants[i] = { ...v, seller_sku: realigned };
        skuPatches.push({ id: v.id, seller_sku: realigned });
      }
      // Fire-and-forget batch update — failure here doesn't block the push.
      // The variants array we pass to mapListingToJumiaProducts already has
      // the realigned values; the DB update is just to keep state coherent
      // for the next operation.
      await Promise.all(
        skuPatches.map((p) =>
          db.from("variants").update({ seller_sku: p.seller_sku }).eq("id", p.id),
        ),
      );
    }

    console.info(
      `[push] Retry detected — parentSku ${oldPrefix} → ${newSku}, ` +
      `realigned ${variants.length} variant SKU(s)`,
    );
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
      sku:       row.sku,
      sku_changed: isRetry,
      message:   "Listing submitted to Jumia. It will appear as Pending Approval.",
    });
  } else {
    // If Jumia returned 401/403, the OAuth app is likely dead. Mark the
    // connection as needs_reconnect so the global banner appears and
    // the user is funnelled back to onboarding.
    const errMsg = String(result.error ?? "");
    if (errMsg.includes("401") || errMsg.includes("403") || errMsg.toLowerCase().includes("unauthor")) {
      await markNeedsReconnect(db, userId);
    }

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
