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
import {
  getValidJumiaCredentials,
  pushProductsToJumia,
  buildJumiaPayload,
  markNeedsReconnect,
  getFeedStatus,
  getFeedProductDetails,
  type FeedProductInfo,
} from "@/lib/jumia/api";
import { fingerprintListingContent, logFeedOutcome, type FeedOutcomeKind } from "@/lib/jumia/feed-outcomes";
import type { PreflightNote } from "@/lib/jumia/preflight";
import type { JumiaCategoryAttribute } from "@/lib/jumia/categories";
import type { ListingRow, ListingStatus, VariantRow } from "@/lib/supabase/types";
import { chargeLiveListing, creditsDueForSubmission, listingCreditCost } from "@/lib/billing/extension-credits";
import { hasFeature } from "@/lib/billing/features";
import { isUnlistableCategoryError } from "@/lib/jumia/unlistable-categories";
import { priceMinimumFor, isBelowMinimum, money } from "@/lib/jumia/price-minimums";

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

/**
 * The exact set of checks pushListingToJumia runs before ever calling
 * Jumia's API — extracted so callers can ask "is this ready?" ahead of
 * time (e.g. the WhatsApp batch-completion summary) using the same rules
 * a real push would enforce, rather than duplicating or drifting from
 * them. Returns a human-readable error per missing/invalid field; an
 * empty array means the listing is ready to push.
 */
export function validateListingForPush(row: ListingRow): string[] {
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

  return errors;
}

/**
 * Short field labels ("price", "category", ...) for whichever checks in
 * validateListingForPush are currently failing — the concise form used in
 * a chat summary, where the full sentence-length error text would be too
 * noisy. Order matches validateListingForPush's own check order.
 */
export function missingFieldLabels(row: ListingRow): string[] {
  const missing: string[] = [];
  if (!row.title || row.title.length < 15) missing.push("title");
  if (!row.description || row.description.length < 50 || row.description.length > 9000) missing.push("description");
  if (!row.selling_price) missing.push("price");
  const catCode = row.category_code ? parseInt(row.category_code, 10) : 0;
  if (!catCode || isNaN(catCode) || catCode <= 0) missing.push("category");
  if (!row.brand) missing.push("brand");
  if ((row.images ?? []).length === 0) missing.push("images");
  return missing;
}

/**
 * Statuses a listing may be pushed to Jumia FROM.
 *
 * An allow-list rather than a deny-list of the two in-flight states, so a
 * status added later refuses to push rather than pushing twice. The two
 * that are deliberately absent:
 *
 *   processing        — a push is in flight for this row right now
 *   pending_approval  — already at Jumia, waiting on their review
 *   live              — already on Jumia; re-pushing via create-feed mints
 *                       a SECOND product rather than touching the first.
 *                       This used to stay pushable "because the retry path
 *                       (which mints a fresh parentSku) is what 'Fix &
 *                       resubmit' relies on" — but that's exactly the bug:
 *                       a live listing that gets a spurious "Fix & resubmit"
 *                       tap (e.g. a stale button, a race between two taps)
 *                       created a real duplicate product on Jumia. The
 *                       in-place edit path for an already-live listing is
 *                       /api/jumia/update (updateProductOnJumia); this
 *                       function is create-only.
 */
const PUSHABLE_STATUSES: ListingStatus[] = ["draft", "awaiting_review", "failed"];

/**
 * Hand back a push claim taken by the conditional UPDATE in
 * pushListingToJumia, for the paths where nothing reached Jumia.
 *
 * Without this the row stays at 'processing' forever: the feed cron only
 * ever looks at 'pending_approval', so nothing else would move it, and the
 * claim itself would refuse every later attempt. Best-effort — a failure
 * here is logged, never thrown, because the caller is already on its way
 * to reporting a more useful error to the seller.
 */
async function releaseClaim(
  db: ReturnType<typeof createServerClient>,
  listingId: string,
  previousStatus: ListingStatus,
): Promise<void> {
  const back: ListingStatus = PUSHABLE_STATUSES.includes(previousStatus) ? previousStatus : "draft";
  const { error } = await db
    .from("listings")
    .update({ status: back, updated_at: new Date().toISOString() })
    .eq("id", listingId)
    .eq("status", "processing");
  if (error) {
    console.error(
      `[push] could not release the push claim on ${listingId} (${error.message}) — ` +
      `it will stay at 'processing' and refuse further submissions until corrected.`,
    );
  }
}

export type PushListingResult =
  | {
      ok: true; jumiaRef: string | null; sku: string; skuChanged: boolean;
      /** Values the pre-flight dropped or shortened on the way out. The
       *  push succeeded, but Jumia did not receive these as written, and
       *  the seller is the only one who can decide whether that matters. */
      adjustments?: string[];
    }
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
        | "already_submitted"
        | "insufficient_credits"
        | "push_failed";
      message: string;
      needsReconnect?: boolean;
      raw?: unknown;
    };

export type PreviewPayloadResult =
  | {
      ok: true;
      /** The exact products array a push would POST. */
      products: unknown[];
      /** Values Jumia will not receive as written. */
      adjustments: string[];
      /** Schema-required attributes with no value — a push would refuse. */
      missingRequired: string[];
      /** The same, as schema entries (name, type, allowed values). */
      missingRequiredAttributes: JumiaCategoryAttribute[];
      /** Everything validateListingForPush would reject on first. */
      blockers: string[];
      /** Raw preflight notes (with .reason) — see JumiaPayloadBuild.preflightNotes.
       *  A caller deciding Ready vs Held needs the reason tag; adjustments
       *  alone has already lost it to seller-facing prose. */
      preflightNotes: PreflightNote[];
    }
  | { ok: false; code: "not_found" | "not_connected" | "build_failed"; message: string };

/**
 * What a push WOULD send, without sending it.
 *
 * Runs the same validation and the same builder the real push runs —
 * buildJumiaPayload is literally the function pushProductsToJumia calls
 * before its POST. A preview assembled separately would drift from the
 * push, and a drifting preview is worse than no preview at all, because
 * it would be believed.
 *
 * Read-only: resolveBrand hits Jumia's catalogue and the schema comes
 * from our own cache. Nothing is written and no feed is created.
 */
export async function previewListingPayload(
  userId:       string,
  listingId:    string,
  bodyVariants?: PushListingVariantInput[] | null,
): Promise<PreviewPayloadResult> {
  const db = createServerClient();

  const { data: listing } = await db
    .from("listings").select("*").eq("id", listingId).eq("user_id", userId).maybeSingle();
  if (!listing) return { ok: false, code: "not_found", message: "Listing not found" };
  const row = listing as ListingRow;

  // Reported, not thrown. A seller previewing a half-finished draft wants
  // to SEE what is missing — refusing to render anything until it is
  // perfect would make the preview useless exactly when it is most
  // wanted.
  const blockers = validateListingForPush(row);

  let variants: VariantRow[];
  if (bodyVariants && bodyVariants.length > 0) {
    variants = bodyVariants.map((v, i) => ({
      id: `body-${i}`, listing_id: listingId,
      variation: v.variation, seller_sku: v.sellerSku,
      gtin: v.gtin ?? null, quantity: v.quantity ?? 1,
      global_price: v.globalPrice ?? null, sale_price: v.salePrice ?? null,
      sale_start_date: v.saleStartDate ?? null, sale_end_date: v.saleEndDate ?? null,
      created_at: new Date().toISOString(),
    }));
  } else {
    const { data } = await db.from("variants").select("*").eq("listing_id", listingId);
    variants = (data ?? []) as VariantRow[];
  }

  let accessToken: string;
  let currency: string;
  let country: string;
  try {
    ({ accessToken, currency, country } = await getValidJumiaCredentials(userId));
  } catch (e) {
    return {
      ok: false, code: "not_connected",
      message: (e as Error).message === "JUMIA_NOT_CONNECTED"
        ? "Connect your Jumia account to preview what gets sent."
        : "Your Jumia connection needs attention before this can be previewed.",
    };
  }

  const built = await buildJumiaPayload(accessToken, row, variants, currency, country);
  if (built.error) return { ok: false, code: "build_failed", message: built.error };

  return {
    ok: true,
    products:        built.products,
    adjustments:     built.adjustments,
    missingRequired: built.missingRequired,
    missingRequiredAttributes: built.missingRequiredAttributes,
    blockers,
    preflightNotes:  built.preflightNotes,
  };
}

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
  const errors = validateListingForPush(row);
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

  // Computed once, from the content as typed — see fingerprintListingContent's
  // own doc comment for why seller_sku is excluded (it changes on every retry).
  const payloadFingerprint = fingerprintListingContent(row, variants);

  // ── Credits: charged when the listing goes live, held from now ──────────
  // Checked before anything reaches Jumia, so a seller can't submit more
  // listings than they can pay for. Nothing is taken here: the amount is
  // recorded on the listing below and charged by refreshPendingFeedStatus
  // once Jumia confirms it live (lib/billing/extension-credits.ts).
  // The seller's own country's price (3 in Nigeria, 5 in Morocco, else 2).
  const listingCost = await listingCreditCost(userId);
  const credits = await creditsDueForSubmission(userId, listingId, listingCost);
  if (!credits.ok) {
    return {
      ok: false,
      code: "insufficient_credits",
      message: `Not enough credits: a listing costs ${listingCost} credits when it goes live on Jumia, and you have ${Math.max(0, credits.available)} available. Buy credits from your dashboard to submit it.`,
    };
  }

  // ── Get valid Jumia token + shopId ───────────────────────────────────────
  let accessToken: string;
  let shopId: string;
  let currency: string;
  let country: string;
  try {
    ({ accessToken, shopId, currency, country } = await getValidJumiaCredentials(userId));
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

  // ── A price below Jumia's minimum for this country ────────────────────────
  // Learned from Jumia's own rejections (lib/jumia/price-minimums.ts). Caught
  // here it costs nothing: no Jumia call, no rejection to fix, no credits
  // held. A product went to Jumia at GHS 3 against a GHS 8.81 floor on
  // 2026-10-04.
  // The prices as sent: each variant's own, else the listing's
  // (mapListingToJumiaProducts).
  const minimum = await priceMinimumFor(country);
  const sentPrices = variants.length > 0 ? variants.map((v) => v.global_price ?? row.selling_price) : [row.selling_price];
  const lowestPrice = Math.min(...sentPrices.map(Number).filter((n) => n > 0));
  if (isBelowMinimum(lowestPrice, minimum)) {
    return {
      ok: false,
      code: "validation",
      message: `price ${money(lowestPrice, minimum.currency)} is below the lowest Jumia allows (${money(minimum.min, minimum.currency)}) — set a higher price`,
    };
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

  // ── Claim the right to push, exactly once ─────────────────────────────────
  //
  // This used to be an unconditional write of status = 'processing'. Two
  // taps of "Submit all", a double-clicked button, or a WhatsApp webhook
  // retry that slipped past the message-id dedupe would each run the whole
  // function, and BOTH would reach Jumia. Worse, the second one is read as
  // a retry (isRetry fires on jumia_synced_at != null), so it is given a
  // fresh parentSku — which means Jumia cannot reject it as a duplicate
  // either. The seller ends up with two live products for one item, and is
  // charged for both.
  //
  // A single conditional UPDATE closes it: Postgres decides the winner,
  // and the loser gets no row back. Same pattern as claimBatchFinalization
  // in lib/whatsapp/analysis-queue.ts.
  //
  // PUSHABLE_STATUSES is a deliberate allow-list, not a deny-list of the
  // two in-flight states. A status nobody has thought of yet should refuse
  // to push rather than push twice.
  const { data: claimed, error: claimError } = await db
    .from("listings")
    .update({ status: "processing", sku: row.sku, updated_at: new Date().toISOString() })
    .eq("id", listingId)
    .in("status", PUSHABLE_STATUSES)
    .select("id");

  if (claimError) {
    return { ok: false, code: "credentials_error", message: `Could not start the submission: ${claimError.message}` };
  }
  if (!claimed || claimed.length === 0) {
    // Nothing was changed, so the row is in a state this must not push
    // from. Read it back rather than guessing, so the seller is told which
    // one — "already being submitted" and "already on Jumia" need
    // different actions from them.
    const { data: now } = await db.from("listings").select("status").eq("id", listingId).maybeSingle();
    const current = (now?.status as string | undefined) ?? row.status;
    return {
      ok: false,
      code: "already_submitted",
      message: current === "pending_approval"
        ? "This listing is already with Jumia and waiting on their review — submitting again would create a duplicate product."
        : current === "processing"
          ? "This listing is being submitted right now. Give it a moment."
          : current === "live"
            ? "This listing is already live on Jumia — submitting again via create would make a second, duplicate product. Use the edit path to change a live listing."
            : `This listing can't be submitted from its current state (${current}).`,
    };
  }

  // ── Push to Jumia API (brand resolution + payload mapping done internally) ─
  //
  // Wrapped because the claim above is now load-bearing: before it, an
  // exception here left a row at 'processing' that a later attempt could
  // still push. Now it would be stranded for good, so the claim is handed
  // back on the way out.
  let result: Awaited<ReturnType<typeof pushProductsToJumia>>;
  try {
    result = await pushProductsToJumia(accessToken, shopId, row, variants, currency, country);
  } catch (e) {
    await releaseClaim(db, listingId, row.status);
    throw e;
  }

  if (result.success) {
    // Deliberately NOT clearing jumia_rerun_fingerprint/jumia_rerun_count
    // here. "success" at this point only means Jumia's create call queued
    // the listing as pending_approval — the real accept/reject verdict
    // comes back later, asynchronously, from refreshPendingFeedStatus
    // below, which is where that bookkeeping actually gets cleared (on a
    // genuine "live" outcome). Clearing it here used to let an identical
    // rejection (e.g. the same non-integer capacity_liter value redrafted
    // unchanged) loop forever: every "Fix & resubmit" queued successfully,
    // resetting the cap, only for the async review to reject it the same
    // way again — see shouldBlockRepeatedAutoFix's doc comment, which this
    // defeated for exactly the case it was written to catch.
    await db
      .from("listings")
      .update({
        status:                    "pending_approval",
        jumia_ref:                 result.jumia_ref,
        jumia_error:               null,
        jumia_synced_at:           new Date().toISOString(),
        // Carried forward so refreshPendingFeedStatus can log this feed's
        // eventual per-SKU outcome against the content that produced it.
        jumia_payload_fingerprint: payloadFingerprint,
        // Charged when Jumia confirms it live, held until then.
        credits_due:               credits.due,
        // A new product, so a new quality check: a resubmission must not
        // inherit the last one's verdict (lib/jumia/qc-followup.ts).
        jumia_qc_status:           null,
        jumia_qc_checked_at:       null,
        jumia_qc_reason:           null,
        jumia_qc_comment:          null,
        updated_at:                new Date().toISOString(),
      })
      .eq("id", listingId);

    return {
      ok: true, jumiaRef: result.jumia_ref, sku: row.sku, skuChanged: isRetry,
      ...(result.adjustments?.length ? { adjustments: result.adjustments } : {}),
    };
  }

  // Refused locally — nothing reached Jumia. Recording it as a rejection
  // would be untrue twice over: it would leave the listing "failed" for a
  // submission that never happened, and it would clear the way for the
  // same payload to be retried unchanged. It's the same class of problem
  // as a missing price, so it comes back the same way: a validation error
  // naming the fields, with the draft left intact to fix.
  if (result.blocked === "missing_required") {
    await logFeedOutcome({
      listingId, feedId: null, sellerSku: row.sku, country,
      categoryCode: row.category_code, outcome: "blocked_locally",
      rawError: result.error, payloadFingerprint,
    });
    // Hand the claim back. Nothing reached Jumia, so the listing must
    // return to a state it can be pushed from once the seller fills the
    // gaps — otherwise it sits at 'processing' forever: the feed cron only
    // looks at 'pending_approval', so nothing would ever move it again,
    // and with the claim above in place it could never be submitted a
    // second time either. Latent before this change; unrecoverable after
    // it, which is why it is fixed in the same commit.
    await releaseClaim(db, listingId, row.status);
    return { ok: false, code: "validation", message: result.error ?? "This category needs more attributes." };
  }

  const errMsg = String(result.error ?? "");
  if (errMsg.includes("401") || errMsg.includes("403") || errMsg.toLowerCase().includes("unauthor")) {
    await markNeedsReconnect(db, userId);
  }

  // result.raw is only ever non-null when Jumia's create-feed endpoint
  // actually answered (see pushProductsToJumia) — every local-refusal
  // branch there (no schema yet, a blocked variant value, restricted
  // words/brand/category) returns raw: null. That's the difference
  // between a string worth writing a regression test against (Jumia's own
  // wording) and one that is ours to begin with.
  await logFeedOutcome({
    listingId, feedId: result.jumia_ref, sellerSku: row.sku, country,
    categoryCode: row.category_code,
    outcome: result.raw != null ? "rejected" : "blocked_locally",
    rawError: result.error ?? "Unknown error from Jumia", payloadFingerprint,
  });

  await db
    .from("listings")
    .update({
      status:      "failed",
      jumia_error: result.error ?? "Unknown error from Jumia",
      credits_due: null, // never went live: nothing to charge or hold
      updated_at:  new Date().toISOString(),
    })
    .eq("id", listingId);

  return { ok: false, code: "push_failed", message: result.error ?? "Jumia rejected the submission", raw: result.raw };
}

/**
 * Best-effort live check of ONE listing's create-feed status against
 * Jumia, updating the DB row in place if it has resolved (DONE/ERROR)
 * since it was last checked. Returns the listing's CURRENT status
 * afterward — unchanged if Jumia is still processing it, or if the check
 * itself fails (never throws; a stale-but-correct status beats blocking
 * on a flaky Jumia call).
 *
 * Same logic as app/api/jumia/feeds/poll/route.ts's create-feed branch,
 * extracted so the WhatsApp flow can call it too — a seller checking
 * *status* or trying to resubmit an already-pending product gets Jumia's
 * real current answer right then, instead of waiting for
 * app/api/cron/jumia-feeds (Vercel's Hobby plan caps cron frequency to
 * once a day, so that alone could leave a WhatsApp-only seller — who has
 * no reason to ever open the web app — waiting up to 24h to hear their
 * listing went live, even though Jumia often finishes in minutes).
 *
 * Notifies over WhatsApp on an actual transition, exactly as the cron
 * does. That is not a bonus — it's required for correctness: whichever
 * path observes the transition CONSUMES it, because the row stops being
 * pending_approval and the cron will never look at it again. Before this,
 * any non-cron refresh silently swallowed the seller's "it's live"
 * message.
 */
export interface FeedResolution {
  /** The listing's status after this check — unchanged if nothing resolved. */
  status:       string;
  error:        string | null;
  /** How many of the feed's products Jumia accepted. */
  liveCount:    number;
  totalCount:   number;
  /** Seller SKUs Jumia rejected, when it told us which. */
  rejectedSkus: string[];
}

/**
 * Every distinct human-readable rejection reason we can find, across ALL
 * rejected items and the feed-level errors — not just the first.
 *
 * A real batch can fail several SKUs for genuinely DIFFERENT reasons in
 * one feed (a variation value AND a decimal capacity, say). Storing only
 * the first one meant a seller who fixed problem A and tapped "Fix &
 * resubmit" only found out about problem B on the NEXT round trip, one
 * tap at a time — the same rejection surfaced piecemeal instead of all at
 * once. classifyJumiaRejection/buildRerunContext both work by testing
 * wire-format substrings against whatever text they're handed, so joining
 * every distinct reason (not paraphrasing them) lets a single redraft
 * address everything Jumia actually said, when the underlying fixes don't
 * conflict — and lets the seller see the whole picture even when they
 * don't.
 *
 * Per-product reasons come first (they name the actual variant's
 * problem), then feed-level ones, each reason kept exactly once. Jumia
 * sometimes hands back objects rather than strings.
 */
function allErrorTexts(rejected: FeedProductInfo[], feedErrors: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (text: string) => {
    const trimmed = text.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  };
  for (const item of rejected) {
    for (const e of item.errors) {
      if (typeof e === "string") add(e);
    }
  }
  for (const e of feedErrors) {
    if (typeof e === "string") add(e);
    else if (e && typeof e === "object") add(JSON.stringify(e));
  }
  // Jumia gives the feed's error and each product's own errors, and the
  // first often already holds the others word for word: every complaint
  // reached the seller twice (live, 2026-10-02). Kept once, in the longer.
  return out.filter((t) => !out.some((other) => other !== t && other.includes(t)));
}

type ResolutionCounts = { liveCount: number; totalCount: number; rejectedSkus: string[] };

/** One resolution's message text, in the seller's terms — shared by the
 *  single-listing notify below and the batched one, so the two render
 *  identically for the same input. Says what actually happened, including
 *  the partial case: a feed where four variants went live and one was
 *  rejected used to be reported to the seller (when it was reported at
 *  all) as a flat failure, which contradicted the four live products
 *  sitting in their Vendor Center. */
//
// A finished feed only means Jumia accepted the product; its quality check
// comes after (lib/jumia/qc-followup.ts). So "live" here says accepted and
// promises the QC verdict, and QC_APPROVED is the "🎉 live" message, sent
// when that check passes. Wording set by the owner, 2026-10-01.
export const QC_APPROVED = "qc_approved";
/**
 * A notice status, never a listing's: rejected, then fixed and sent back
 * without the seller (lib/jumia/auto-resubmit.ts). Its errorMsg says what
 * was changed.
 */
export const AUTO_RESUBMITTED = "auto_resubmitted";

/**
 * Where a seller hears about a listing: the Listing Assistant's chat for
 * one made there (chat_channel 'web'), else their linked WhatsApp number.
 * Null when it came from WhatsApp and none is linked any more.
 */
async function chatAddressFor(userId: string, channel: string | null): Promise<string | null> {
  if (channel === "web") {
    const { webAddress } = await import("@/lib/whatsapp/channel");
    return webAddress(userId);
  }
  const { getWhatsAppConnection } = await import("@/lib/whatsapp/link");
  const wa = await getWhatsAppConnection(userId);
  return wa.connected && wa.phoneNumber ? wa.phoneNumber : null;
}

/** Not a rejection: nothing to fix. */
const isGoodNews = (status: string) => status === "live" || status === QC_APPROVED || status === AUTO_RESUBMITTED;

/** Wholly accepted by Jumia (not yet through QC): for a seller with QC follow-up, nothing to tell yet. */
const acceptedQuietly = (status: string, counts: ResolutionCounts) =>
  status === "live" && !(counts.totalCount > counts.liveCount && counts.liveCount > 0);

/**
 * Jumia refused the listing's category ("You can't list products in this
 * category…"): rather than "was rejected" and a Fix & resubmit tap that
 * redrafted a guess, the seller is asked for the right category there and
 * then (owner's request, 2026-10-03; askCategoryForRefusedListing in
 * lib/whatsapp/intake.ts). False for any other rejection, or when the
 * question couldn't be asked, so the usual message goes instead.
 */
async function askedForRefusedCategory(phoneNumber: string, listingId: string, errorMsg: string | null): Promise<boolean> {
  if (!isUnlistableCategoryError(errorMsg)) return false;
  try {
    const { askCategoryForRefusedListing } = await import("@/lib/whatsapp/intake");
    return await askCategoryForRefusedListing(phoneNumber, listingId);
  } catch (e) {
    console.warn(`[push-listing] category question for ${listingId} failed: ${(e as Error).message}`);
    return false;
  }
}

//
// `qcAlerts` is whether the seller has QC follow-up (the Standard pack and
// up, lib/billing/features.ts). Without it nothing will report the QC
// verdict, so acceptance doesn't promise one.
function resolutionLine(name: string, newStatus: string, errorMsg: string | null, counts: ResolutionCounts, qcAlerts = true): string {
  if (newStatus === QC_APPROVED) return `🎉 "${name}" passed Jumia QC and is now live on Jumia!`;
  if (newStatus === AUTO_RESUBMITTED) return `🔧 "${name}": ${errorMsg ?? "I fixed it and sent it back to Jumia."} I'll tell you how it goes.`;
  const partial = newStatus === "live" && counts.totalCount > counts.liveCount && counts.liveCount > 0;
  const promise = (they: boolean) => qcAlerts
    ? ` — Will alert you if ${they ? "they pass" : "it passes"} Jumia QC`
    : ". Jumia's quality check comes next; Vendor Center shows the result";
  return newStatus !== "live"
    ? `⚠️ "${name}" was rejected by Jumia: ${errorMsg ?? "see the app for details"}`
    : partial
      ? `✅ "${name}": Jumia accepted ${counts.liveCount} of ${counts.totalCount} variants${promise(true)}\n\n⚠️ Jumia rejected ${counts.rejectedSkus.length ? counts.rejectedSkus.join(", ") : "the rest"}. You can fix and resubmit just those from your listings.`
      : `✅ "${name}": Jumia accepted it${promise(false)}`;
}

/**
 * Tell a WhatsApp seller their listing resolved. Only fires for listings
 * that came from the chat flow — a web-app listing's seller watches the
 * app instead.
 *
 * Best-effort throughout: a failed lookup or send must never turn a
 * successful status refresh into an error for the caller.
 */
async function notifyListingResolved(
  listingId: string,
  newStatus: string,
  errorMsg: string | null,
  counts: ResolutionCounts = { liveCount: 0, totalCount: 0, rejectedSkus: [] },
): Promise<void> {
  try {
    const db = createServerClient();
    const { data: row } = await db
      .from("listings")
      .select("user_id, title, whatsapp_batch_id, chat_channel")
      .eq("id", listingId)
      .maybeSingle();

    if (!row?.whatsapp_batch_id) return;

    const { sendTextIfConfigured, sendButtonsIfConfigured } = await import("@/lib/whatsapp/client");

    // Made in the Listing Assistant: told there (lib/whatsapp/channel.ts).
    const to = await chatAddressFor(row.user_id as string, (row as { chat_channel?: string | null }).chat_channel ?? null);
    if (!to) return;
    const wa = { phoneNumber: to };

    // A refused category is asked for straight away: the question is the message.
    if (!isGoodNews(newStatus) && await askedForRefusedCategory(wa.phoneNumber, listingId, errorMsg)) return;

    const name = (row.title as string | null) ?? "Your product";
    // Whether QC follow-up will run: by pack, whatever the balance (it runs at 0 too).
    const qcAlerts = await hasFeature(row.user_id as string, "qc_fix", { ignoreBalance: true });
    // Accepted, with the QC verdict to follow: told then instead (see notifyBatchResolved).
    if (qcAlerts && acceptedQuietly(newStatus, counts)) return;
    const text = resolutionLine(name, newStatus, errorMsg, counts, qcAlerts);

    // A rejection gets a way out of it. Without this the message is a dead
    // end: Jumia's own wording ("The column [product_weight] is missing
    // from the file"), and nothing the seller can act on from the chat.
    // The button id carries the listing id because a rejection lands
    // whenever Jumia finishes processing — often long after the batch
    // closed and the session moved on — so it cannot rely on chat state.
    if (!isGoodNews(newStatus)) {
      await sendButtonsIfConfigured(wa.phoneNumber, text, [
        { id: `fix:${listingId}`, title: "Fix & resubmit" },
      ]);
      return;
    }
    await sendTextIfConfigured(wa.phoneNumber, text);
  } catch (e) {
    console.warn(`[push-listing] resolve notification failed for ${listingId}: ${(e as Error).message}`);
  }
}

export interface ResolvedListingNotice {
  listingId:    string;
  title:        string | null;
  /** The product's position in its WhatsApp batch (Product 1, Product 2,
   *  ...) — used to label a "Fix product N" button/row when several
   *  listings resolve in one cron pass, since "Fix & resubmit" alone
   *  doesn't say which product it applies to. */
  whatsappSeq:  number | null;
  batchId:      string;
  newStatus:    string;
  errorMsg:     string | null;
  counts:       ResolutionCounts;
}

/**
 * Turn one refreshPendingFeedStatus result into a ResolvedListingNotice
 * for the cron route to collect, or null when there's nothing to notify
 * about — either the status didn't actually change this pass, or the
 * listing has no whatsapp_batch_id (a web-app-only listing, which never
 * had a WhatsApp notification to send in the first place — the same
 * early-return notifyListingResolved has always had for this case).
 *
 * Pulled out of the cron route itself so this filtering has a test
 * without needing to exercise the whole HTTP handler.
 */
export function toResolvedNotice(
  listing: { id: string; title: string | null; whatsapp_batch_id: string | null; whatsapp_seq?: number | null },
  before:  string,
  result:  FeedResolution,
): ResolvedListingNotice | null {
  if (result.status === before || !listing.whatsapp_batch_id) return null;
  return {
    listingId:   listing.id,
    title:       listing.title,
    whatsappSeq: listing.whatsapp_seq ?? null,
    batchId:     listing.whatsapp_batch_id,
    newStatus:   result.status,
    errorMsg:    result.error,
    counts:      { liveCount: result.liveCount, totalCount: result.totalCount, rejectedSkus: result.rejectedSkus },
  };
}

/**
 * Notify one seller about every listing that resolved for ONE
 * whatsapp_batch_id in a single cron pass — one message instead of one
 * per listing.
 *
 * Real risk this closes: a 20-product "submit all" has Jumia resolve each
 * product's async review at its own pace, often spread across many of the
 * per-minute cron ticks (app/api/cron/jumia-feeds) rather than all at
 * once. Before this, EVERY resolution called notifyListingResolved
 * individually, so a batch could trickle in up to one "🎉 X is live!" /
 * "⚠️ X was rejected" message per product — a real contributor to the
 * ~108-message/20-product evidence behind the draft-phase fix in this same
 * area (see finalizeBatch in lib/whatsapp/intake.ts).
 *
 * The single-item case renders IDENTICALLY to notifyListingResolved
 * (same wording, same Fix & resubmit button) via the shared
 * resolutionLine — this is the common case in practice, since most cron
 * ticks resolve at most one or two products per batch, and nothing about
 * that experience should change.
 *
 * When 2+ listings from the SAME batch resolve in the SAME tick, the
 * message collapses into one combined summary text, plus a SEPARATE way
 * to act on it — because a rejection buried in a wall of text with
 * nothing to tap is a dead end. Real live example this closes: a
 * 2-product batch where one went live and one was rejected for a
 * category problem (a genuinely auto-fixable rejection —
 * classifyJumiaRejection treats "can't list products in this category" as
 * kind: "rerun") got a plain-text summary and a generic "Review listings"
 * link that didn't even show the rejection reason or offer a retry —
 * Fix & resubmit was reachable in principle but not in practice.
 *
 * Only a REJECTED item ever gets a tappable row or button below the
 * summary — a live item has nothing to fix, so it appears in the summary
 * text above and nowhere else. This used to include every item, live or
 * rejected, in the 4+ list (tapping a live row just confirmed it was
 * already live), which made "Pick a product to fix it" appear on a batch
 * that actually had nothing left to fix, or offer live products as if
 * they needed the same action as the rejected ones. Sized by how many
 * items actually need fixing, not by the batch's total size:
 *
 *   - 1-3 REJECTED items: reply-buttons hold three per message (Meta's own
 *     cap), so every rejected item gets its own "Fix product N" button in
 *     one message.
 *   - 4+ REJECTED items: a list holds up to 10 rows in ONE message (see
 *     sendList's own doc comment on why this replaced button-message
 *     chunking) — every rejected item gets a row, chunked across messages
 *     past the 10-row cap.
 */
export async function notifyBatchResolved(
  phoneNumber: string,
  batchId:     string,
  items:       ResolvedListingNotice[],
  opts:        { qcAlerts?: boolean } = {},
): Promise<void> {
  const qcAlerts = opts.qcAlerts ?? true;
  // Accepted with QC follow-up to come: not told now, "passed Jumia QC and
  // is live" (or the rejection) comes later (owner, 2026-10-07: fewer
  // messages per listing; Meta charges each one). A partly accepted one is
  // still told: its rejected variants need fixing.
  if (qcAlerts) items = items.filter((i) => !acceptedQuietly(i.newStatus, i.counts));
  if (items.length === 0) return;
  try {
    const { sendTextIfConfigured, sendButtonsIfConfigured, sendListIfConfigured, LIST_MAX_ROWS } = await import("@/lib/whatsapp/client");
    const { INTERACTIVE_BODY_MAX, splitForText } = await import("@/lib/whatsapp/text-limits");
    // Rejection reasons are Jumia's own and can run long: a summary past
    // what one message holds goes as several, never refused whole.
    const sendText = async (text: string) => {
      for (const part of splitForText(text)) await sendTextIfConfigured(phoneNumber, part);
    };

    if (items.length === 1) {
      const item = items[0];
      // A refused category is asked for straight away: the question is the message.
      if (!isGoodNews(item.newStatus) && await askedForRefusedCategory(phoneNumber, item.listingId, item.errorMsg)) return;
      const name = item.title ?? "Your product";
      const text = resolutionLine(name, item.newStatus, item.errorMsg, item.counts, qcAlerts);
      if (!isGoodNews(item.newStatus)) {
        const fix = [{ id: `fix:${item.listingId}`, title: "Fix & resubmit" }];
        if (text.length <= INTERACTIVE_BODY_MAX) {
          await sendButtonsIfConfigured(phoneNumber, text, fix);
        } else {
          await sendText(text);
          await sendButtonsIfConfigured(phoneNumber, `Fix "${name.slice(0, 80)}":`, fix);
        }
        return;
      }
      await sendText(text);
      return;
    }

    const rejected = items.filter((i) => !isGoodNews(i.newStatus));
    const accepted = items.filter((i) => i.newStatus === "live").length;
    const passed   = items.filter((i) => i.newStatus === QC_APPROVED).length;
    const resent   = items.filter((i) => i.newStatus === AUTO_RESUBMITTED).length;
    // Numbered, so each "Fix product N" tap below matches a line here.
    const number = (i: ResolvedListingNotice) => (i.whatsappSeq != null ? `Product ${i.whatsappSeq}: ` : "");
    const lines = items.map((i) => number(i) + resolutionLine(i.title ?? "Your product", i.newStatus, i.errorMsg, i.counts, qcAlerts));
    const products = (n: number) => `${n} product${n === 1 ? "" : "s"}`;
    const header =
      passed === items.length
        ? `🎉 Since your last update: ${products(passed)} passed Jumia QC and ${passed === 1 ? "is" : "are"} now live on Jumia!`
        : accepted === items.length
          ? `✅ Since your last update: Jumia accepted ${products(accepted)}${qcAlerts ? " — Will alert you as they pass Jumia QC" : "."}`
          : rejected.length === items.length
            ? `⚠️ Since your last update: ${products(rejected.length)} ${rejected.length === 1 ? "was" : "were"} rejected by Jumia.`
            : resent === items.length
              ? `🔧 Since your last update: I fixed ${products(resent)} Jumia turned down and sent ${resent === 1 ? "it" : "them"} back.`
              : `Since your last update: ${[
                  accepted > 0 ? `${accepted} accepted` : null,
                  passed > 0 ? `${passed} passed QC` : null,
                  resent > 0 ? `${resent} fixed and sent back` : null,
                  rejected.length > 0 ? `${rejected.length} rejected` : null,
                ].filter(Boolean).join(", ")}.`;

    await sendText([header, "", ...lines].join("\n"));

    if (rejected.length === 0) return;
    // The one rejection is a refused category: asked for, not a Fix tap.
    if (rejected.length === 1 && await askedForRefusedCategory(phoneNumber, rejected[0].listingId, rejected[0].errorMsg)) return;

    const label = (i: ResolvedListingNotice) => i.whatsappSeq != null ? `Product ${i.whatsappSeq}` : (i.title ?? "product");

    // Only a REJECTED item gets a row/button here — a live one has nothing
    // to fix, so offering it alongside "Pick a product to fix it" read as
    // an action available on every product when it only ever did anything
    // for the rejected ones (tapping a live row used to just confirm it
    // was already live, a dead tap dressed up as a choice). The live/rejected
    // counts are still in the summary text above; this is only the
    // follow-up affordance, sized to how many actually need fixing rather
    // than to the batch's total size.
    // A button holds 20 characters, room for "Fix product 12" and not the
    // name, so the message names each one: "Fix product 3" alone left the
    // seller guessing which product that was (live, 2026-10-02).
    if (rejected.length <= 3) {
      const named = rejected
        .filter((i) => i.whatsappSeq != null && i.title)
        .map((i) => `${label(i)} — ${(i.title as string).slice(0, 80)}`);
      await sendButtonsIfConfigured(
        phoneNumber,
        ["Fix what didn't go through:", ...named].join("\n"),
        rejected.map((i) => ({ id: `fix:${i.listingId}`, title: `Fix ${label(i)}`.slice(0, 20) })),
      );
      return;
    }

    // A row's subtitle names the product; why it was rejected is in the
    // numbered summary above.
    const rows = rejected.map((i) => ({
      id:          `fix:${i.listingId}`,
      title:       label(i),
      description: i.whatsappSeq != null && i.title ? i.title : `⚠️ Rejected — ${i.errorMsg ?? "see details"}`,
    }));
    for (let idx = 0; idx < rows.length; idx += LIST_MAX_ROWS) {
      const chunk = rows.slice(idx, idx + LIST_MAX_ROWS);
      await sendListIfConfigured(
        phoneNumber,
        idx === 0 ? "Tap a product to fix it:" : "…and the rest:",
        "Pick a product",
        chunk,
      );
    }
  } catch (e) {
    console.warn(`[push-listing] batch resolve notification failed for batch ${batchId}: ${(e as Error).message}`);
  }
}

// Jumia's reason, as kept on the listing. It was cut at 500 characters,
// which cut a 13-attribute "not visible for category" rejection mid-word;
// Fix & resubmit then misread it as a mixed rejection and redrafted
// (2026-10-01). Long enough for any rejection seen so far.
const MAX_STORED_ERROR = 4000;

/**
 * Fan out every listing that genuinely resolved in one cron pass for ONE
 * user — grouped by whatsapp_batch_id (see notifyBatchResolved) so a
 * multi-product batch gets at most one message per tick, not one per
 * listing. A listing with no whatsapp_batch_id (a web-app-only seller)
 * never reaches here to begin with — the cron route only adds an item for
 * this when one is present, matching notifyListingResolved's own
 * early-return for the same case.
 *
 * The seller's WhatsApp connection is looked up ONCE and reused across
 * every batch, rather than once per batch or per listing.
 */
export async function notifyResolvedListings(userId: string, resolved: ResolvedListingNotice[]): Promise<void> {
  if (resolved.length === 0) return;
  try {
    // Batches made in the Listing Assistant are told there; the rest on WhatsApp.
    const { data: channels } = await createServerClient().from("listings").select("id, chat_channel")
      .in("id", resolved.map((r) => r.listingId));
    const web = new Set(((channels ?? []) as { id: string; chat_channel?: string | null }[])
      .filter((c) => c.chat_channel === "web").map((c) => c.id));
    const whatsapp = await chatAddressFor(userId, null);
    const webChat = await chatAddressFor(userId, "web");

    const byBatch = new Map<string, ResolvedListingNotice[]>();
    for (const item of resolved) {
      if (!byBatch.has(item.batchId)) byBatch.set(item.batchId, []);
      byBatch.get(item.batchId)!.push(item);
    }
    const qcAlerts = await hasFeature(userId, "qc_fix", { ignoreBalance: true });
    for (const [batchId, items] of Array.from(byBatch)) {
      const to = items.some((i) => web.has(i.listingId)) ? webChat : whatsapp;
      if (to) await notifyBatchResolved(to, batchId, items, { qcAlerts });
    }
  } catch (e) {
    console.warn(`[push-listing] notifyResolvedListings failed for user ${userId}: ${(e as Error).message}`);
  }
}

export async function refreshPendingFeedStatus(
  accessToken: string,
  listing: { id: string; status: string; jumia_ref: string | null },
  opts: { allowNonPending?: boolean; skipNotify?: boolean } = {},
): Promise<FeedResolution> {
  const isPending = listing.status === "pending_approval";
  if ((!isPending && !opts.allowNonPending) || !listing.jumia_ref) {
    return { status: listing.status, error: null, liveCount: 0, totalCount: 0, rejectedSkus: [] };
  }
  try {
    // Both come from the same GET /feeds/{id} — the counts tell us what
    // happened, the per-item details tell us to WHICH variant, which is
    // the difference between "your listing failed" and "4 of 5 variants
    // are live, Orange was rejected".
    const [feedStatus, productDetails] = await Promise.all([
      getFeedStatus(accessToken, listing.jumia_ref),
      getFeedProductDetails(accessToken, listing.jumia_ref),
    ]);
    if (!feedStatus) return { status: listing.status, error: null, liveCount: 0, totalCount: 0, rejectedSkus: [] };

    const state = feedStatus.status.toUpperCase();
    const terminal = state === "DONE" || state === "COMPLETED" || state === "ERROR" || state === "FAILED";
    if (!terminal) {
      return { status: listing.status, error: null, liveCount: 0, totalCount: feedStatus.total, rejectedSkus: [] };
    }

    const details      = productDetails ?? [];
    const rejected     = details.filter((p) => p.qcStatus === "rejected" || (!p.productSid && p.errors.length > 0));
    const rejectedSkus = rejected.map((p) => p.sellerSku).filter(Boolean);
    const totalCount   = feedStatus.total || details.length;
    const failedCount  = feedStatus.failed || rejectedSkus.length;
    const liveCount    = Math.max(0, totalCount - failedCount);

    // A feed where SOME products succeeded leaves the listing genuinely
    // live and sellable on Jumia — marking the whole thing "failed"
    // (which every copy of this logic used to do) contradicts what the
    // seller sees in Vendor Center and hides the variants that DID work.
    // Only a feed where nothing got through is a failure.
    const newStatus = failedCount === 0
      ? "live"
      : liveCount > 0 ? "live" : "failed";

    const reasons = allErrorTexts(rejected, feedStatus.errors);
    const reason = reasons.length ? reasons.join(" | ") : null;
    const errorMsg = failedCount === 0
      ? null
      : liveCount > 0
        ? `${liveCount} of ${totalCount} variants went live. Jumia rejected ${rejectedSkus.length ? rejectedSkus.join(", ") : `${failedCount} variant(s)`}${reason ? `: ${reason}` : "."}`.slice(0, MAX_STORED_ERROR)
        : (reason ?? "Jumia rejected every product in this feed").slice(0, MAX_STORED_ERROR);

    if (newStatus === listing.status && !isPending) {
      return { status: listing.status, error: errorMsg, liveCount, totalCount, rejectedSkus };
    }

    const updates: Record<string, unknown> = {
      status:      newStatus,
      jumia_error: errorMsg,
      updated_at:  new Date().toISOString(),
    };
    // This is the genuine resolution the "Fix & resubmit" loop-cap is
    // waiting for — see the comment in the success branch above. Only clear
    // it once Jumia has actually confirmed something live, not merely
    // queued; a feed that comes back "failed" leaves the bookkeeping in
    // place so a repeat of the same rejection is still recognised as one.
    if (newStatus === "live") {
      updates.jumia_rerun_fingerprint = null;
      updates.jumia_rerun_count       = 0;
    } else {
      // Rejected outright: release the credits held for it. A later
      // Fix & resubmit holds them again.
      updates.credits_due = null;
    }
    // Take the sid/qc off a product that actually succeeded — details[0]
    // may well be the rejected one, which carries no usable sid.
    const succeeded = details.find((p) => p.productSid);
    if (succeeded?.productSid) updates.jumia_product_sid = succeeded.productSid;
    // An approval is left for lib/jumia/qc-followup.ts to confirm minutes
    // later, so the seller gets its "🎉 passed Jumia QC" message.
    if (succeeded?.qcStatus && succeeded.qcStatus.toLowerCase() !== "approved") {
      updates.jumia_qc_status = succeeded.qcStatus;
    }

    const db = createServerClient();
    const { data: updatedRows } = await db
      .from("listings")
      .update(updates)
      .eq("id", listing.id)
      .select("category_code, jumia_payload_fingerprint");
    const updatedRow = (updatedRows as { category_code?: string | null; jumia_payload_fingerprint?: string | null }[] | null)?.[0];

    // One outcome row per product Jumia actually itemised, so a feed with
    // a partial rejection logs the SKU that failed rather than the whole
    // listing — falls back to one listing-level row when Jumia gave no
    // per-item detail at all. No per-listing "country" here (this function
    // never has the seller's credentials in scope, only the feed's own
    // response) — left null rather than threading it through every caller.
    const outcomeItems = details.length > 0
      ? details.map((p) => ({
          sellerSku: p.sellerSku,
          outcome:   (rejected.includes(p) ? "rejected" : "live") as FeedOutcomeKind,
          rawError:  rejected.includes(p) ? (p.errors.find((e) => e.trim()) ?? reason ?? null) : null,
        }))
      : [{ sellerSku: null, outcome: (newStatus === "live" ? "live" : "rejected") as FeedOutcomeKind, rawError: errorMsg }];

    // Pay when live: charge what was held at submission. Only on the
    // pending → live transition, so re-checking a live listing never
    // charges again (and the ledger's live:<id> reference guards it too).
    if (isPending && newStatus === "live") await chargeLiveListing(listing.id);

    await Promise.all(outcomeItems.map((item) => logFeedOutcome({
      listingId:          listing.id,
      feedId:             listing.jumia_ref,
      sellerSku:          item.sellerSku,
      categoryCode:       updatedRow?.category_code ?? null,
      outcome:            item.outcome,
      rawError:           item.rawError,
      payloadFingerprint: updatedRow?.jumia_payload_fingerprint ?? null,
    })));

    // Only the pending → resolved transition is news. Re-checking an
    // already-resolved listing (what /api/jumia/diagnose does) must not
    // message the seller again. skipNotify is the OTHER way a caller opts
    // out of this — the per-minute cron (app/api/cron/jumia-feeds) sets it
    // so it can batch every resolution from one whatsapp_batch_id into a
    // single message instead of one per listing (see notifyBatchResolved).
    if (isPending && !opts.skipNotify) {
      await notifyListingResolved(listing.id, newStatus, errorMsg, { liveCount, totalCount, rejectedSkus });
    }
    return { status: newStatus, error: errorMsg, liveCount, totalCount, rejectedSkus };
  } catch (e) {
    console.warn(`[push-listing] refreshPendingFeedStatus failed for ${listing.id}: ${(e as Error).message}`);
    return { status: listing.status, error: null, liveCount: 0, totalCount: 0, rejectedSkus: [] };
  }
}
