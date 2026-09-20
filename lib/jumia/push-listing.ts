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
import type { ListingRow, ListingStatus, VariantRow } from "@/lib/supabase/types";

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
      /** Everything validateListingForPush would reject on first. */
      blockers: string[];
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
    blockers,
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
    await db
      .from("listings")
      .update({
        status:                    "pending_approval",
        jumia_ref:                 result.jumia_ref,
        jumia_error:               null,
        jumia_synced_at:           new Date().toISOString(),
        // Clear the auto-fix loop-cap bookkeeping — a successful push means
        // whatever the last rejection was is resolved, so the next one (if
        // any) is a fresh problem, not a repeat. See rejectionFingerprint.
        jumia_rerun_fingerprint:   null,
        jumia_rerun_count:         0,
        // Carried forward so refreshPendingFeedStatus can log this feed's
        // eventual per-SKU outcome against the content that produced it.
        jumia_payload_fingerprint: payloadFingerprint,
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
    .update({ status: "failed", jumia_error: result.error ?? "Unknown error from Jumia", updated_at: new Date().toISOString() })
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

/** First human-readable reason we can find, preferring the per-product
 *  errors (which name the actual variant's problem) over the feed-level
 *  ones. Jumia sometimes hands back objects rather than strings. */
function firstErrorText(rejected: FeedProductInfo[], feedErrors: unknown[]): string | null {
  for (const item of rejected) {
    const first = item.errors.find((e) => typeof e === "string" && e.trim());
    if (first) return first;
  }
  for (const e of feedErrors) {
    if (typeof e === "string" && e.trim()) return e;
    if (e && typeof e === "object") return JSON.stringify(e);
  }
  return null;
}

/**
 * Tell a WhatsApp seller their listing resolved. Only fires for listings
 * that came from the chat flow — a web-app listing's seller watches the
 * app instead.
 *
 * Says what actually happened, including the partial case: a feed where
 * four variants went live and one was rejected used to be reported to the
 * seller (when it was reported at all) as a flat failure, which
 * contradicted the four live products sitting in their Vendor Center.
 *
 * Best-effort throughout: a failed lookup or send must never turn a
 * successful status refresh into an error for the caller.
 */
async function notifyListingResolved(
  listingId: string,
  newStatus: string,
  errorMsg: string | null,
  counts: { liveCount: number; totalCount: number; rejectedSkus: string[] } = {
    liveCount: 0, totalCount: 0, rejectedSkus: [],
  },
): Promise<void> {
  try {
    const db = createServerClient();
    const { data: row } = await db
      .from("listings")
      .select("user_id, title, whatsapp_batch_id")
      .eq("id", listingId)
      .maybeSingle();

    if (!row?.whatsapp_batch_id) return;

    const { getWhatsAppConnection } = await import("@/lib/whatsapp/link");
    const { sendTextIfConfigured, sendButtonsIfConfigured } = await import("@/lib/whatsapp/client");

    const wa = await getWhatsAppConnection(row.user_id as string);
    if (!wa.connected || !wa.phoneNumber) return;

    const name = (row.title as string | null) ?? "Your product";
    const partial = newStatus === "live" && counts.totalCount > counts.liveCount && counts.liveCount > 0;

    const text = newStatus !== "live"
      ? `⚠️ "${name}" was rejected by Jumia: ${errorMsg ?? "see the app for details"}`
      : partial
        ? `✅ "${name}" is live on Jumia — ${counts.liveCount} of ${counts.totalCount} variants went through.\n\n⚠️ Jumia rejected ${counts.rejectedSkus.length ? counts.rejectedSkus.join(", ") : "the rest"}. You can fix and resubmit just those from your listings.`
        : `🎉 "${name}" is now live on Jumia!`;

    // A rejection gets a way out of it. Without this the message is a dead
    // end: Jumia's own wording ("The column [product_weight] is missing
    // from the file"), and nothing the seller can act on from the chat.
    // The button id carries the listing id because a rejection lands
    // whenever Jumia finishes processing — often long after the batch
    // closed and the session moved on — so it cannot rely on chat state.
    if (newStatus !== "live") {
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

export async function refreshPendingFeedStatus(
  accessToken: string,
  listing: { id: string; status: string; jumia_ref: string | null },
  opts: { allowNonPending?: boolean } = {},
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

    const reason = firstErrorText(rejected, feedStatus.errors);
    const errorMsg = failedCount === 0
      ? null
      : liveCount > 0
        ? `${liveCount} of ${totalCount} variants went live. Jumia rejected ${rejectedSkus.length ? rejectedSkus.join(", ") : `${failedCount} variant(s)`}${reason ? `: ${reason}` : "."}`.slice(0, 500)
        : (reason ?? "Jumia rejected every product in this feed").slice(0, 500);

    if (newStatus === listing.status && !isPending) {
      return { status: listing.status, error: errorMsg, liveCount, totalCount, rejectedSkus };
    }

    const updates: Record<string, unknown> = {
      status:      newStatus,
      jumia_error: errorMsg,
      updated_at:  new Date().toISOString(),
    };
    // Take the sid/qc off a product that actually succeeded — details[0]
    // may well be the rejected one, which carries no usable sid.
    const succeeded = details.find((p) => p.productSid);
    if (succeeded?.productSid) updates.jumia_product_sid = succeeded.productSid;
    if (succeeded?.qcStatus)   updates.jumia_qc_status   = succeeded.qcStatus;

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
    // message the seller again.
    if (isPending) {
      await notifyListingResolved(listing.id, newStatus, errorMsg, { liveCount, totalCount, rejectedSkus });
    }
    return { status: newStatus, error: errorMsg, liveCount, totalCount, rejectedSkus };
  } catch (e) {
    console.warn(`[push-listing] refreshPendingFeedStatus failed for ${listing.id}: ${(e as Error).message}`);
    return { status: listing.status, error: null, liveCount: 0, totalCount: 0, rejectedSkus: [] };
  }
}
