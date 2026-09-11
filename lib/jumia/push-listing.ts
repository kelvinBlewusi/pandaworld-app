/**
 * Push a listing to Jumia — the core orchestration behind
 * POST /api/jumia/push, extracted so a caller with no Clerk session (the
 * WhatsApp webhook) can run the exact same flow by passing userId directly
 * instead of it being read from request cookies.
 *
 * Validates the listing, resolves/retries variants, gets a valid Jumia
 * token, calls pushProductsToJumia(), and persists the result — everything
 * the HTTP route used to do inline. The route is now a thin wrapper:
 * authenticate, rate-limit, call this, map the result to an HTTP response.
 */

import { createServerClient } from "@/lib/supabase/server";
import { getValidJumiaCredentials, pushProductsToJumia, markNeedsReconnect } from "@/lib/jumia/api";
import type { ListingRow, VariantRow } from "@/lib/supabase/types";

export interface PushListingVariantInput {
  variation:      string;
  sellerSku:      string;
  gtin?:          string | null;
  quantity?:      number;
  globalPrice?:   number | null;
  salePrice?:     number | null;
  saleStartDate?: string | null;
  saleEndDate?:   string | null;
}

export type PushListingResult =
  | { ok: true; jumiaRef: string | null; sku: string; skuChanged: boolean }
  | {
      ok: false;
      // Mirrors the distinct error branches the route used to return as
      // different HTTP statuses — callers map this to whatever shape their
      // own transport needs (HTTP status code, chat reply text, ...).
      code:
        | "not_found"
        | "validation"
        | "jumia_not_connected"
        | "jumia_oauth_required"
        | "jumia_token_expired"
        | "jumia_reconnect_required"
        | "jumia_no_shop_id"
        | "credentials_error"
        | "push_failed";
      message: string;
      needsReconnect?: boolean;
      raw?: unknown;
    };

/**
 * Push `listingId` (owned by `userId`) to Jumia. `bodyVariants`, when given,
 * is the UI's live in-memory variant state and takes priority over the
 * variants table — see the route's original doc comment on why (a silent
 * save failure shouldn't mean a stale DB row gets pushed instead of what
 * the caller actually has). Pass undefined/empty to fall back to the table.
 */
export async function pushListingToJumia(
  userId: string,
  listingId: string,
  bodyVariants?: PushListingVariantInput[] | null,
): Promise<PushListingResult> {
  const db = createServerClient();

  // ── Fetch listing (must belong to this user) ──────────────────────────────
  const { data: listing, error: listingErr } = await db
    .from("listings")
    .select("*")
    .eq("id", listingId)
    .eq("user_id", userId)
    .single();

  if (listingErr || !listing) {
    return { ok: false, code: "not_found", message: "Listing not found" };
  }

  const row = listing as ListingRow;

  // ── Validate required fields (mirrors Jumia API constraints exactly) ──────
  const errors: string[] = [];
  if (!row.title) errors.push("title is required");
  else if (row.title.length < 15) errors.push(`title must be at least 15 characters (you have ${row.title.length})`);

  if (!row.description) errors.push("description is required");
  else if (row.description.length < 50) errors.push(`description must be at least 50 characters (you have ${row.description.length}) — Jumia hard limit`);
  else if (row.description.length > 9000) errors.push(`description must be 9,000 characters or fewer (you have ${row.description.length})`);

  if (!row.selling_price) errors.push("price is required");

  const catCode = row.category_code ? parseInt(row.category_code, 10) : 0;
  if (!catCode || isNaN(catCode) || catCode <= 0) {
    errors.push(
      "category is required — open the listing, click the Category field, and pick a leaf from the drawer (legacy listings need a re-pick)",
    );
  }

  if (!row.brand) errors.push("brand is required");
  if ((row.images ?? []).length === 0) errors.push("at least one image is required");

  if (errors.length > 0) {
    return { ok: false, code: "validation", message: errors.join(". ") + "." };
  }

  // ── Resolve variants: prefer caller-supplied (live UI state), fall back to DB ──
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
    const { data: variantsData } = await db.from("variants").select("*").eq("listing_id", listingId);
    variants = (variantsData ?? []) as VariantRow[];
  }

  // ── Validate variants: variation non-empty + unique within the listing ──
  if (variants.length > 0) {
    const variationErrors: string[] = [];
    const seenVariations = new Set<string>();
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i];
      const trimmed = (v.variation ?? "").trim();
      if (!trimmed) {
        variationErrors.push(`Variant ${i + 1} has no Variation label — type one before submitting.`);
        continue;
      }
      const lower = trimmed.toLowerCase();
      if (seenVariations.has(lower)) {
        variationErrors.push(
          `Two variants share the same Variation label "${trimmed}". Jumia treats them as duplicates — rename one (e.g. add a suffix).`,
        );
      }
      seenVariations.add(lower);
    }
    if (variationErrors.length > 0) {
      return { ok: false, code: "validation", message: variationErrors.join(" ") };
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
      return { ok: false, code: "jumia_not_connected", message: "Jumia account not connected. Go to Settings → Integrations to connect." };
    }
    if (msg === "JUMIA_OAUTH_REQUIRED") {
      return { ok: false, code: "jumia_oauth_required", message: "Jumia authorisation required. Go to Settings → Integrations → Authorise.", needsReconnect: true };
    }
    if (msg === "JUMIA_TOKEN_EXPIRED") {
      return { ok: false, code: "jumia_token_expired", message: "Jumia access token expired. Reconnect in Settings → Integrations.", needsReconnect: true };
    }
    if (msg === "JUMIA_RECONNECT_REQUIRED") {
      return { ok: false, code: "jumia_reconnect_required", message: "Your Jumia OAuth app was deleted or revoked. Please reconnect.", needsReconnect: true };
    }
    if (msg === "JUMIA_NO_SHOP_ID") {
      return { ok: false, code: "jumia_no_shop_id", message: "Could not retrieve your Jumia shop ID. Try disconnecting and reconnecting in Settings → Integrations." };
    }
    return { ok: false, code: "credentials_error", message: msg };
  }

  // ── Generate a fresh parentSku on retry ────────────────────────────────────
  // See the module doc comment / original route history for why: Jumia
  // rejects duplicate (parentSku, variation) pairs, and a retry must
  // realign every variant's seller_sku to the new prefix too, or Jumia
  // treats it as an orphaned second product.
  const isRetry = row.status === "failed" || row.jumia_synced_at != null;
  if (isRetry) {
    const suffix = Date.now().toString(36).slice(-4).toUpperCase();
    const oldPrefix = row.sku.replace(/-R[A-Z0-9]{4}$/i, "");
    const newSku = `${oldPrefix}-R${suffix}`;
    row.sku = newSku;

    if (variants.length > 0) {
      const skuPatches: { id: string; seller_sku: string }[] = [];
      for (let i = 0; i < variants.length; i++) {
        const v = variants[i];
        const existing = v.seller_sku ?? "";
        const tag = existing.startsWith(oldPrefix)
          ? existing.slice(oldPrefix.length).replace(/^-/, "")
          : `V${i + 1}`;
        const realigned = `${newSku}-${tag}`;
        variants[i] = { ...v, seller_sku: realigned };
        skuPatches.push({ id: v.id, seller_sku: realigned });
      }
      await Promise.all(
        skuPatches.map((p) => db.from("variants").update({ seller_sku: p.seller_sku }).eq("id", p.id)),
      );
    }

    console.info(`[push] Retry detected — parentSku ${oldPrefix} → ${newSku}, realigned ${variants.length} variant SKU(s)`);
  }

  await db
    .from("listings")
    .update({ status: "processing", sku: row.sku, updated_at: new Date().toISOString() })
    .eq("id", listingId);

  // ── Push to Jumia API (brand resolution + payload mapping done internally) ─
  const result = await pushProductsToJumia(accessToken, shopId, row, variants, currency);

  if (result.success) {
    await db
      .from("listings")
      .update({
        status:          "pending_approval",
        jumia_ref:       result.jumia_ref,
        jumia_error:     null,
        jumia_synced_at: new Date().toISOString(),
        updated_at:      new Date().toISOString(),
      })
      .eq("id", listingId);

    return { ok: true, jumiaRef: result.jumia_ref, sku: row.sku, skuChanged: isRetry };
  }

  const errMsg = String(result.error ?? "");
  if (errMsg.includes("401") || errMsg.includes("403") || errMsg.toLowerCase().includes("unauthor")) {
    await markNeedsReconnect(db, userId);
  }

  await db
    .from("listings")
    .update({ status: "failed", jumia_error: result.error ?? "Unknown error from Jumia", updated_at: new Date().toISOString() })
    .eq("id", listingId);

  return { ok: false, code: "push_failed", message: result.error ?? "Jumia rejected the submission", raw: result.raw };
}
