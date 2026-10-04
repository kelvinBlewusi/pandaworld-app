import { createServerClient } from "@/lib/supabase/server";
import { sendTextIfConfigured, sendCtaUrlIfConfigured, sendButtonsIfConfigured, sendListIfConfigured, sendImageIfConfigured, LIST_MAX_ROWS } from "@/lib/whatsapp/client";
import { INTERACTIVE_BODY_MAX, splitForText } from "@/lib/whatsapp/text-limits";
import { VARIATION_FIELD, isVariationBlock, variationOptions, variationMayBlock, variationQuestion, parseVariations, saveVariations } from "@/lib/whatsapp/variation-question";
import { ingestWhatsAppImage } from "@/lib/whatsapp/media";
import {
  getOrCreateSession,
  updateSession,
  resetSession,
  claimMessageId,
  type QcQuestion,
  type ValueQuestion,
  type WhatsAppSession,
} from "@/lib/whatsapp/session";
import { createListingForUser } from "@/lib/listings/create";
import { isAdmin } from "@/lib/auth/is-admin";
import { runAutoAnalyze } from "@/lib/actions/auto-analyze";
import { availableCredits } from "@/lib/billing/extension-credits";
import { LIVE_LISTING_CREDIT_COST } from "@/lib/billing/credit-packs";
import { pushListingToJumia, missingFieldLabels, refreshPendingFeedStatus } from "@/lib/jumia/push-listing";
import { assessListingPushReadiness, type ListingReadinessResult } from "@/lib/whatsapp/readiness";
import { autoFillMissingFields, missingValueQuestion, parseMissingValue, saveMissingValue } from "@/lib/whatsapp/missing-value";
import { columnFor, readAttributeValue } from "@/lib/jumia/attribute-mapping";
import { refillAttributesForCategory } from "@/lib/jumia/refill-attributes";
import { classifyJumiaRejection, isAutoFixable, extractRejectionText, rejectionFingerprint, shouldBlockRepeatedAutoFix, extractNotVisibleAttributeNames, isStaleCategoryError, type Remedy } from "@/lib/jumia/rejection-remedy";
import { decideQcAction, type QcContext } from "@/lib/jumia/qc-remedy";
import { featureMinPackName, hasFeature } from "@/lib/billing/features";
import { removeAttributesFromCache, getCategoryByCode, getCategoryAttributes, type JumiaCategoryAttribute } from "@/lib/jumia/categories";
import { isUnlistableCategoryError, sellerCountry } from "@/lib/jumia/unlistable-categories";
import { provenCategoriesFor } from "@/lib/jumia/live-listings";
import {
  listableLeafCategories,
  refusedCategoryCodes,
  suggestCategories,
  matchCategoryAnswer,
  looksLikeCategoryAnswer,
  categoryListRow,
  CATEGORY_SKIP_RE,
  findOnJumiaTip,
  jumiaStorefront,
  parseCategoryInstruction,
  type CategoryChoice,
} from "@/lib/whatsapp/category-question";
import { getValidJumiaCredentials, COUNTRY_CURRENCY, DEFAULT_JUMIA_COUNTRY, currencySymbol, currencyNameWord } from "@/lib/jumia/api";
import { checkRestrictedBrand } from "@/lib/jumia/prohibited-catalog";
import { isFashionCategory } from "@/lib/jumia/fashion-category";
import { getJumiaConnectionKind, testJumiaCredentials, saveJumiaCredentialsForUser, disconnectJumiaForUser } from "@/lib/jumia/credentials";
import { connectSelfAuthorization, looksLikeClientId } from "@/lib/jumia/self-auth";
import { createConnectToken } from "@/lib/jumia/connect-token";
import { parseGlobalCommand, type GlobalCommand } from "@/lib/whatsapp/commands";
import { extractVariantClaim } from "@/lib/whatsapp/variant-claims";
import {
  guideHowToListMessage,
  guideControlsMessage,
  helpMessage,
  unsupportedMediaMessage,
} from "@/lib/whatsapp/onboarding";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { endsWithDoneSignal, stripDoneSignal } from "@/lib/whatsapp/draft";
import {
  parseProductCount,
  readProductCount,
  parseSubmitCommand,
  parseEditCommand,
  extractPrice,
  extractStock,
  extractSalePrice,
  whatsappListingsUrl,
  quietModeExampleUrl,
  focusedEditorUrl,
  buyCreditsUrl,
  COUNT_QUICK_PICKS,
  MAX_BATCH_SIZE,
  ADMIN_MAX_BATCH_SIZE,
} from "@/lib/whatsapp/batch";
import {
  splitCredentialTokens, identifyCredentials, looksLikeCredential, isResendCommand, jumiaConnectLink, promptJumiaConnection, countryFromPhone,
  promptReconnectKeepingBatch, resumeBatchAfterReconnect, RECONNECT_JUMIA_BUTTON,
} from "@/lib/whatsapp/jumia-connect";
import { classifyBatchIntent, looksActionable } from "@/lib/whatsapp/intent";
import type { ListingRow } from "@/lib/supabase/types";
import { enqueueAnalysisJobs, nudgeWorker, workersFor, isBatchSettled, type AnalysisJob } from "@/lib/whatsapp/analysis-queue";
import { restrictedWordsInJumiaRejection } from "@/lib/ai/restricted-words";
import { rememberRestrictedWords } from "@/lib/jumia/learned-restricted-words";

/**
 * WhatsApp chatbot, Stage 4: multi-product batches, entirely in chat.
 *
 * Flow: link -> "how many products?" (awaiting_count) -> for each product,
 * photos + notes then "done" (awaiting_photos, batch-scoped, no AI calls
 * yet) -> once the LAST product's "done" arrives, every product in the
 * batch is analyzed together (concurrently, with only a low-confidence-
 * category prompt sent live per product — everything else about how each
 * one drafted is reported once, in finalizeBatch's own summary, once the
 * whole batch settles) -> one consolidated review link
 * (awaiting_confirmation) -> "submit" / "submit 2 4" / "2: change the
 * price to 150" (or free-form phrasing the AI fallback in
 * lib/whatsapp/intent.ts interprets) all handled right here, no app visit
 * required unless the seller wants the fuller editor or needs to set a
 * price/stock the chat text didn't state explicitly.
 */

const MAX_LISTING_IMAGES = 8;

// Batch analysis no longer needs a deadline guard. It used to run every
// product's AI analysis inline here, racing this route's hard 60s
// maxDuration (Vercel kills the function outright — no catch block runs,
// no reply goes out, and the seller was left wedged in "analyzing"
// forever). ANALYSIS_DEADLINE_MS existed to always beat that kill, at the
// cost of telling sellers "still finishing" about products that had
// produced nothing. startBatchAnalysis now only reserves and enqueues, so
// it returns in well under a second whatever the batch size, and the work
// happens in app/api/worker/analyze-jobs. The ceiling still applies to the
// WORKER, which is why that route claims a bounded number of jobs per tick
// rather than draining the queue.

// The same hard-ceiling risk does still apply to
// handleSubmit's concurrent pushListingToJumia() fan-out — a "submit all"
// on a large batch, or a slow Jumia API, can run long. Unlike
// startBatchAnalysis, handleSubmit had NO per-listing try/catch at all
// before this: a single push throwing used to reject the whole
// Promise.all with no reply ever sent and the session stuck in
// awaiting_confirmation — worse than the analyzing-state bug since there
// wasn't even a "still working" message.
const SUBMIT_DEADLINE_MS = 45_000;

// Batch size at or above which the "drafting them now" message adds "This
// is a bigger batch, so it may take a little while." 10, so it's said for
// 10 or more products (a seller's most; an admin's is 20) and not for a handful, which the
// queue drafts in about the time a single product takes. Was 3 while the
// cap was 5.
const BIG_BATCH_SIZE = 10;

// Session states in which a typed reply can be an answer to
// askSellerForCategory's question — see handleLinkedMessage.
const CATEGORY_ANSWER_STATES = new Set<WhatsAppSession["state"]>(["awaiting_count", "awaiting_confirmation", "error"]);

function replyText(to: string, text: string): Promise<void> {
  return sendTextIfConfigured(to, text);
}

// replyButtons/replyCta always keep the same body text a plain-text send
// would have used, spelling out the exact phrase to type — a button is
// additive convenience, never a requirement, so a WhatsApp client that
// can't render interactive messages loses no functionality.
function replyButtons(to: string, bodyText: string, buttons: { id: string; title: string }[]): Promise<void> {
  return sendButtonsIfConfigured(to, bodyText, buttons);
}

function replyCta(to: string, bodyText: string, buttonText: string, url: string): Promise<void> {
  return sendCtaUrlIfConfigured(to, bodyText, buttonText, url);
}

// Over Meta's caps (lib/whatsapp/text-limits.ts) a send fails outright, so
// long text goes as plain text plus a short interactive message.

/** Plain text, split at line breaks into as many messages as it needs. */
async function replyLongText(to: string, text: string): Promise<void> {
  for (const part of splitForText(text)) await replyText(to, part);
}

/**
 * The body an interactive message can carry: `text` itself when it fits,
 * otherwise `text` goes first as plain text and the message gets `short`.
 */
async function fitInteractiveBody(to: string, text: string, short: string): Promise<string> {
  if (text.length <= INTERACTIVE_BODY_MAX) return text;
  await replyLongText(to, text);
  return short;
}

/** A link button carrying the whole text, or plain text then the button when it's too long. */
async function replyCtaOrSplit(to: string, bodyText: string, buttonText: string, url: string): Promise<void> {
  if (bodyText.length <= INTERACTIVE_BODY_MAX) {
    await replyCta(to, bodyText, buttonText, url);
    return;
  }
  await replyLongText(to, bodyText);
  await replyCta(to, "Tap below:", buttonText, url);
}

/** Up to 10 tappable rows in one message, where replyButtons holds three.
 *  Same contract: the row id IS the command phrase, so a tapped row and a
 *  typed phrase reach the identical parser. */
function replyList(
  to:         string,
  bodyText:   string,
  buttonText: string,
  rows:       { id: string; title: string; description?: string }[],
): Promise<void> {
  return sendListIfConfigured(to, bodyText, buttonText, rows);
}

/**
 * The single way this file reports a failure to a seller.
 *
 * Every error message carries the same two buttons, because after
 * something goes wrong those are the only two things anyone ever wants:
 *
 *   Retry   — run the failed step again on the SAME batch, reusing photos
 *             that are already uploaded. Nothing is re-sent, nothing is
 *             re-typed. Optionally scoped to one product via retryId.
 *   Restart — abandon this batch and start a new one from scratch.
 *
 * Before this, an error was a dead end: the text named a phrase to type
 * (and sometimes not even that), so the only recovery a seller could
 * reliably find was re-sending every photo. Routing errors through one
 * helper is what makes "all error messages have both" true by
 * construction rather than by remembering to add them each time.
 *
 * cta_url and reply-buttons can't share one WhatsApp message, so a link
 * that's genuinely useful alongside the error (the review page, the
 * focused editor) goes out first and the buttons follow — the same
 * two-message shape sendStatusReply already uses.
 */
async function replyError(
  to:   string,
  text: string,
  opts: { retryId?: string; retryTitle?: string; cta?: { label: string; url: string } } = {},
): Promise<void> {
  const buttons = [
    { id: opts.retryId ?? "retry", title: (opts.retryTitle ?? "Retry 🔁").slice(0, 20) },
    { id: "restart", title: "Restart 🔄" },
  ];
  if (opts.cta) {
    await replyCta(to, text, opts.cta.label, opts.cta.url);
    await replyButtons(to, "Or pick one of these:", buttons);
    return;
  }
  await replyButtons(to, text, buttons);
}

/**
 * The button under a product that's gone to Jumia, and under a drafted
 * product, where Restart used to be (owner's request, 2026-10-03): the
 * seller is done with these, not starting over. Same as *restart*, with a
 * friendlier hello (handleGlobalCommand).
 */
const START_ANOTHER = { id: "start another", title: "Start another ➕" };

async function getBatchListings(batchId: string): Promise<ListingRow[]> {
  const db = createServerClient();
  const { data, error } = await db
    .from("listings")
    .select("*")
    .eq("whatsapp_batch_id", batchId)
    .order("whatsapp_seq", { ascending: true });
  // A query error used to be silently swallowed into an empty array here —
  // every caller then reported a confusing "I don't see that product in
  // this batch" even right after that same batch was successfully
  // drafted, because there was no way to tell "batch genuinely has
  // nothing" apart from "the query itself failed". Logging it at least
  // makes a real recurrence diagnosable; callers below also now treat an
  // empty batch as suspect rather than as ordinary "not found".
  if (error) {
    console.error(`[whatsapp intake] getBatchListings failed for batch ${batchId}: ${error.message}`);
  }
  return (data ?? []) as ListingRow[];
}

/** Short "still needs: price, category" summary for a listing, or "" when
 *  it's ready to push — uses the exact same checks pushListingToJumia
 *  itself enforces (lib/jumia/push-listing.ts's missingFieldLabels), so
 *  what the seller sees here can never drift from what a real push
 *  would actually reject. */
async function describeMissingFields(listingId: string): Promise<string> {
  const labels = await missingFieldsFor(listingId);
  return labels.length > 0 ? `Still needs: ${labels.join(", ")}.` : "";
}

/** The raw missing-field labels, for callers that want to phrase the
 *  warning themselves — "Product 2 still needs a price" reads better than
 *  a pre-built sentence pasted after a product number. */
async function missingFieldsFor(listingId: string): Promise<string[]> {
  const db = createServerClient();
  const { data } = await db
    .from("listings")
    .select("title, description, selling_price, category_code, brand, images")
    .eq("id", listingId)
    .maybeSingle();
  if (!data) return [];
  return missingFieldLabels(data as ListingRow);
}

/**
 * Things the seller asked for in their note that the draft could NOT
 * honour, phrased for them.
 *
 * Re-derived from the stored note rather than persisted at draft time:
 * extractSalePrice is pure, user_prompt is already saved, and a column
 * for a transient message would be state to keep in sync for no gain.
 *
 * Exists because silence was the worst possible answer here. A seller who
 * writes "Start and end date is 30th September 2026 to 31 December 2025"
 * has stated a promo window and expects to see one; the range is
 * backwards, so we refuse it — correctly — but saying nothing looks
 * identical to the system never having read the line at all.
 */
interface NoteWarnings {
  /** Block regardless of whether Jumia's own dry-run says the push would
   *  succeed — a stated claim that silently lost every option, or a stale
   *  sale-date, are real data problems no amount of push-acceptability
   *  excuses. */
  warnings: string[];
  /** Block ONLY when the push would not otherwise succeed. The wording
   *  doesn't literally match what the seller typed, but that is a
   *  correctness worry, not a submittability one — once Jumia's own
   *  dry-run already confirms the drafted values are fine, second-
   *  guessing the wording on top is a false Hold (2026-09-23 seller
   *  decision: a listing Jumia would accept must not sit behind an
   *  editor-only warning it doesn't need). Still surfaced as context when
   *  the listing is Held for some other reason anyway. */
  softWarnings: string[];
}

async function noteWarningsFor(listingId: string): Promise<NoteWarnings> {
  const db = createServerClient();
  const { data } = await db
    .from("listings")
    .select("user_prompt")
    .eq("id", listingId)
    .maybeSingle();
  const note = (data?.user_prompt as string | null) ?? "";
  if (!note) return { warnings: [], softWarnings: [] };

  const warnings: string[] = [];
  const softWarnings: string[] = [];
  const sale = extractSalePrice(note);
  if (sale?.dateWarning) warnings.push(sale.dateWarning);

  // A variant claim the draft could not resolve. Read off the variants
  // table rather than a stored flag: auto-analyze has already dropped
  // every proposed option in that case, so "the seller restricted the
  // options AND there are none" is the condition itself.
  const claim = extractVariantClaim(note);
  if (claim) {
    const { data: variantRows } = await db
      .from("variants")
      .select("variation")
      .eq("listing_id", listingId);
    const labels = (variantRows ?? [])
      .map((v: { variation?: string | null }) => String(v.variation ?? "").trim())
      .filter(Boolean);

    if (labels.length === 0) {
      warnings.push(
        `you wrote "${claim.source}" — I couldn't tell which options that leaves, so none were added. ` +
        `Tap Edit to set the ones you actually stock`,
      );
    } else {
      // A token matches when it IS a drafted label (case-insensitive), or
      // is one of that label's own whitespace/hyphen-delimited words —
      // "40" against a drafted "EU 40" (real incident: sandals, parentSku
      // PA-MUDIF5R5, seller wrote "Sizes 40 41 42 43", the category's own
      // schema names numeric sizes "EU 40"/"EU 41"/... — that listing would
      // have been accepted by Jumia as submitted, but Held anyway asking
      // the seller to open Edit for nothing to fix). Whole-word only, never
      // substring or synonym: "xtra"/"large" are never the whole word "xl".
      // A leftover mismatch after this (like the 2026-09-22 tee canary,
      // variants M/L/XL against a caption that said Xtra Large) is now a
      // SOFT warning rather than an automatic Hold — see NoteWarnings'
      // doc comment: once the push itself is confirmed acceptable, the
      // seller is trusted over a wording quibble. Same rule
      // reconcileVariants already uses at draft time
      // (lib/whatsapp/variant-claims.ts) — this just applies it to the
      // post-hoc check against what actually got persisted.
      const byLower = new Map(labels.map((l) => [l.toLowerCase(), l]));
      const unmatched = claim.tokens.filter((t) => {
        const tl = t.toLowerCase();
        if (byLower.has(tl)) return false;
        return !labels.some((l) => l.toLowerCase().split(/[\s-]+/).includes(tl));
      });
      if (unmatched.length > 0) {
        softWarnings.push(
          `you wrote "${claim.source}" — I drafted ${labels.join(", ")}, but that doesn't match what you typed exactly. ` +
          `Open Edit to confirm the sizes/options you actually stock`,
        );
      }
    }
  }

  return { warnings, softWarnings };
}

/** The seller's shop currency ISO code ("GHS", "NGN", ...) for a user
 *  already in hand — best-effort, defaults to GHS on any lookup failure so
 *  a currency-copy hiccup never blocks price parsing itself. PandaWorld
 *  lists Jumia sellers across Africa, not just Ghana — extractPrice/
 *  extractSalePrice (lib/whatsapp/batch.ts) used to always assume GHS
 *  regardless of the seller's actual shop. */
async function shopCurrencyForUser(userId: string): Promise<string> {
  try {
    const db = createServerClient();
    const { data } = await db
      .from("jumia_connections")
      .select("country")
      .eq("user_id", userId)
      .maybeSingle();
    return COUNTRY_CURRENCY[(data?.country as string | null) ?? DEFAULT_JUMIA_COUNTRY] ?? "GHS";
  } catch {
    return "GHS";
  }
}

/**
 * A price as the chat shows it: in the seller's own currency ("GH₵150",
 * "₦2,000", "KSh 500") when their shop's country is known, and the bare
 * number when it isn't, never another country's currency (owner's request,
 * 2026-10-03: "GHS 150"). shopCurrencyForUser's GHS fallback is right for
 * reading a price, not for showing one.
 */
async function chatPrice(userId: string, amount: number): Promise<string> {
  const country = await sellerCountry(userId).catch(() => null);
  const code = country ? COUNTRY_CURRENCY[country] : undefined;
  const shown = amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (!code) return shown;
  const symbol = currencySymbol(code);
  return /[A-Za-z]$/.test(symbol) ? `${symbol} ${shown}` : `${symbol}${shown}`;
}

/** Same as shopCurrencyForUser, for a call site that only has the listing
 *  id handy (applyNotes runs on every batch photo message and doesn't
 *  otherwise need the seller's userId). */
async function shopCurrencyForListing(listingId: string): Promise<string> {
  try {
    const db = createServerClient();
    const { data: listing } = await db.from("listings").select("user_id").eq("id", listingId).maybeSingle();
    if (!listing?.user_id) return "GHS";
    return shopCurrencyForUser(listing.user_id as string);
  } catch {
    return "GHS";
  }
}

/** Saves a seller's free-text note against a product, plus a deterministic
 *  (non-AI) pass for an explicit price/stock — see batch.ts for why this
 *  is regex, not an AI guess: those two fields are seller-owned everywhere
 *  else in this codebase and stay that way here. */
async function applyNotes(listingId: string, text: string): Promise<void> {
  if (!text) return;
  const db = createServerClient();
  const currency = await shopCurrencyForListing(listingId);
  // APPEND, never replace. applyNotes used to overwrite user_prompt, so a
  // later Mode I marker adjacent text, a short follow-up, or a second
  // caption wipe could erase "Sizes Medium Large Xtra Large" before
  // finalizeBatch's soft-snap Hold ran — staging 03:08 canary: tee preview
  // had 3 size products but WhatsApp still ✅ Ready because freeText no
  // longer contained the seller's size claim. Doc comments above this
  // helper already said append; the write must match.
  const { data: existingRow } = await db
    .from("listings")
    .select("user_prompt")
    .eq("id", listingId)
    .maybeSingle();
  const existing = String((existingRow?.user_prompt as string | null) ?? "").trim();
  const incoming = text.trim();
  let merged = incoming;
  if (existing) {
    // Dedup exact repeats (album retries / Meta redeliveries).
    if (existing === incoming || existing.endsWith(incoming) || existing.includes(incoming)) {
      merged = existing;
    } else {
      merged = `${existing}\n${incoming}`;
    }
  }
  const updates: Record<string, unknown> = { user_prompt: merged.slice(0, 1000), updated_at: new Date().toISOString() };
  const price = extractPrice(text, currency);
  const stock = extractStock(text);
  if (price != null) updates.selling_price = price;
  if (stock != null) updates.quantity = stock;
  // Listing-level, not variant-level — see migration
  // 2026-09-13_listing-sale-price.sql. mapListingToJumiaProducts falls
  // back to this for every variant that doesn't have its own sale price,
  // so stating it once here applies no matter the variant, exactly like
  // selling_price already does for global_price.
  //
  // Only persisted when BOTH dates come with it. Jumia requires all three
  // together ("The Global StartAt and EndAt are mandatory when Sale Price
  // is filled") — a price saved here without dates used to sit in the DB
  // looking set, and only surfaced as a problem much later when a push
  // silently dropped it. The seller's raw text survives in user_prompt
  // either way, so a price stated alone isn't lost — just not applied
  // until the dates come with it.
  const sale = extractSalePrice(text, new Date(), currency);
  if (sale != null && sale.startDate && sale.endDate) {
    updates.sale_price      = sale.salePrice;
    updates.sale_start_date = sale.startDate;
    updates.sale_end_date   = sale.endDate;
  }
  await db.from("listings").update(updates).eq("id", listingId);
}

/**
 * Entry point for every message from an already-linked number. Dispatches
 * on the seller's session state. `messageId`, when given (Meta's wamid),
 * guards against re-processing the same webhook delivery twice — Meta
 * retries aggressively if we don't ack fast enough, and re-running an
 * analyze or re-pushing to Jumia on a retry would be a real (and
 * confusing) cost.
 */
export async function handleLinkedMessage(
  userId: string,
  phoneNumber: string,
  messageId: string | undefined,
  content: { text?: string; imageMediaId?: string; unsupported?: string; platformError?: string },
): Promise<void> {
  const session = await getOrCreateSession(userId, phoneNumber);

  // Claimed ATOMICALLY, up front, before any slow work — not read-then-
  // written-back-at-the-end. handleFixAndResubmit (an AI rerun + a Jumia
  // push) routinely runs past WhatsApp's own webhook ack timeout, which is
  // exactly when Meta redelivers the same tap; a plain read/write-later
  // check let both deliveries see the same stale value and both run the
  // whole handler. See claim_message_id's own doc comment.
  if (messageId && !(await claimMessageId(phoneNumber, messageId))) {
    console.info(`[whatsapp intake] skipping duplicate/racing message ${messageId} for ${phoneNumber}`);
    return;
  }

  // Something the bot cannot read — say so rather than dropping it. This
  // used to fall through the whole state machine in silence, which is the
  // worst possible answer and lands hardest on a seller's first attempt.
  // State is deliberately left untouched: they can simply send a photo
  // next and carry on exactly where they were.
  if (content.unsupported) {
    console.info(
      `[whatsapp intake] unsupported message type "${content.unsupported}" from ${phoneNumber}` +
      (content.platformError ? ` — Meta says: ${content.platformError}` : ""),
    );
    // Meta's OWN "unsupported" container, arriving while the seller is
    // sending photos, is album plumbing rather than anything they chose
    // to send — see METAS_OWN_UNSUPPORTED_TYPE. Answering it with "send a
    // photo instead" while their photos are visibly landing in the next
    // message reads as the bot being broken. Confirmed live on
    // 2026-09-15: two of these mid-album, both scolding a seller whose
    // six photos all arrived fine.
    //
    // Narrow on purpose. Only Meta's container, and only in the two
    // states where photos are in flight — where the per-product "got it
    // (N photos)" confirmations already tell the seller exactly what
    // landed, so silence here costs them nothing. Everywhere else, and
    // for every real media type (video, voice note, document, sticker),
    // the seller still gets an answer.
    const midPhotoBurst =
      session.state === "awaiting_photos" || session.state === "analyzing";
    if (!(content.platformError && midPhotoBurst)) {
      await replyText(phoneNumber, unsupportedMediaMessage(content.unsupported));
    }
    return;
  }

  // Global commands (restart/cancel, disconnect, status, help) work in ANY
  // state — checked before the per-state dispatch, not folded into it, so
  // they always take effect immediately. This is also the seller's manual
  // escape hatch out of "analyzing" if startBatchAnalysis's own try/catch
  // below somehow doesn't cover a failure — see lib/whatsapp/commands.ts.
  // "Fix & resubmit" from a Jumia rejection — id is `fix:<listingId>`.
  // Handled globally, before the per-state dispatch, because a rejection
  // arrives whenever Jumia finishes processing: minutes or hours later,
  // by which time the batch has closed and the session has moved on or
  // reset entirely. Routing it through a state would make the button work
  // only if the seller happened to still be mid-batch.
  const fixMatch = content.text?.trim().match(/^fix:([0-9a-f-]{36})$/i);
  if (fixMatch) {
    await handleFixAndResubmit(userId, phoneNumber, fixMatch[1]);
    return;
  }

  // A category picked from askSellerForCategory's list — id is
  // `recat:<listingId>:<code>`. Global for the same reason as fix: above:
  // the question follows a Jumia rejection, whatever state the session is
  // in by then.
  const recatMatch = content.text?.trim().match(/^recat:([0-9a-f-]{36}):(\d+)$/i);
  if (recatMatch) {
    await applySellerCategory(userId, phoneNumber, recatMatch[1], parseInt(recatMatch[2], 10));
    return;
  }

  // A category tapped on the drafting-time "not sure of product N's
  // category" message — id is `category:<listingId>:<code>`. Global so it
  // works while the rest of the batch is still drafting: in "analyzing"
  // every message used to get "hang tight", taps included, and the message
  // usually lands before the batch is done.
  const draftCategoryTap = content.text?.trim().match(/^category:([0-9a-f-]{36}):(\d+)$/i);
  if (draftCategoryTap) {
    await handleCategoryCorrection(userId, phoneNumber, draftCategoryTap[1], parseInt(draftCategoryTap[2], 10));
    return;
  }

  const globalCmd = content.text ? parseGlobalCommand(content.text) : null;

  // A typed answer to askSellerForCategory's question. Only read between
  // batches: mid-product (collecting photos, drafting) the seller's text is
  // a note for that product, and while connecting Jumia it's a credential.
  // A photo means they've moved on. Anything that isn't an answer drops
  // the question and is handled normally below.
  if (!globalCmd && session.awaitingCategoryFor) {
    const text = content.text?.trim();
    if (content.imageMediaId) {
      await updateSession(phoneNumber, { awaitingCategoryFor: null });
    } else if (text && CATEGORY_ANSWER_STATES.has(session.state)) {
      if (await handleCategoryAnswer(userId, phoneNumber, session.awaitingCategoryFor, text)) return;
    }
  }

  // An answer to a quality-check question (fixQcRejection): an FDA number,
  // the brand, a price, new photos, or Vendor Center's reason. Between
  // batches only, like the category question.
  if (!globalCmd && session.awaitingQcAnswer) {
    if (await handleQcAnswer(userId, phoneNumber, session, content)) return;
  }

  // A typed category for a draft the bot wasn't sure of, while the batch is
  // drafting or waiting to be submitted.
  if (!globalCmd && content.text && (session.state === "analyzing" || session.state === "awaiting_confirmation")) {
    if (await handleDraftCategoryAnswer(userId, phoneNumber, session, content.text)) return;
  }

  if (globalCmd) {
    await handleGlobalCommand(globalCmd, userId, phoneNumber, session);
  } else {
    switch (session.state) {
      case "awaiting_jumia_credentials":
        await handleAwaitingJumiaCredentials(userId, phoneNumber, session, content);
        break;
      case "awaiting_jumia_oauth":
        await handleAwaitingJumiaOauth(userId, phoneNumber, content);
        break;
      case "awaiting_count":
        await handleAwaitingCount(userId, phoneNumber, session, content);
        break;
      case "awaiting_photos":
        await handleAwaitingPhotos(userId, phoneNumber, session, content);
        break;
      case "analyzing":
        await handleAnalyzingMessage(phoneNumber, session, content);
        break;
      case "awaiting_confirmation":
        await handleAwaitingBatchConfirmation(userId, phoneNumber, session, content);
        break;
      case "error":
        await resetSession(phoneNumber);
        await replyText(phoneNumber, "Let's start fresh — how many products are you listing today? Reply with a number.");
        break;
    }
  }
}

async function handleGlobalCommand(
  cmd: GlobalCommand,
  userId: string,
  phoneNumber: string,
  session: WhatsAppSession,
): Promise<void> {
  switch (cmd.type) {
    case "restart":
      await handleGlobalRestart(userId, phoneNumber);
      return;
    case "start_another": {
      // Tapped under a drafted product that hasn't gone yet: it stays on
      // the review page, which the seller should hear.
      const unsent = session.state === "awaiting_confirmation" && session.batchId
        ? (await getBatchListings(session.batchId)).filter((l) => l.status === "draft" || l.status === "failed").length
        : 0;
      const kept = unsent === 0 ? "" : unsent === 1 ? " Your unsent draft stays on the review page." : ` Your ${unsent} unsent drafts stay on the review page.`;
      await handleGlobalRestart(userId, phoneNumber, `Let's list more!${kept}`);
      return;
    }
    case "retry":
      await handleGlobalRetry(userId, phoneNumber, session, cmd.seq);
      return;
    case "how_it_works":
      await sendGuide(phoneNumber);
      return;
    case "status":
      await sendStatusReply(phoneNumber, await describeStatus(session));
      return;
    case "help":
      await replyButtons(phoneNumber, helpMessage(), [
        { id: "status", title: "Status" },
        { id: "restart", title: "Restart 🔄" },
        { id: "disconnect", title: "Disconnect" },
      ]);
      return;
    case "disconnect":
      await replyButtons(
        phoneNumber,
        "This disconnects your Jumia store from PandaWorld — you'll need to reconnect (new credentials or reauthorize) before listing again. Any drafts you've already made stay saved.\n\nReply *confirm disconnect* to proceed, or *keep jumia connected* to cancel.",
        [
          { id: "confirm disconnect", title: "Yes, disconnect" },
          { id: "keep jumia connected", title: "No, keep it" },
        ],
      );
      return;
    case "confirm_disconnect":
      await handleGlobalConfirmDisconnect(userId, phoneNumber);
      return;
    case "keep_connected":
      // Declining the disconnect must not leave the seller hanging on a
      // bare acknowledgment — confirmed live: nothing re-prompted them
      // with where they'd actually left off (mid-batch, waiting on
      // credentials, ...), so the chat just went quiet. Re-render
      // whatever describeStatus says about their CURRENT state right
      // after, the same reminder "status" itself would give.
      await replyText(phoneNumber, "👍 No changes made — Jumia stays connected.");
      await sendStatusReply(phoneNumber, await describeStatus(session));
      return;
    case "reconnect_jumia": {
      const kind = await getJumiaConnectionKind(userId);
      if (kind === "connected") {
        await replyText(phoneNumber, "✅ Jumia's already connected — you're good to go!");
        return;
      }
      // Tapped under drafts that can't go yet: keep them.
      if (session.batchId && (session.state === "awaiting_confirmation" || session.state === "awaiting_jumia_credentials")) {
        await promptReconnectKeepingBatch(userId, phoneNumber, kind);
        return;
      }
      await promptJumiaConnection(userId, phoneNumber, kind);
      return;
    }
  }
}

/**
 * "restart"/"cancel"/"start over" etc — the seller's universal way to
 * abandon whatever's in progress and begin a new batch. Re-checks the
 * Jumia connection exactly like handleAwaitingCount does, so a seller
 * who disconnected (or never finished connecting) mid-batch is routed
 * back into the connect flow instead of being asked "how many
 * products?" only to hit the same gate again on the very next message.
 */
/**
 * The end of a batch — every product submitted (finishSubmittedBatch).
 *
 * It carries Start another (owner's request, 2026-10-03). It once had a
 * "Create new listing" button, dropped so nobody started a new batch
 * before seeing how this one went. The resolution messages
 * (notifyBatchResolved/notifyListingResolved, lib/jumia/push-listing.ts)
 * arrive whatever the seller does next, so starting another loses nothing.
 */
const BATCH_DONE_TEXT =
  "🎉 That's the whole batch submitted! I'll message you here as each one goes live.\n\nTap *Start another* to list something else.";

/** The sign-off, after the per-product lines in the same message when there are any. */
async function sendBatchDoneMessage(phoneNumber: string, resultLines: string[] = []): Promise<void> {
  const body = await prefixedBody(phoneNumber, resultLines.join("\n") || undefined, BATCH_DONE_TEXT);
  await replyButtons(phoneNumber, body, [START_ANOTHER]);
}

/**
 * Every product of the batch has gone to Jumia: the chat waits for the next
 * count, remembering the batch so a stray reply ("Quantity 20") is told the
 * products are already with Jumia rather than read as a new count
 * (handleAwaitingCount).
 */
async function finishSubmittedBatch(phoneNumber: string, batchId: string): Promise<void> {
  await resetSession(phoneNumber);
  await updateSession(phoneNumber, { lastSubmittedBatchId: batchId });
}

/** `lead`: the hello before the count question ("Let's list more!" for Start another). */
async function handleGlobalRestart(userId: string, phoneNumber: string, lead = "No problem — let's start fresh."): Promise<void> {
  await resetSession(phoneNumber);
  const kind = await getJumiaConnectionKind(userId);
  if (kind !== "connected") {
    await promptJumiaConnection(userId, phoneNumber, kind, `${lead}\n\n`);
    return;
  }
  await replyButtons(phoneNumber, `${lead} How many products are you listing today?`, COUNT_QUICK_PICKS);
}

/**
 * "retry" — the counterpart to restart, and the whole point of the button
 * every error message now carries.
 *
 * Restart throws the batch away; retry keeps it and runs the failed step
 * again against the photos the seller already sent. Which step that is
 * depends on where they are, so this reads the session rather than making
 * the seller know: mid-connect it re-sends the connect link, mid-batch it
 * re-queues the products that never got drafted, and so on. That means a
 * single "retry" phrase (and a single button id) is correct from anywhere,
 * which is what lets replyError attach it unconditionally.
 *
 * An optional seq scopes it to one product — what the per-product failure
 * messages send, so tapping "Retry" under "Product 3 couldn't be drafted"
 * re-queues product 3 and nothing else.
 */
async function handleGlobalRetry(
  userId:      string,
  phoneNumber: string,
  session:     WhatsAppSession,
  seq:         number | null,
): Promise<void> {
  switch (session.state) {
    case "awaiting_jumia_credentials":
      await replyText(phoneNumber, "No problem — let's try those credentials again.");
      await promptJumiaConnection(userId, phoneNumber, "needs_credentials");
      return;

    case "awaiting_jumia_oauth":
      await sendJumiaConnectLink(userId, phoneNumber);
      return;

    case "awaiting_count":
      await replyButtons(
        phoneNumber,
        "Let's pick up where we left off — how many products are you listing today?",
        COUNT_QUICK_PICKS,
      );
      return;

    case "awaiting_photos":
      // Nothing has been drafted yet, so there is no failed step to run
      // again — the photos already sent are safely attached to this
      // product and stay that way.
      await replyText(
        phoneNumber,
        session.listingId
          ? `Your photos for product ${session.batchSeq ?? 1} are saved — send any more you want, then reply *done*.`
          : `Nothing to retry yet — send the photos for product ${session.batchSeq ?? 1} and I'll take it from there.`,
      );
      return;

    case "analyzing": {
      // Normally "retry" here would be a lie AND a double-billing risk:
      // the jobs are queued, the worker just hasn't reported back yet.
      //
      // But "analyzing" is also the state a batch gets WEDGED in — the
      // session only leaves it when a worker wins claimBatchFinalization,
      // so anything that kills the last worker mid-flight (a deploy, a
      // Vercel timeout) strands the seller here with every message
      // answered "still drafting". A settled queue with the session still
      // in "analyzing" is exactly that shape, and it's the one case where
      // re-queueing is both safe and the only thing that helps.
      if (session.batchId && await isBatchSettled(session.batchId)) {
        console.warn(`[whatsapp intake] batch ${session.batchId} was wedged in "analyzing" with an empty queue — retrying`);
        await retryBatchDrafts(userId, phoneNumber, session, seq);
        return;
      }
      await replyText(phoneNumber, "⏳ Already working on it — I'll message you the moment each product is drafted.");
      return;
    }

    case "awaiting_confirmation":
    case "error":
      await retryBatchDrafts(userId, phoneNumber, session, seq);
      return;
  }
}

/**
 * Re-queue the products in this batch that never came back with a draft,
 * reusing the images already uploaded for them — no photo is ever re-sent.
 *
 * Deliberately skips products that DID draft: re-analysing one costs a
 * Gemini call and a credit, and "retry" after a partial failure means
 * "finish the ones that failed", not "do everything again". A seller who
 * wants a drafted product changed has the editor link for that.
 */
async function retryBatchDrafts(
  userId:      string,
  phoneNumber: string,
  session:     WhatsAppSession,
  seq:         number | null,
): Promise<void> {
  const batchId = session.batchId;
  if (!batchId) {
    await replyButtons(
      phoneNumber,
      "There's no batch in progress to retry — want to start a new one?",
      [{ id: "restart", title: "Start listing 🆕" }],
    );
    return;
  }

  const listings = await getBatchListings(batchId);
  if (listings.length === 0) {
    await replyError(phoneNumber, "⚠️ I still can't load this batch — give it a moment and try again.");
    return;
  }

  const scoped = seq == null ? listings : listings.filter((l) => l.whatsapp_seq === seq);
  if (scoped.length === 0) {
    await replyError(
      phoneNumber,
      `I don't see product ${seq} in this batch.`,
      { cta: { label: "Review listings", url: whatsappListingsUrl(batchId) } },
    );
    return;
  }

  // A draft that produced a title is a draft that worked. Anything with no
  // images can't be analysed at all, so re-queueing it would just fail the
  // same way — those need photos, not a retry.
  const undrafted = scoped.filter((l) => !l.title && (l.images?.length ?? 0) > 0);
  const noImages  = scoped.filter((l) => !l.title && (l.images?.length ?? 0) === 0);

  if (undrafted.length === 0) {
    if (noImages.length > 0) {
      await replyButtons(
        phoneNumber,
        `⚠️ Product${noImages.length === 1 ? "" : "s"} ${noImages.map((l) => l.whatsapp_seq ?? "?").join(", ")} ${noImages.length === 1 ? "has" : "have"} no photos saved, so there's nothing to draft from. Starting over is the way to re-send them.`,
        [{ id: "restart", title: "Restart 🔄" }],
      );
      return;
    }
    // Reached from the wedged-"analyzing" path above when every product
    // actually drafted but finalizeBatch never ran, so move the session on
    // — otherwise the seller is told there is nothing to retry and still
    // can't submit, which is the worst of both.
    if (session.state === "analyzing") {
      await updateSession(phoneNumber, { state: "awaiting_confirmation" });
    }
    await replyButtons(
      phoneNumber,
      seq == null
        ? "Everything in this batch is already drafted — nothing to retry. Ready to submit."
        : `Product ${seq} is already drafted — nothing to retry.`,
      [
        { id: seq == null ? "submit all" : `submit ${seq}`, title: seq == null ? "Submit all ✅" : `Submit product ${seq}` },
        { id: "restart", title: "Restart 🔄" },
      ],
    );
    return;
  }

  // Exactly the gate the first attempt went through. Skipping it would
  // make Retry a way around both the hourly analyze limit and the credit
  // balance, since credits are only debited after a draft succeeds.
  const affordable = await reserveDraftCapacity(userId, phoneNumber, batchId, undrafted);
  if (affordable.length === 0) {
    // reserveDraftCapacity has already told them which products couldn't
    // be reserved and why, each with its own Retry button.
    return;
  }

  try {
    const queued = await enqueueAnalysisJobs({
      batchId,
      userId,
      phoneNumber,
      batchSize: session.batchSize ?? listings.length,
      listings:  affordable.map((l) => ({ listingId: l.id, seq: l.whatsapp_seq ?? null })),
    });

    if (queued === 0) {
      // Every one of them already has a job in flight — the first attempt
      // is still running, it just hasn't reported back yet.
      await replyText(phoneNumber, "⏳ Those are already queued — hang tight, I'll message you as each one finishes.");
      return;
    }

    // Back into "analyzing" so the worker's finalizeBatch can close the
    // batch out exactly once (claimBatchFinalization only fires on a
    // session sitting in this state).
    await updateSession(phoneNumber, { state: "analyzing" });
    await replyText(
      phoneNumber,
      `🔁 Retrying ${queued} product${queued === 1 ? "" : "s"} with the photos you already sent — no need to send anything again.`,
    );
    await nudgeWorker(workersFor(queued));
  } catch (e) {
    console.error(`[whatsapp intake] retry enqueue failed for batch ${batchId}: ${(e as Error).message}`);
    await replyError(
      phoneNumber,
      "⚠️ That didn't take either. Your photos are still saved — try once more in a moment, or open your listings and draft from there.",
      { cta: { label: "Review listings", url: whatsappListingsUrl(batchId) } },
    );
  }
}

async function handleGlobalConfirmDisconnect(userId: string, phoneNumber: string): Promise<void> {
  const result = await disconnectJumiaForUser(userId);
  if (!result.ok) {
    // retryId is scoped to the action that actually failed — a bare
    // "retry" would be read against the seller's batch state instead.
    await replyError(
      phoneNumber,
      `⚠️ Couldn't disconnect: ${result.error}. Try again in a moment.`,
      { retryId: "disconnect", retryTitle: "Try again 🔁" },
    );
    return;
  }
  await promptJumiaConnection(userId, phoneNumber, "needs_credentials", "✅ Jumia disconnected.\n\n");
}

/** Renders a describeStatus() result — a cta and/or buttons, both, or
 *  neither. cta_url and reply-buttons can't share one WhatsApp message, so
 *  when a state carries both this sends two messages back to back, same
 *  as every other dual cta+buttons moment in this file (e.g. the
 *  1-product "drafted" flow in startBatchAnalysis). Shared by the
 *  "status" command and anywhere else that needs to remind a seller where
 *  they left off (see "keep_connected" above). */
async function sendStatusReply(
  phoneNumber: string,
  status: { text: string; cta?: { label: string; url: string }; buttons?: { id: string; title: string }[] },
): Promise<void> {
  // A big batch's status runs one line per product, past what a button
  // message holds: the text then goes on its own.
  if (status.cta) {
    await replyCtaOrSplit(phoneNumber, status.text, status.cta.label, status.cta.url);
    if (status.buttons) await replyButtons(phoneNumber, "Quick actions:", status.buttons);
  } else if (status.buttons) {
    await replyButtons(phoneNumber, await fitInteractiveBody(phoneNumber, status.text, "Quick actions:"), status.buttons);
  } else {
    await replyLongText(phoneNumber, status.text);
  }
}

/**
 * Fallback while startBatchAnalysis's Promise.all is still running — the
 * seller can't submit/edit anything yet (nothing's drafted). A big batch
 * (10+, see startBatchAnalysis) can take a while; this used to offer a
 * "Tell me a joke" button to pass the time, which read as a distraction
 * from an unrelated joke bot rather than a listing tool mid-task — dropped
 * in favour of just saying plainly that it's still working.
 */
async function handleAnalyzingMessage(
  phoneNumber: string,
  _session: WhatsAppSession,
  _content: { text?: string },
): Promise<void> {
  await replyText(phoneNumber, "⏳ Still drafting your products — hang tight.");
}

/**
 * Send the full guide — two plain-text messages.
 *
 * Plain text, not interactive: WhatsApp caps an interactive body at ~1024
 * characters and the guide needs the room. Content lives in
 * lib/whatsapp/onboarding.ts alongside the welcome and the help reply, so
 * the three can never drift apart on what the bot actually does.
 */
async function sendGuide(phoneNumber: string): Promise<void> {
  await replyText(phoneNumber, guideHowToListMessage());
  await replyText(phoneNumber, guideControlsMessage());
}

// Matches components/ui/status-pill.tsx's exact label wording, so a
// seller sees the same words in chat as they would on the web dashboard.
const STATUS_LABELS: Record<ListingRow["status"], string> = {
  draft:             "Draft",
  awaiting_review:   "Awaiting review",
  processing:        "Processing",
  pending_approval:  "Pending",
  live:              "Live",
  failed:            "Failed",
};

/**
 * A status reply, plus an optional link button and/or reply-buttons for
 * whatever the text's own "reply *X*" mentions describe — a seller
 * shouldn't have to remember or retype those phrases when a tap does the
 * same thing (see sendStatusReply, which renders whichever combination a
 * given state returns). Buttons are always additive, never a replacement
 * for the phrase spelled out in the text. Async because
 * awaiting_confirmation now looks up each product's real Jumia
 * submission status rather than a single generic "ready to review".
 */
async function describeStatus(
  session: WhatsAppSession,
): Promise<{ text: string; cta?: { label: string; url: string }; buttons?: { id: string; title: string }[] }> {
  switch (session.state) {
    case "awaiting_jumia_credentials":
      return {
        text: "Waiting for your Jumia Client ID and generated token — paste them here, or reply *restart* to back out.",
        buttons: [{ id: "restart", title: "Restart 🔄" }],
      };
    case "awaiting_jumia_oauth":
      return {
        text: "Waiting for you to finish connecting Jumia via the link I sent — reply *resend* for a new one, or *restart* to back out.",
        buttons: [
          { id: "resend", title: "Resend link" },
          { id: "restart", title: "Restart 🔄" },
        ],
      };
    case "awaiting_count":
      return { text: "Ready when you are — reply with how many products you're listing today.", buttons: COUNT_QUICK_PICKS };
    case "awaiting_photos":
      return {
        text: `Collecting product ${session.batchSeq ?? 1} of ${session.batchSize ?? 1} — send its photos, then reply *done*.`,
        // "done" isn't a real option until a photo's actually landed for
        // this product — session.listingId is only ever set once the
        // first one has (see handleAwaitingPhotos).
        buttons: session.listingId ? [{ id: "done", title: "Done ✅" }] : undefined,
      };
    case "analyzing":
      return {
        text: "Drafting your products right now — this can take up to a minute.",
      };
    case "awaiting_confirmation": {
      const batchId = session.batchId;
      const listings = batchId ? await getBatchListings(batchId) : [];
      const submitButtons = [
        { id: "submit all", title: "Submit all ✅" },
        { id: "restart", title: "Restart 🔄" },
      ];
      if (listings.length === 0) {
        return {
          text: "Your batch is drafted and ready to review.\n\nReply *submit all* when you're ready.",
          cta: { label: "Review listings", url: whatsappListingsUrl(batchId ?? undefined) },
          buttons: submitButtons,
        };
      }
      const lines = listings.map(
        (l) => `${l.whatsapp_seq ?? "?"}. ${l.title ?? "(untitled)"} — ${STATUS_LABELS[l.status] ?? l.status}`,
      );
      return {
        text: [
          `Batch status (${listings.length} product${listings.length === 1 ? "" : "s"}):`,
          ...lines,
          "",
          "Reply *submit all* to push whatever's still a draft, or *restart* to start over.",
        ].join("\n"),
        cta: { label: "Review listings", url: whatsappListingsUrl(batchId ?? undefined) },
        buttons: submitButtons,
      };
    }
    case "error":
      return {
        text: "Something went sideways — tap Retry to pick up where you left off, or start fresh.",
        buttons: [
          { id: "retry",   title: "Retry 🔁" },
          { id: "restart", title: "Restart 🔄" },
        ],
      };
  }
}

/** A reply that is plainly a count ("3", "3 products"), not text that holds a number ("Quantity 20"). */
const CLEAR_COUNT_RE = /^\s*\d{1,3}\s*(products?|items?)?\s*[.!]?\s*$/i;

async function handleAwaitingCount(
  userId: string,
  phoneNumber: string,
  session: WhatsAppSession,
  content: { text?: string; imageMediaId?: string },
): Promise<void> {
  // Defense in depth: the LINK-code branch in app/api/whatsapp/webhook/
  // route.ts already checks this once, right after linking. Re-checking
  // here catches a connection that broke (or was never real) in between
  // — a seller whose Jumia connection needs reconnecting or was somehow
  // never actually gated should never be allowed to draft a whole batch
  // only to discover at submit time that Jumia will reject everything.
  const kind = await getJumiaConnectionKind(userId);
  if (kind !== "connected") {
    await promptJumiaConnection(userId, phoneNumber, kind);
    return;
  }

  // Straight after a batch went to Jumia, a reply that isn't plainly a
  // count is about those products. "Quantity 20" was read as a count and
  // started a 20-product batch (owner's report, 2026-10-03).
  const typed = content.text?.trim();
  if (session.lastSubmittedBatchId && typed && !CLEAR_COUNT_RE.test(typed)) {
    const sent = await getBatchListings(session.lastSubmittedBatchId);
    const one = sent.length === 1;
    const which = one && sent[0].title ? `"${sent[0].title}" is` : one ? "Your product is" : "Your products are";
    const waiting = sent.some((l) => l.status === "pending_approval" || l.status === "processing");
    await replyButtons(
      phoneNumber,
      `✅ ${which} already with Jumia` +
        (waiting
          ? `, waiting for its review. I'll message you here as ${one ? "it goes" : "each one goes"} live.`
          : ". I've messaged you above how it went.") +
        "\n\nTo change something, edit it in Jumia Vendor Center. To list something new, tap *Start another*.",
      [START_ANOTHER],
    );
    return;
  }

  // 10 for sellers, 20 for admins (owner's call, 2026-10-03).
  const max = isAdmin(userId) ? ADMIN_MAX_BATCH_SIZE : MAX_BATCH_SIZE;
  const parsed = content.text ? readProductCount(content.text, max) : { ok: false as const, reason: "no_number" as const };

  if (!parsed.ok) {
    // Say which thing went wrong. Answering "50" with "I need a number"
    // reads as the bot not understanding, when the real answer is the
    // batch cap — a fact the seller can act on immediately.
    const message =
      parsed.reason === "too_many"
        ? `⚠️ ${parsed.value} is more than I can draft in one go — the most is ${max} at a time. Reply with a number up to ${max} and you can start another batch straight after.`
        : parsed.reason === "too_few"
          ? `⚠️ I need at least 1 product to get started — reply with how many you're listing today (1–${max}).`
          : `⚠️ I need a number to get started — reply with how many products you're listing today (1–${max}), e.g. *3*.`;
    await replyButtons(phoneNumber, message, COUNT_QUICK_PICKS);
    return;
  }
  const count = parsed.count;

  const batchId = crypto.randomUUID();
  await updateSession(phoneNumber, {
    state:     "awaiting_photos",
    batchId,
    batchSize: count,
    batchSeq:  1,
    listingId: null,
    lastSubmittedBatchId: null,
  });

  // A single product has no "in between" for quiet mode to skip — the
  // choice would be a tap that changes nothing, so it's only offered for
  // an actual batch.
  if (count === 1) {
    await replyText(
      phoneNumber,
      `Let's go — send its photos, and tell me the price plus any other notes (variations, sizes, sale price etc.), then reply *done*.`,
    );
    return;
  }

  await replyButtons(
    phoneNumber,
    `Got it — ${count} products. You can send all ${count} in two ways.\n\n` +
    `I. Select all the photos of each product and caption it with the price and any other notes then send. After sending all the images of product 1, type and send 1, after sending all the images of product 2, type and send 2. Do same in that order until you finish sending all the ${count} products.\n` +
    `I'll stay quiet until the last one, then start drafting everything at once.\n\n` +
    `II. Guide me each step`,
    [
      { id: "batch_mode:quiet",       title: "I" },
      { id: "batch_mode:interactive", title: "II" },
    ],
  );
}

async function sendJumiaConnectLink(userId: string, phoneNumber: string): Promise<void> {
  const token = await createConnectToken(userId);
  await sendCtaUrlIfConfigured(
    phoneNumber,
    "Let's finish connecting your Jumia store. I'll message you here once it's done.",
    "Connect Jumia",
    jumiaConnectLink(token),
  );
}

/**
 * Waiting for the seller to paste their Jumia Client ID and generated
 * token (see buildConnectInstructions in lib/whatsapp/jumia-connect.ts).
 * Accepts both together in one message or one at a time; pendingAppId on
 * the session holds the first half across messages.
 *
 * The pair is tried as a Self Authorization app first (Client ID +
 * generated token): connected right here and kept alive automatically.
 * Only if Jumia says that Client ID can't do that exchange is the second
 * half treated as a Web Application's Client Secret, which still goes
 * through the login link and expires daily. Shape can't tell them apart:
 * Vendor Center's generated token and a Client Secret look alike.
 */
async function handleAwaitingJumiaCredentials(
  userId: string,
  phoneNumber: string,
  session: WhatsAppSession,
  content: { text?: string; imageMediaId?: string },
): Promise<void> {
  const text = content.text?.trim();
  if (!text) {
    await replyText(phoneNumber, "Paste your Jumia Client ID and the generated token here to continue connecting.");
    return;
  }

  const tokens = splitCredentialTokens(text);
  let appId: string;
  let secretKey: string;

  // Catches conversational replies ("Okay", "Ok", "Hi", "Thanks") before
  // they're ever treated as a credential — confirmed live: without this,
  // a stray "Okay" got stored as pendingAppId and confirmed back as "Got
  // the Client ID", then "Ok" as the Client Secret triggered a real (and
  // pointless) call to Jumia's API before finally failing. Checked on
  // every token up front so none of the branches below need their own
  // version of this guard.
  const implausible = tokens.some((t) => !looksLikeCredential(t));
  if (tokens.length > 0 && implausible) {
    await replyButtons(
      phoneNumber,
      "That doesn't look like a Jumia Client ID or token — they're both long codes from Vendor Center → Settings → Applications. Paste your Client ID and the generated token again.",
      [{ id: "restart", title: "Restart 🔄" }],
    );
    return;
  }

  // A 2+-token message always wins as a fresh (appId, secretKey) pair —
  // even if a pendingAppId was already waiting — since a seller who
  // changes their mind and re-pastes both clearly means "start over with
  // these", not "append this to what I sent before". Only a single token
  // ever consults pendingAppId, to complete whichever half is missing.
  if (tokens.length >= 2) {
    ({ appId, secretKey } = identifyCredentials(tokens[0], tokens[1]));
  } else if (tokens.length === 1 && session.pendingAppId) {
    ({ appId, secretKey } = identifyCredentials(session.pendingAppId, tokens[0]));
  } else if (tokens.length === 1) {
    await updateSession(phoneNumber, { pendingAppId: tokens[0] });
    await replyText(phoneNumber, looksLikeClientId(tokens[0])
      ? "Got the Client ID — now paste the generated token."
      : "Got the token — now paste the Client ID.");
    return;
  } else {
    await replyText(phoneNumber, "Paste your Jumia Client ID and the generated token here to continue connecting.");
    return;
  }

  // Self Authorization first: connect now, no login link, stays connected.
  const connected = await connectSelfAuthorization(userId, appId, secretKey, countryFromPhone(phoneNumber));
  if (!connected.ok && connected.reason !== "web_app") {
    await updateSession(phoneNumber, { pendingAppId: null });
    await replyButtons(
      phoneNumber,
      `⚠️ ${connected.error}\n\nPaste your Client ID and a newly generated token again.`,
      [{ id: "restart", title: "Restart 🔄" }],
    );
    return;
  }
  if (connected.ok) {
    // Reconnected in the middle of a batch (promptReconnectKeepingBatch).
    if (session.batchId) {
      await resumeBatchAfterReconnect(phoneNumber, connected.storeName);
      return;
    }
    await updateSession(phoneNumber, {
      pendingAppId: null, state: "awaiting_count", listingId: null, batchId: null, batchSize: null, batchSeq: null,
    });
    // The count buttons ride on this message, as after a restart: one
    // message, not the question and then the buttons.
    await replyButtons(
      phoneNumber,
      `🎉 Jumia connected — ${connected.storeName}!\n\n` +
        "How many products are you listing today? Reply with a number to get started.",
      COUNT_QUICK_PICKS,
    );
    return;
  }

  // Not a Self Authorization app: maybe a Web Application's Client ID and
  // Client Secret, which still works but needs a login about once a day.
  const testResult = await testJumiaCredentials(appId, secretKey);
  if (!testResult.ok) {
    await updateSession(phoneNumber, { pendingAppId: null });
    await replyButtons(
      phoneNumber,
      "⚠️ Jumia didn't accept that Client ID and token. Check you copied the Client ID of the PandaWorld application " +
        "(Self Authorization), and paste the token straight after tapping on the padlock icon 🔒, before it expires.\n\n" +
        "Paste your Client ID and a newly generated token again.",
      [{ id: "restart", title: "Restart 🔄" }],
    );
    return;
  }

  const saveResult = await saveJumiaCredentialsForUser(userId, appId, secretKey);
  if (!saveResult.ok) {
    await updateSession(phoneNumber, { pendingAppId: null });
    await replyButtons(
      phoneNumber,
      `⚠️ ${saveResult.error}\n\nPaste your Client ID and Client Secret again.`,
      [{ id: "restart", title: "Restart 🔄" }],
    );
    return;
  }

  await updateSession(phoneNumber, { pendingAppId: null, state: "awaiting_jumia_oauth" });
  await replyText(phoneNumber, "✅ Credentials saved! For your security, please delete that message from this chat now.");
  await sendJumiaConnectLink(userId, phoneNumber);
}

/** Waiting for the seller to tap the one-time link and approve in Jumia
 *  Vendor Center — app/api/jumia/callback/route.ts flips the session to
 *  awaiting_count and messages back here once that completes. */
async function handleAwaitingJumiaOauth(
  userId: string,
  phoneNumber: string,
  content: { text?: string; imageMediaId?: string },
): Promise<void> {
  const text = content.text?.trim();
  if (text && isResendCommand(text)) {
    await sendJumiaConnectLink(userId, phoneNumber);
    return;
  }
  await replyButtons(
    phoneNumber,
    "Still waiting for you to finish connecting Jumia — tap the link I sent earlier, or reply *resend* for a new one.",
    [{ id: "resend", title: "Resend link" }],
  );
}

/** Postgres unique-violation, however the client surfaces it. */
function isDuplicateSlot(e: unknown): boolean {
  const msg = (e as Error)?.message ?? "";
  return /duplicate key value|23505|already exists/i.test(msg);
}

/** The listing already holding this batch position, if any. */
async function findBatchSlotListing(userId: string, batchId: string | null, seq: number): Promise<string | null> {
  if (!batchId) return null;
  const { data } = await createServerClient()
    .from("listings")
    .select("id")
    .eq("user_id", userId)
    .eq("whatsapp_batch_id", batchId)
    .eq("whatsapp_seq", seq)
    .maybeSingle();
  return (data?.id as string | undefined) ?? null;
}

/**
 * The one listing for this product, creating it only if nobody else
 * already has. See the call site for the album race this exists for.
 *
 * Returns the EXISTING row whenever there is one, so a second, third and
 * fourth photo of the same product all land on it.
 */
async function claimBatchSlot(
  userId:  string,
  batchId: string | null,
  seq:     number,
): Promise<{ ok: true; listingId: string } | { ok: false; message: string }> {
  const findExisting = () => findBatchSlotListing(userId, batchId, seq);

  const existing = await findExisting();
  if (existing) return { ok: true, listingId: existing };

  try {
    const listing = await createListingForUser(userId, {
      whatsapp_batch_id: batchId,
      whatsapp_seq:      seq,
    });
    return { ok: true, listingId: listing.id };
  } catch (e) {
    if (isDuplicateSlot(e)) {
      // Another delivery of the same album won. Adopt its listing rather
      // than reporting an error the seller did nothing to cause.
      const winner = await findExisting();
      if (winner) return { ok: true, listingId: winner };
    }
    return {
      ok:      false,
      message: (e as Error).message,
    };
  }
}

/**
 * Hold a note until this product has a listing to attach it to.
 *
 * Appends rather than replaces: a second note before the photo arrives is
 * the seller adding to or correcting the first, and keeping both is what
 * they would expect. applyNotes caps what it stores, so an unbounded
 * append cannot grow the listing's user_prompt past that.
 */
async function parkNotes(
  phoneNumber: string,
  session:     WhatsAppSession,
  notes:       string,
): Promise<void> {
  const trimmed = notes.trim();
  if (!trimmed) return;
  const combined = session.pendingNotes
    ? `${session.pendingNotes}\n${trimmed}`
    : trimmed;
  await updateSession(phoneNumber, { pendingNotes: combined.slice(0, 1000) });
}

/**
 * How long a photo burst has to be quiet before "done" is taken at face
 * value.
 *
 * Measured on a real album: six deliveries spanned under four seconds end
 * to end. Six is comfortably clear of that while still being a wait a
 * seller barely notices — and it is only ever waited out by someone who
 * tapped Done while photos were mid-flight.
 */
const PHOTO_SETTLE_MS = 6_000;

/**
 * Milliseconds since this listing's last photo landed, using the row's own
 * updated_at — append_listing_image stamps it (see
 * 2026-09-15_atomic-image-append.sql), so no extra column is needed.
 *
 * Answers Infinity when unknown, which reads as "long ago" and lets the
 * caller proceed. A failure here must never wedge a seller's "done".
 */
async function msSinceLastPhoto(listingId: string): Promise<number> {
  const db = createServerClient();
  const { data, error } = await db.from("listings").select("updated_at").eq("id", listingId).maybeSingle();
  if (error || !data?.updated_at) return Infinity;
  const at = Date.parse(data.updated_at as string);
  return Number.isFinite(at) ? Date.now() - at : Infinity;
}

/** How many photos this listing currently holds. Best-effort: a failure
 *  answers 0, which simply omits the count from the reply rather than
 *  holding up the seller's "done". */
async function listingIntakeSummary(listingId: string): Promise<{ photos: number; hasNotes: boolean }> {
  const db = createServerClient();
  const { data, error } = await db.from("listings").select("images, user_prompt").eq("id", listingId).maybeSingle();
  if (error) {
    console.warn(`[whatsapp intake] photo count failed for listing ${listingId}: ${error.message}`);
    return { photos: 0, hasNotes: false };
  }
  return {
    photos:   ((data?.images ?? []) as string[]).filter(Boolean).length,
    hasNotes: Boolean(String((data?.user_prompt as string | null) ?? "").trim()),
  };
}

/**
 * Claims a batch slot on first photo and atomically appends one image to
 * it — the one piece of photo-handling both the interactive and quiet
 * batch flows share verbatim. Extracted so quiet mode doesn't duplicate
 * (and risk drifting from) the album-race protections already proven out
 * in the interactive flow.
 *
 * The MAX_LISTING_IMAGES-reached notice is the only reply here that quiet
 * mode suppresses (`quiet: true`) — it's routine overflow guidance, not
 * something wrong. A claim failure or a photo that won't ingest is a real
 * problem happening right now, in both modes: silently losing a photo is
 * worse than one message breaking the quiet rule to say so.
 */
async function appendPhotoToListing(
  userId:      string,
  phoneNumber: string,
  session:     WhatsAppSession,
  seq:         number,
  listingId:   string | null,
  imageMediaId: string,
  quiet:       boolean,
): Promise<{ ok: true; listingId: string } | { ok: false; listingId?: string }> {
  if (!listingId) {
    // CLAIM the (batch, position) slot rather than just creating a row.
    //
    // WhatsApp delivers an album as several webhook messages within the
    // same second. Each ran this block, each saw session.listingId still
    // null, and each created a listing — so photos of ONE product became
    // one listing per photo. Confirmed live: two "4 Burner Gas ..."
    // listings 115ms apart, one holding the seller's note and the other
    // an orphan with photos and nothing else.
    //
    // Reading first narrows the window; only the unique index closes it
    // (see 2026-09-14_one-listing-per-batch-slot.sql), because the losing
    // INSERT has to fail for the loser to know to adopt the winner's row.
    // So: look, then claim, then on collision look again.
    const claimed = await claimBatchSlot(userId, session.batchId, seq);
    if (!claimed.ok) {
      await replyError(phoneNumber, `⚠️ Couldn't start product ${seq}: ${claimed.message}`);
      return { ok: false };
    }
    listingId = claimed.listingId;
    await updateSession(phoneNumber, { listingId });

    // Flush a note that beat its own photo here. Separate webhook
    // deliveries are not ordered, and a line of text routinely
    // overtakes the image it was sent with — so without this the
    // seller's price, variants and sale window are simply gone by the
    // time there is a listing to put them on.
    if (session.pendingNotes) {
      await applyNotes(listingId, session.pendingNotes);
      await updateSession(phoneNumber, { pendingNotes: null });
      console.info(`[whatsapp] listing=${listingId} applied notes that arrived before the photo`);
    }
  }

  const db = createServerClient();
  const { data: row } = await db.from("listings").select("images").eq("id", listingId).maybeSingle();
  const current = (row?.images ?? []) as string[];

  if (current.length >= MAX_LISTING_IMAGES) {
    if (!quiet) {
      await replyButtons(
        phoneNumber,
        `You've already sent ${MAX_LISTING_IMAGES} photos (the max) for product ${seq} — reply *done* when you're finished with this one.`,
        [{ id: "done", title: "Done ✅" }],
      );
    }
    // The photo is dropped, but the listing comes back so a caption on it
    // is still saved: it is the seller's note, not part of the photo.
    return { ok: false, listingId };
  }

  const url = await ingestWhatsAppImage(imageMediaId, userId);
  if (!url) {
    await replyError(phoneNumber, "⚠️ That photo didn't come through cleanly (unsupported format or too large) — try another one.");
    return { ok: false };
  }

  // Atomic append — see 2026-09-15_atomic-image-append.sql.
  //
  // This was [...current, url] written back over the row, and it lost
  // photos: an album's deliveries all read `images` before any of them
  // wrote, each built a one-element array, and the last write won. A
  // seller sent three photos of one product and one survived.
  //
  // The read above is still fine for the cap early-out — it saves
  // ingesting an image that would be discarded — but it must not be
  // what the write is based on.
  await db.rpc("append_listing_image", {
    p_listing_id: listingId,
    p_url:        url,
    p_max:        MAX_LISTING_IMAGES,
  });

  return { ok: true, listingId };
}

/**
 * Waits out any remaining photo-settle window before quiet mode silently
 * closes a product, in place of the interactive flow's "still receiving
 * photos, tap Done again" hold — quiet mode has no reply to send in
 * between, so it blocks the remainder out instead.
 *
 * A straggler that lands DURING the wait is a perfectly ordinary,
 * independent webhook delivery — it reads session.listingId, finds this
 * product's slot still open (we haven't advanced yet), and appends to it
 * exactly as if no wait were happening. That's what makes waiting BEFORE
 * advancing safe: nothing about the wait itself has to detect or react
 * to the straggler, it only has to not have moved the goalposts yet.
 *
 * Bounded to 3 rounds (≤3×PHOTO_SETTLE_MS ≈ 18s worst case, comfortably
 * inside Vercel's 60s function ceiling) rather than looping forever — a
 * seller who keeps trickling photos in one at a time forever isn't a case
 * worth blocking a whole invocation over indefinitely.
 */
async function settlePhotosBeforeClose(listingId: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const age = await msSinceLastPhoto(listingId);
    if (!Number.isFinite(age) || age >= PHOTO_SETTLE_MS) return;
    await new Promise((resolve) => setTimeout(resolve, PHOTO_SETTLE_MS - age));
  }
}

/**
 * How long a close marker waits for a photo that has reached the webhook
 * but not yet made its listing. A cold start on the photo's own delivery
 * can take a few seconds; this is what that wait is bounded by.
 */
const PHOTO_IN_FLIGHT_MS = 10_000;
const PHOTO_IN_FLIGHT_POLL_MS = 1_000;

/** Whether an inbound photo from this number reached the webhook since
 *  `sinceMs`. The webhook logs every message on arrival, before handling
 *  it (app/api/whatsapp/webhook/route.ts), so this sees a photo whose
 *  handling is still under way. */
async function photoReceivedSince(phoneNumber: string, sinceMs: number): Promise<boolean> {
  const { data, error } = await createServerClient()
    .from("whatsapp_message_log")
    .select("id")
    .eq("phone_number", phoneNumber)
    .eq("direction", "inbound")
    .eq("message_type", "image")
    .gt("created_at", new Date(sinceMs).toISOString())
    .limit(1);
  return !error && Array.isArray(data) && data.length > 0;
}

/**
 * The listing for this product, waiting for one whose photo is still being
 * handled. Live, 2026-10-01: a seller sent product 1's photo and "1" a
 * second apart, exactly as quiet mode tells them to. The "1" was handled
 * before the photo had made product 1's listing, found nothing to close,
 * and was filed as a note; product 1 never closed, and products 2 to 4's
 * photos all landed on it. Only waits when a photo did arrive just now, so
 * a marker sent with no photo at all is answered straight away.
 */
async function slotListingOnceInFlightPhotoLands(
  userId:      string,
  phoneNumber: string,
  batchId:     string | null,
  seq:         number,
): Promise<string | null> {
  const found = await findBatchSlotListing(userId, batchId, seq);
  if (found || !(await photoReceivedSince(phoneNumber, Date.now() - PHOTO_IN_FLIGHT_MS))) return found;
  const deadline = Date.now() + PHOTO_IN_FLIGHT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, PHOTO_IN_FLIGHT_POLL_MS));
    const listingId = await findBatchSlotListing(userId, batchId, seq);
    if (listingId) return listingId;
  }
  return null;
}

/**
 * Notes still parked on the session when a product closes belong to it: a
 * note that overtook its photo is parked, and the photo's delivery only
 * picks up what it saw parked when it started. Read fresh, applied here,
 * then cleared by the advance, instead of being cleared unread.
 */
async function applyParkedNotes(userId: string, phoneNumber: string, listingId: string): Promise<void> {
  const fresh = await getOrCreateSession(userId, phoneNumber);
  if (fresh.pendingNotes) await applyNotes(listingId, fresh.pendingNotes);
}

/** A message that is only the number of another product in this batch
 *  ("2", "*2*"). Never a price: quiet mode asks for these numbers, and
 *  "2" and "4" read as prices left a draft priced at 4. */
function otherProductNumber(text: string, seq: number, batchSize: number): number | null {
  const m = /^\*?(\d{1,2})\*?[.,!]*$/.exec(text.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= batchSize && n !== seq ? n : null;
}

/**
 * Quiet batch mode: the seller sends every product's photos back to back
 * with no per-product confirmations, closing each one by replying with
 * just its number (or "done") — see the rule message sent when the mode
 * is chosen, in handleAwaitingPhotos above.
 *
 * Design constraint: a bare number is otherwise a price everywhere else
 * in this flow (extractPrice's bare-number rule, awaitingPriceFor). Only
 * the CURRENT product's own number closes it. Another product's number on
 * its own means the seller and the bot disagree about which product is
 * open, which is worth breaking the silence for (a later one) or ignoring
 * (an earlier one, already closed). Any other text is a note on whatever
 * product is open.
 *
 * Quiet mode replies between products only when something is wrong right
 * now: a close with no photo, a number out of turn, a slot that couldn't
 * be claimed or a photo that wouldn't ingest. Staying silent through those
 * is how a seller sent four products and got nothing back.
 */
async function handleQuietBatchMessage(
  userId:      string,
  phoneNumber: string,
  session:     WhatsAppSession,
  content:     { text?: string; imageMediaId?: string },
  seq:         number,
  batchSize:   number,
): Promise<void> {
  let listingId = session.listingId;

  if (content.imageMediaId) {
    const appended = await appendPhotoToListing(userId, phoneNumber, session, seq, listingId, content.imageMediaId, true);
    // Over the photo cap the photo is dropped but its caption still counts.
    if (!appended.ok && !appended.listingId) return;
    listingId = appended.listingId ?? listingId;
  }

  const text = content.text?.trim();
  if (!text) return; // a bare photo (or one that failed to ingest above) — silence either way.

  // The close signal can be the WHOLE message ("1", "done") or trail a
  // caption/note ("Price 40\n1"), mirroring endsWithDoneSignal/
  // stripDoneSignal's own "done" handling — a seller combining a note
  // with the number the same natural way they'd combine one with "done"
  // must not lose the note.
  const tokens = text.split(/\s+/);
  const lastToken = (tokens[tokens.length - 1] ?? "").replace(/^\*+/, "").replace(/[*.,!]+$/, "");
  const closesThis = lastToken === String(seq) || /^done$/i.test(lastToken);

  if (!closesThis) {
    const other = otherProductNumber(text, seq, batchSize);
    if (other != null) {
      if (other > seq) await sayStillOnProduct(phoneNumber, listingId, seq, batchSize);
      return;
    }
    // Free text that isn't this product's closing signal — park it as a
    // note on whatever's open, exactly like the interactive flow, just
    // without the "got it" reply.
    if (listingId) await applyNotes(listingId, text);
    else await parkNotes(phoneNumber, session, text);
    return;
  }

  const notes = tokens.slice(0, -1).join(" ").trim();

  // This delivery may have read the session before the product's photo
  // made its listing; look for it, and wait for one still being handled.
  if (!listingId) listingId = await slotListingOnceInFlightPhotoLands(userId, phoneNumber, session.batchId, seq);

  if (!listingId) {
    // Closing a product that has no photo. Not advanced, so the photos
    // that follow land on this product rather than the next, and the
    // seller is told: going on in silence would put the next product's
    // photos on this one.
    if (notes) await parkNotes(phoneNumber, session, notes);
    await replyText(phoneNumber, `I haven't received any photos for product ${seq} yet. Send them, then reply *${seq}*.`);
    return;
  }

  // Settle BEFORE applying any combined note — applyNotes stamps this
  // same listing's updated_at, and reading the age afterward would make
  // every "Price 40\n1" look like a photo had just landed, holding up a
  // close that was never actually racing an album. Same ordering bug the
  // interactive flow's own "done" handling already had to learn once.
  await settlePhotosBeforeClose(listingId);

  if (notes) await applyNotes(listingId, notes);
  await applyParkedNotes(userId, phoneNumber, listingId);

  if (seq < batchSize) {
    // Any note still parked was applied just above, so clearing it with
    // the advance can't staple this product's price onto the next.
    await updateSession(phoneNumber, {
      state:        "awaiting_photos",
      listingId:    null,
      batchSeq:     seq + 1,
      pendingNotes: null,
      lastImageAt:  null,
    });
    return; // still silent — this is quiet mode's entire point.
  }

  // The LAST product's closing signal — the one moment quiet mode replies.
  // startBatchAnalysis reads batchId/batchSize straight off `session`,
  // neither of which this function has touched, so it's safe to hand the
  // same object off unchanged.
  await startBatchAnalysis(phoneNumber, userId, session);
}

/** A later product's number while this one is still open: the seller
 *  thinks they've moved on and the bot hasn't, so everything they send
 *  next would land on the wrong product. Says so once, with a way out. */
async function sayStillOnProduct(
  phoneNumber: string,
  listingId:   string | null,
  seq:         number,
  batchSize:   number,
): Promise<void> {
  const photos = listingId ? (await listingIntakeSummary(listingId)).photos : 0;
  if (photos === 0) {
    await replyText(
      phoneNumber,
      `⚠️ I'm still on product ${seq} of ${batchSize} and haven't received its photos yet. Send product ${seq}'s photos, then reply *${seq}*.`,
    );
    return;
  }
  // Usually a skipped number (live: product 3's photos, then "4"), so the
  // way on is closing this product; Restart is for photos that landed on
  // the wrong one.
  await replyButtons(
    phoneNumber,
    `⚠️ I'm still on product ${seq} of ${batchSize}, which has ${photos} photo${photos === 1 ? "" : "s"} so far. ` +
      `Reply *${seq}* to finish it, then send product ${seq + 1}'s photos and *${seq + 1}*.\n\n` +
      `If some of those photos belong to another product, tap *Restart* to send the batch again.`,
    [{ id: "restart", title: "Restart 🔄" }],
  );
}

async function handleAwaitingPhotos(
  userId: string,
  phoneNumber: string,
  session: WhatsAppSession,
  content: { text?: string; imageMediaId?: string },
): Promise<void> {
  const batchSize = session.batchSize ?? 1;
  const seq = session.batchSeq ?? 1;
  let listingId = session.listingId;

  // ── Mode choice from handleAwaitingCount's buttons ───────────────────────
  //
  // Arrives as ordinary text (button ids ARE command phrases, same design
  // as every other reply-button in this file) before the seller has sent
  // any photo, so it's safe to check first without touching listingId.
  if (content.text === "batch_mode:quiet" || content.text === "batch_mode:interactive") {
    const quiet = content.text === "batch_mode:quiet";
    await updateSession(phoneNumber, { batchQuiet: quiet });
    if (!quiet) {
      await replyText(
        phoneNumber,
        `Let's go — product 1 of ${batchSize}.\n\nSend its photos, and tell me the price plus any other notes (variations, sizes, sale price etc.), then reply *done*.`,
      );
      return;
    }
    // The mechanic was already spelled out in the choice message above, so
    // this confirms the pick and SHOWS it: a worked example (photo, price
    // as the caption, then the product's number) is clearer than another
    // paragraph. One message, the instruction as the image's caption,
    // which WhatsApp shows under the picture. If the image is refused, the
    // instruction still goes out as plain text.
    const instruction = `Got it — send product ${seq}'s photos, then reply *${seq}* once you're done with it`;
    try {
      await sendImageIfConfigured(phoneNumber, quietModeExampleUrl(), `${instruction}, like in the example above.`);
    } catch (e) {
      console.warn(`[whatsapp intake] quiet-mode example image failed for ${phoneNumber}: ${(e as Error).message}`);
      await replyText(phoneNumber, `${instruction}.`);
    }
    return;
  }

  // ── Quiet mode: no per-product confirmations, closed by a number ────────
  if (session.batchQuiet) {
    await handleQuietBatchMessage(userId, phoneNumber, session, content, seq, batchSize);
    return;
  }

  // ── Photo, with or without a caption in the same message ────────────────
  if (content.imageMediaId) {
    const appended = await appendPhotoToListing(userId, phoneNumber, session, seq, listingId, content.imageMediaId, false);
    // Over the photo cap the photo is dropped but its caption still counts.
    if (!appended.ok && !appended.listingId) return;
    listingId = appended.listingId ?? listingId;

    // Falls through to the text handling below — a caption ("Price 40,
    // done") sent alongside this photo used to be silently dropped
    // because this branch returned early. Now the caption (if any) is
    // processed exactly like a standalone message in the same turn.
  }

  const text = content.text?.trim();

  if (!text) {
    if (content.imageMediaId) {
      // No reply. A photo used to get "📸 Product N: got it. Send more
      // photos, or reply done" once per burst, which was one of the
      // commonest messages the bot sent: about one per product. From
      // 2026-10-01 Meta charges for every message the bot sends, so it
      // went. The seller already knows to reply *done* (the product's
      // prompt says so), and "done" answers with the real photo count
      // ("✅ Product N saved (3 photos)"), which is what the burst reply
      // was there to reassure them about.
    } else {
      await replyText(phoneNumber, `Send a photo for product ${seq} (or reply *done* once you've sent its photos).`);
    }
    return;
  }

  if (endsWithDoneSignal(text)) {
    // How long ago the last photo actually landed, read FIRST.
    //
    // applyNotes below writes to the same row and stamps updated_at, which
    // is the very column this reads. Taking it afterwards would make every
    // "250\nDone" look like a photo had just arrived, and the settle hold
    // further down would fire on the most common message in the whole flow
    // — a price and a done in one breath.
    const lastPhotoAgeMs = listingId ? await msSinceLastPhoto(listingId) : Infinity;

    // The done-signal can be the WHOLE message ("done") or trail a
    // caption/note ("Price 40\nDone") — strip it so anything before it
    // still gets saved instead of discarded.
    const notes = stripDoneSignal(text);
    if (notes && listingId) await applyNotes(listingId, notes);
    if (listingId) await applyParkedNotes(userId, phoneNumber, listingId);

    if (!listingId) {
      // The note is PARKED, not dropped. It used to be discarded right
      // here — `if (notes && listingId)` above is false — and the seller
      // was told to send a photo, with no hint that everything they had
      // just typed was gone. Confirmed live: a product drafted with no
      // price, no variants and no sale window under a note that gave all
      // three.
      if (notes) await parkNotes(phoneNumber, session, notes);
      await replyText(
        phoneNumber,
        notes
          ? `Got your notes for product ${seq} — I'll attach them to the photo. Send at least one photo, then reply *done*.`
          : `Send at least one photo for product ${seq} first, then reply *done*.`,
      );
      return;
    }

    // The photo count the seller was promised, delivered once and
    // accurate. Read from the row rather than carried along: the delivery
    // that handles "done" is a different invocation from the ones that
    // appended the photos, and on an album it may not even be the last.
    // Notes are named too: a note sent as a photo caption mid-album is
    // saved without a reply of its own (see the captioned-photo branch
    // below), so this is where the seller hears it arrived.
    const { photos: photoCount, hasNotes } = listingId ? await listingIntakeSummary(listingId) : { photos: 0, hasNotes: false };
    const photoNote = photoCount > 0
      ? ` (${photoCount} photo${photoCount === 1 ? "" : "s"}${hasNotes ? ", notes saved" : ""})`
      : "";

    // ── Don't advance while the album is still arriving ──────────────────
    //
    // Reported 2026-09-15: a seller sent 7 photos of one pair of
    // headphones; 5 landed on it and 2 landed on the NEXT product, which
    // they had sent no photos for at all. The transcript shows exactly how:
    //
    //   "Product 2 saved (2 photos). Now send photos for product 3…"
    //   "📸 Product 2: got it…"        ← a straggler, AFTER the advance
    //   "Product 3 saved (2 photos)"   ← product 3's photos were product 2's
    //
    // WhatsApp delivers an album as N independent webhook deliveries and
    // does not order them. Tapping Done on the first confirmation closes
    // the product while the rest are still in the air, and every one that
    // lands afterwards is attributed to whatever product is current by
    // then. Nothing is lost — all 7 reached the database — but 2 of them
    // describe the wrong product, which is worse than losing them: the
    // listing looks complete and is wrong.
    //
    // WhatsApp gives us no album id, so there is no way to know which
    // product a late photo belongs to. What we DO know is whether photos
    // are still arriving. So instead of guessing, the advance waits: if
    // the last photo landed moments ago, the album is still landing, and
    // "done" is almost certainly early.
    //
    // A hold, not a heuristic reassignment. Guessing that a straggler
    // belongs to the previous product would misfire the moment a seller
    // genuinely starts the next one quickly — and a wrong guess here is
    // the exact failure being fixed. Asking costs one tap; guessing costs
    // a wrong listing.
    //
    // Notes are already saved above, so nothing the seller typed is at
    // risk while they wait.
    if (listingId && lastPhotoAgeMs < PHOTO_SETTLE_MS) {
      await replyButtons(
        phoneNumber,
        `📸 Still receiving your photos for product ${seq} — give it a couple of seconds, then tap *Done*.`,
        [{ id: "done", title: "Done ✅" }],
      );
      return;
    }

    if (seq < batchSize) {
      // pendingNotes cleared with the advance: anything still parked
      // belonged to the product just finished and was applied to it above,
      // and carrying it forward would staple one product's price and
      // variants onto the next.
      await updateSession(phoneNumber, {
        state:        "awaiting_photos",
        listingId:    null,
        batchSeq:     seq + 1,
        pendingNotes: null,
        // Ends the burst with the product. Without this the first photo of
        // product N+1 could be silenced by the last photo of product N.
        lastImageAt:  null,
      });
      // The full instructions ("Send its photos, and tell me the price
      // plus any other notes...") already went out once, in
      // handleAwaitingCount's very first reply — every product after that
      // repeated the entire paragraph verbatim, so a 10-product batch said
      // the same three sentences nine times. Audited from a real chat
      // export on 2026-09-16: pure repetition, no new information after
      // the first time. What IS new each time is the photo count just
      // confirmed and which product comes next — that's what stays.
      await replyText(
        phoneNumber,
        `✅ Product ${seq} saved${photoNote}. Next: product ${seq + 1} of ${batchSize} — photos + price/notes, then *done*.`,
      );
      return;
    }

    // The last product gets the same one-line count as every other one.
    // Without this it is the ONE product whose photo total the seller never
    // hears — and for a single-product batch, that is every listing they
    // make. It costs one short message and replaces the several
    // intermediate confirmations the burst debounce removed.
    //
    // It leads the "drafting now" message rather than going on its own.
    await startBatchAnalysis(phoneNumber, userId, session, photoCount > 0 ? `✅ Product ${seq} saved${photoNote}.\n` : "");
    return;
  }

  // Free text (or a caption without a done-signal) = seller notes on this
  // product — the same free-text field the web flow threads through
  // auto-analyze as "SELLER CONTEXT" (e.g. "this is a pack of 6", "the
  // colour is teal not blue").
  if (listingId && content.imageMediaId) {
    // A captioned photo is part of the album like the plain ones: saved
    // without a reply of its own, and "done" names the notes along with
    // the photo count ("(3 photos, notes saved)").
    await applyNotes(listingId, text);
  } else if (listingId) {
    await applyNotes(listingId, text);
    await replyButtons(
      phoneNumber,
      `Got it — noted for product ${seq}. Send more photos, or reply *done* when ready.`,
      [{ id: "done", title: "Done ✅" }],
    );
  } else {
    // No photo yet for this product — "done" isn't a real option, so no
    // button; the seller still needs to send at least one photo first.
    // The note is parked so the photo that follows picks it up; saying
    // "noted" while throwing it away was the worst of both.
    await parkNotes(phoneNumber, session, text);
    await replyText(phoneNumber, `Got it — noted for product ${seq}. Send a photo to get started.`);
  }
}

/**
 * Reserve the hourly analyze quota for a set of products and check the
 * seller has the credits to list them, telling the seller about anything
 * that didn't fit, and return only the ones that may actually be drafted.
 *
 * Extracted so RETRY goes through the identical gate: without this, a
 * seller who ran out of credits or hit the hourly limit could simply tap
 * Retry to queue the drafts anyway, since the limiter and the credit
 * check are only consulted here. Two copies of this would have drifted; one copy makes
 * "retry costs exactly what the first attempt would have" true by
 * construction.
 */
async function reserveDraftCapacity(
  userId:      string,
  phoneNumber: string,
  batchId:     string,
  listings:    ListingRow[],
): Promise<ListingRow[]> {
  const withQuota: ListingRow[] = [];
  const overQuota: ListingRow[] = [];
  for (const listing of listings) {
    const limited = rateLimit(`auto-analyze:${userId}`, RATE_LIMITS.autoAnalyze.max, RATE_LIMITS.autoAnalyze.windowMs);
    (limited.success ? withQuota : overQuota).push(listing);
  }

  // Drafting is free — a listing is charged LIVE_LISTING_CREDIT_COST only
  // when it goes live on Jumia (lib/billing/extension-credits.ts) — but a
  // seller can only draft as many as their credits could list, less what
  // is already held for listings waiting on Jumia. Checked before anything
  // is queued so a seller who's run out finds out now, not at submit.
  const creditBalance = await availableCredits(userId);
  const affordableCount = Number.isFinite(creditBalance)
    ? Math.max(0, Math.floor(creditBalance / LIVE_LISTING_CREDIT_COST))
    : withQuota.length;
  const overCredit = withQuota.splice(affordableCount);

  // Sent now rather than held until the batch settles: "you're out of
  // credits for product 4" is a fact the moment it's known, and making a
  // seller wait several minutes to hear it would be worse, not better.
  for (const listing of overQuota) {
    // Retry is genuinely the right affordance here: once the hour rolls
    // over, tapping it re-queues exactly this product from the photos
    // already uploaded, with nothing to re-send.
    await replyError(
      phoneNumber,
      `⚠️ Product ${listing.whatsapp_seq}: hourly analyze limit reached — finish it once it resets.`,
      {
        retryId: `retry product ${listing.whatsapp_seq}`,
        cta:     { label: "Review listings", url: whatsappListingsUrl(batchId) },
      },
    );
  }
  for (const listing of overCredit) {
    // Same shape: top up, then tap Retry — no photo is re-sent.
    await replyError(
      phoneNumber,
      `⚠️ Product ${listing.whatsapp_seq}: not enough credits to list it (${LIVE_LISTING_CREDIT_COST} are charged when it goes live on Jumia). Top up, then tap Retry.`,
      {
        retryId: `retry product ${listing.whatsapp_seq}`,
        cta:     { label: "Buy credits", url: buyCreditsUrl() },
      },
    );
  }

  return withQuota;
}

/**
 * Fires once the LAST product's "done" arrives. Reserves quota and credits
 * for the whole batch, tells the seller what it can't draft and why, then
 * QUEUES the analyses and returns — see lib/whatsapp/analysis-queue.ts.
 *
 * It used to run every analysis inline, concurrently, right here. That
 * raced Vercel's hard 60s kill (one product measured 22.7s in production),
 * which is why the batch cap sat at 5 and why anything that missed the
 * soft deadline told the seller "still finishing" having produced nothing.
 * Queuing turns that hard failure into a longer wait: the webhook now
 * returns in well under a second no matter how large the batch, and
 * app/api/worker/analyze-jobs drains it a few products at a time.
 *
 * The session stays in "analyzing" until the worker settles the last job
 * and calls finalizeBatch — the seller's experience is unchanged, the work
 * just no longer happens inside their request.
 */
async function startBatchAnalysis(
  phoneNumber: string,
  userId: string,
  session: WhatsAppSession,
  /** A line to send first in the same message (the last product's photo count). */
  lead = "",
): Promise<void> {
  const batchId = session.batchId;
  const batchSize = session.batchSize ?? 1;
  if (!batchId) return;

  await updateSession(phoneNumber, { state: "analyzing" });
  await replyText(
    phoneNumber,
    lead +
    `🔎 Got everything for all ${batchSize} product${batchSize === 1 ? "" : "s"} — drafting them now. I'll update you as each one finishes…` +
    (batchSize >= BIG_BATCH_SIZE ? " This is a bigger batch, so it may take a little while." : ""),
  );

  // Still wrapped: a throw here would strand the seller in "analyzing",
  // where every message just gets "Still drafting" back. Much less can go
  // wrong now that this only reserves and enqueues, but the failure mode
  // it guards against is unchanged, so the guard stays.
  try {
    const listings = await getBatchListings(batchId);

    // Reserve rate-limit slots for the whole batch up front — cheap,
    // synchronous checks — so a seller without quota for all N finds out
    // before any (expensive) AI calls fire. Same per-user limit the web
    // app's Analyze button and the old single-product flow both used.
    const withQuota = await reserveDraftCapacity(userId, phoneNumber, batchId, listings);

    if (withQuota.length === 0) {
      // Nothing draftable — don't leave the seller in "analyzing" waiting
      // on a worker that has no work to do for them.
      await updateSession(phoneNumber, { state: "awaiting_confirmation" });
      await replyCta(
        phoneNumber,
        "Nothing left to draft in this batch right now.",
        "Review listings",
        whatsappListingsUrl(batchId),
      );
      return;
    }

    await enqueueAnalysisJobs({
      batchId,
      userId,
      phoneNumber,
      batchSize,
      listings: withQuota.map((l) => ({ listingId: l.id, seq: l.whatsapp_seq ?? null })),
    });

    // Start the work now rather than waiting up to a minute for the next
    // pg_cron tick — without this a 1-product draft that used to finish in
    // ~22s could take 80s, which reads as a regression. One worker per two
    // products (workersFor), and pg_cron remains the guarantee if a nudge
    // doesn't land.
    await nudgeWorker(workersFor(withQuota.length));
  } catch (e) {
    console.error(`[whatsapp intake] batch ${batchId} could not be queued: ${(e as Error).message}`);
    await updateSession(phoneNumber, { state: "awaiting_confirmation" });
    await replyError(
      phoneNumber,
      "⚠️ Something went wrong starting the drafts. Your photos are saved — tap Retry and I'll draft them from the ones you already sent.",
      { cta: { label: "Review listings", url: whatsappListingsUrl(batchId) } },
    );
  }
}

/**
 * Analyse ONE queued product and report it to the seller — the body that
 * used to live inside startBatchAnalysis's Promise.all, now called by
 * app/api/worker/analyze-jobs once per claimed job.
 *
 * Throws on failure so the worker can release the job for another attempt;
 * anything it has already told the seller is written to be safe to see
 * more than once.
 */
export async function runQueuedAnalysis(job: AnalysisJob): Promise<void> {
  const { phone_number: phoneNumber, seq, batch_size: batchSize, user_id: userId } = job;

  const db = createServerClient();
  const { data: listing } = await db
    .from("listings")
    .select("*")
    .eq("id", job.listing_id)
    .maybeSingle();

  if (!listing) {
    console.warn(`[whatsapp worker] listing ${job.listing_id} vanished before analysis`);
    return;
  }

  const result = await runAutoAnalyze(userId, job.listing_id, null);

  if (!result.ok) {
    await replyError(
      phoneNumber,
      `⚠️ Product ${seq} couldn't be drafted: ${result.message}`,
      {
        retryId: `retry product ${seq}`,
        cta:     { label: `Fix product ${seq}`, url: focusedEditorUrl(job.listing_id) },
      },
    );
    return;
  }

  // No live "✅ Product N drafted" message here for a multi-product batch
  // (batchSize > 1) — this used to fire the moment EVERY product finished,
  // which is most of where a real 20-product batch's ~108 bot messages
  // came from (2026-09-19 live batch, see the module doc comment above).
  // finalizeBatch now reports every product's Ready/Held status in ONE
  // summary once the whole batch settles, derived from the same
  // missingFieldsFor/noteWarningsFor this used to call per-product. A
  // 1-product batch still gets its single "drafted" message, but that one
  // comes from finalizeBatch too (batchSize === 1 branch) — there is
  // nothing to consolidate at that size, so no reason for two code paths.

  // Low-confidence category pick — surfaced right here in chat (for every
  // batch size) instead of only on a web confidence banner most
  // WhatsApp-only sellers never open.
  //
  // No percentage: the model's confidence is in its pick among the few
  // candidates it was shown, not in the category being right, so a
  // "100% confident" next to "not sure" (2026-10-01, a kids' tablet filed
  // under tablet cases) only confused. The seller can also type a category
  // that isn't on the buttons; category_unsure tells
  // handleDraftCategoryAnswer which draft a typed name is for.
  if (result.needsUserConfirmation) {
    await createServerClient().from("listings").update({ category_unsure: true }).eq("id", job.listing_id);
    const body =
      `🤔 Product ${seq}: I filed it under "${result.category.path}" but I'm not sure that's right. ` +
      (result.alternates.length > 0 ? "Tap the right category below. If it isn't there, send " : "If it's wrong, send ") +
      `"${seq} category:" and the category's name.`;
    if (result.alternates.length > 0) {
      await replyButtons(
        phoneNumber,
        body,
        result.alternates.slice(0, 3).map((alt) => ({
          id:    `category:${job.listing_id}:${alt.code}`,
          title: alt.name.slice(0, 20),
        })),
      );
    } else {
      await replyText(phoneNumber, body);
    }
  }

  // No charge here: the listing is charged when it goes live on Jumia
  // (chargeLiveListing, from refreshPendingFeedStatus).
}

/**
 * Ask, in chat, for the price of the next drafted product that hasn't got
 * one — and park that listing on the session so a bare "150" can be read
 * as its price.
 *
 * "No price" is the commonest reason a drafted product never reaches
 * Jumia. In a real 10-product session on 2026-09-15, five were blocked on
 * it; each one had photos, a title, a category and a brand, and each one
 * needed the seller to leave WhatsApp for the review page to type a single
 * number. Asking here closes that loop where they already are.
 *
 * Asks about ONE product at a time, chained: the answer to this question
 * carries the next one. A batch missing four prices therefore costs four
 * messages spread across the seller's replies, not four at once — message
 * volume right after drafting is already the busiest moment in the
 * conversation.
 *
 * `after` resumes the walk past a product the seller skipped, by position
 * rather than by product number, so a listing with no whatsapp_seq can't
 * make the walk ask about the same one forever. Returns false (and clears
 * the pointer) when there is nothing left to ask about, so the caller can
 * close the conversation off instead of leaving the seller mid-question.
 */
async function askForNextMissingPrice(
  phoneNumber: string,
  batchId:     string,
  /** `drafted`: the product's own "✅ Product drafted" lines, standing in
   *  for its name, so a single product's draft and its price question are
   *  one message (2026-10-03). */
  opts: { after?: string; prefix?: string; drafted?: string } = {},
): Promise<boolean> {
  const listings = await getBatchListings(batchId);
  // findIndex returning -1 lands on 0 — an id that isn't in this batch
  // restarts the walk rather than skipping the whole thing.
  const startAt = opts.after ? listings.findIndex((l) => l.id === opts.after) + 1 : 0;
  // A product with no title never drafted at all; its own failure message
  // already covers it, and a price would not make it submittable.
  const next = listings.slice(startAt).find((l) => l.title && !l.selling_price);

  if (!next) {
    await updateSession(phoneNumber, { awaitingPriceFor: null });
    return false;
  }

  await updateSession(phoneNumber, { awaitingPriceFor: next.id });

  const who = listings.length > 1 && next.whatsapp_seq != null
    ? `Product ${next.whatsapp_seq} — ${next.title}`
    : next.title;

  // The owner's format (2026-10-03): what's missing, then the one
  // question with an example amount, both bold, and the editor as the
  // other way to answer. No currency: the seller's own number is the
  // answer, whatever their country. Typing "skip" still moves on
  // (PRICE_SKIP_RE).
  const lead = opts.drafted ?? `💰 *${who}*\n⚠️ *needs price.*`;
  await replyCtaOrSplit(
    phoneNumber,
    `${opts.prefix ? `${opts.prefix}\n\n` : ""}${lead}\n\n*What price are you selling it at? Reply with just the amount (Eg. 1500)*`,
    "Or enter it here",
    focusedEditorUrl(next.id),
  );
  return true;
}

/** The "Skip for now" button's id, and the word a seller would type. */
const PRICE_SKIP_RE = /^skip( price)?[.!]?$/i;

/** The missing-value question's "Skip for now", and the words a seller would type. */
const VALUE_SKIP_RE = /^skip( value| for now| it)?[.!]?$/i;

/**
 * Ready vs Held, after filling what the bot can of any field the category
 * requires and the draft lacks (lib/whatsapp/missing-value.ts): a weight is
 * estimated, the rest only where the photos or notes show it. Whatever is
 * still missing is asked for by askForNextMissingValue.
 */
async function assessFillingMissing(userId: string, listingId: string): Promise<ListingReadinessResult> {
  const first = await assessListingPushReadiness(userId, listingId);
  if (first.ready || !first.missingFields?.length) return first;
  const filled = await autoFillMissingFields(userId, listingId, first.missingFields);
  return filled.length > 0 ? assessListingPushReadiness(userId, listingId) : first;
}

/**
 * Ask, in chat, for the next field a drafted product is held without —
 * live, 2026-10-01: "Product 1: ⚠️ Held — this category also needs Weight
 * (kg)" left the seller nothing to do in WhatsApp. One field at a time,
 * chained like the price question: the answer carries the next one.
 * Products still missing a price are left to askForNextMissingPrice.
 *
 * `known` holds missing fields already worked out (the batch summary has
 * them), so only products it doesn't cover are checked again. `from`
 * starts the walk at a product, `after` just past one (a skipped product).
 * Returns false (and clears the pointer) when nothing is left to ask.
 */
async function askForNextMissingValue(
  phoneNumber: string,
  batchId:     string,
  opts: {
    from?: string; after?: string; prefix?: string;
    known?: Map<string, JumiaCategoryAttribute[]>;
    /** Readiness reasons already worked out, to spot a variation block without asking Jumia again. */
    reasons?: Map<string, string[]>;
    /** Products whose submit Jumia's rules just stopped over their variation. */
    variationBlocked?: Set<string>;
    /** The answer sends the product straight back to Jumia (a stopped submit). */
    resubmit?: boolean;
  } = {},
): Promise<boolean> {
  const listings = await getBatchListings(batchId);
  const startAt = opts.from
    ? Math.max(0, listings.findIndex((l) => l.id === opts.from))
    : opts.after ? listings.findIndex((l) => l.id === opts.after) + 1 : 0;

  for (const l of listings.slice(startAt)) {
    if (!l.title || !l.selling_price || l.status !== "draft") continue;
    const who = listings.length > 1 && l.whatsapp_seq != null ? `Product ${l.whatsapp_seq} — ${l.title}` : (l.title as string);
    const asked = await askBlockingValue(phoneNumber, l, who, {
      prefix:           opts.prefix,
      known:            opts.known?.get(l.id),
      reasons:          opts.reasons?.get(l.id),
      variationBlocked: opts.variationBlocked?.has(l.id),
      resubmit:         opts.resubmit,
    });
    if (asked) return true;
  }

  await updateSession(phoneNumber, { awaitingValueFor: null });
  return false;
}

/** `prefix` then `body` as one interactive body, or the prefix first as text when together they're too long. */
async function prefixedBody(to: string, prefix: string | undefined, body: string): Promise<string> {
  const full = prefix ? `${prefix}\n\n${body}` : body;
  if (full.length <= INTERACTIVE_BODY_MAX) return full;
  if (prefix) await replyLongText(to, prefix);
  return body;
}

/**
 * Ask for the first value one product can't go to Jumia without: a field
 * its category requires, else its variation (lib/whatsapp/variation-
 * question.ts). False when it lacks neither. The full readiness check
 * reaches Jumia, so it only runs when a quick look says something may be
 * missing, unless the caller already knows.
 */
async function askBlockingValue(
  phoneNumber: string,
  l:           ListingRow,
  who:         string,
  opts: { prefix?: string; known?: JumiaCategoryAttribute[]; reasons?: string[]; variationBlocked?: boolean; resubmit?: boolean } = {},
): Promise<boolean> {
  const code = Number(l.category_code);
  const resubmit = opts.resubmit ? { resubmit: true } : {};
  let reasons = opts.reasons;
  let fields = opts.known;
  if (!fields) {
    const mayLack = (await getCategoryAttributes(code)).some((a) => a.required && !readAttributeValue(l, a.name).trim());
    if (mayLack) {
      const assessment = await assessListingPushReadiness(l.user_id as string, l.id).catch(() => null);
      fields = assessment?.missingFields ?? [];
      reasons ??= assessment?.reasons;
    }
  }

  const attr = fields?.[0];
  if (attr) {
    await updateSession(phoneNumber, { awaitingValueFor: { listingId: l.id, field: attr.name, ...resubmit } });
    const question = missingValueQuestion(attr, who);
    const body = await prefixedBody(phoneNumber, opts.prefix, question.body);
    if (question.options.length <= 3) {
      await replyButtons(phoneNumber, body, question.options);
    } else {
      await replyList(phoneNumber, body, "Choose", question.options);
    }
    return true;
  }

  const variationBlocked = opts.variationBlocked
    ?? (reasons
      ? reasons.some(isVariationBlock)
      : (await variationMayBlock(l.id, code))
        && ((await assessListingPushReadiness(l.user_id as string, l.id).catch(() => null))?.reasons ?? []).some(isVariationBlock));
  if (!variationBlocked) return false;

  await updateSession(phoneNumber, { awaitingValueFor: { listingId: l.id, field: VARIATION_FIELD, ...resubmit } });
  const body = await prefixedBody(phoneNumber, opts.prefix, variationQuestion(who, await variationOptions(code)));
  await replyCta(phoneNumber, body, "Pick in the editor", focusedEditorUrl(l.id));
  return true;
}

/**
 * The seller's reply to askForNextMissingValue: saved as that field, then
 * the next question (or Submit when nothing is left). False when the reply
 * isn't an answer at all, so the caller drops the pointer and handles it
 * as usual, the same rule the price question follows.
 */
async function answerMissingValue(
  userId:      string,
  phoneNumber: string,
  batchId:     string,
  batchSize:   number,
  question:    ValueQuestion,
  text:        string,
): Promise<boolean> {
  const submitAll = { id: "submit all", title: "Submit all ✅" };

  if (VALUE_SKIP_RE.test(text)) {
    const asked = await askForNextMissingValue(phoneNumber, batchId, { after: question.listingId, resubmit: question.resubmit });
    if (!asked) {
      await replyButtons(phoneNumber, "No problem — you can fill it in on the review page any time. Jumia won't accept the product without it.", [submitAll, START_ANOTHER]);
    }
    return true;
  }
  // An edit to a product ("2: change the price to 150") isn't an answer.
  if (/^\s*\d{1,2}\s*:\s*\S/.test(text)) return false;

  const db = createServerClient();
  const { data: row } = await db
    .from("listings")
    .select("id, user_id, whatsapp_seq, title, category_code")
    .eq("id", question.listingId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!row) return false;
  const label = batchSize > 1 && row.whatsapp_seq != null ? `product ${row.whatsapp_seq}` : ((row.title as string | null) ?? "your product");

  if (question.field === VARIATION_FIELD) {
    const options = await variationOptions(Number(row.category_code));
    const parsed = parseVariations(options, text);
    if (!parsed.ok) {
      // A sentence about something else isn't an answer: handled as usual.
      if (text.trim().split(/\s+/).length > 6) return false;
      const shown = options.length > 12 ? `${options.slice(0, 12).join(", ")} and ${options.length - 12} more` : options.join(", ");
      const named = parsed.unknown.map((u) => `"${u}"`).join(", ");
      await replyButtons(
        phoneNumber,
        `⚠️ ${named} ${parsed.unknown.length === 1 ? "isn't" : "aren't"} one of this category's options. Reply with one or more of: ${shown}.`,
        [{ id: "skip value", title: "Skip for now" }],
      );
      return true;
    }
    if (!(await saveVariations(question.listingId, parsed.values))) {
      await replyError(phoneNumber, "⚠️ I couldn't save that just now — send it again in a moment.");
      return true;
    }
    const set = `✅ Variation${parsed.values.length > 1 ? "s" : ""} set to ${parsed.values.join(", ")} for ${label}`;
    return finishValueAnswer(userId, phoneNumber, batchId, batchSize, row, question, set);
  }

  const attr = row.category_code
    ? (await getCategoryAttributes(Number(row.category_code))).find((a) => a.name === question.field)
    : undefined;
  if (!attr) return false;

  const parsed = parseMissingValue(attr, text);
  if (!parsed.ok) {
    await replyButtons(phoneNumber, `⚠️ ${parsed.hint}`, [{ id: "skip value", title: "Skip for now" }]);
    return true;
  }
  if (!(await saveMissingValue(question.listingId, attr, parsed.value, "user"))) {
    await replyError(phoneNumber, "⚠️ I couldn't save that just now — send it again in a moment.");
    return true;
  }
  const unit = columnFor(attr.name) === "weight_kg" ? " kg" : "";
  return finishValueAnswer(userId, phoneNumber, batchId, batchSize, row, question, `✅ ${attr.label || attr.name} set to ${parsed.value}${unit} for ${label}`);
}

/**
 * After a value is saved: a product whose submit Jumia's rules stopped goes
 * straight back once nothing else holds it, and the next stopped product
 * is asked about; otherwise the seller hears what's still missing, then
 * the next question, or gets Submit.
 */
async function finishValueAnswer(
  userId:      string,
  phoneNumber: string,
  batchId:     string,
  batchSize:   number,
  row:         { id: string; whatsapp_seq: number | null; title: string | null },
  question:    ValueQuestion,
  set:         string,
): Promise<boolean> {
  const submitAll = { id: "submit all", title: "Submit all ✅" };
  const assessment = await assessListingPushReadiness(userId, question.listingId);

  if (question.resubmit && assessment.ready) {
    await updateSession(phoneNumber, { awaitingValueFor: null });
    const label = row.whatsapp_seq != null ? `Product ${row.whatsapp_seq}` : (row.title ?? "Your product");
    await pushAndReport(userId, phoneNumber, question.listingId, label, { lead: `${set}.` });
    await askForNextMissingValue(phoneNumber, batchId, { after: question.listingId, resubmit: true });
    return true;
  }

  const otherReasons = assessment.missingFields?.length ? [] : assessment.reasons;
  const confirmation = assessment.ready
    ? `${set} — ready to submit.`
    : `${set}.` + (otherReasons.length > 0 ? `\n⚠️ Still held: ${heldReasonsText(otherReasons)}` : "");

  const asked = await askForNextMissingValue(phoneNumber, batchId, {
    from:     question.listingId,
    prefix:   confirmation,
    known:    new Map([[question.listingId, assessment.missingFields ?? []]]),
    reasons:  new Map([[question.listingId, assessment.reasons]]),
    resubmit: question.resubmit,
  });
  if (!asked) {
    const submit = batchSize > 1 && row.whatsapp_seq != null
      ? [{ id: `submit ${row.whatsapp_seq}`, title: `Submit product ${row.whatsapp_seq}` }, submitAll]
      : [{ id: "submit all", title: "Submit ✅" }];
    await replyButtons(phoneNumber, confirmation, assessment.ready ? submit : [submitAll, START_ANOTHER]);
  }
  return true;
}

/**
 * Save a price the seller sent in answer to askForNextMissingPrice, then
 * move the walk on to the next product missing one.
 *
 * Written straight to the column rather than through applyNotes: the
 * seller is answering a question about ONE field, and applyNotes would
 * also overwrite user_prompt with "150", losing the note their product was
 * actually drafted from.
 */
async function applyChatPrice(
  phoneNumber: string,
  batchId:     string,
  listingId:   string,
  price:       number,
): Promise<void> {
  const db = createServerClient();
  const { error } = await db
    .from("listings")
    .update({ selling_price: price, updated_at: new Date().toISOString() })
    .eq("id", listingId);

  if (error) {
    console.error(`[whatsapp intake] chat price for listing ${listingId} failed: ${error.message}`);
    // The pointer stays set on purpose — the seller answered correctly and
    // it was us that failed, so their next attempt should still be read as
    // a price rather than as chit-chat.
    await replyError(phoneNumber, "⚠️ I couldn't save that price just now — send the number again in a moment.");
    return;
  }

  const listings = await getBatchListings(batchId);
  const saved = listings.find((l) => l.id === listingId);
  const label = listings.length > 1 && saved?.whatsapp_seq != null
    ? `product ${saved.whatsapp_seq}`
    : (saved?.title ?? "your product");

  // Say what is STILL missing in the same breath. A seller who has just
  // answered the one question we asked will otherwise assume the product
  // is ready, and only find out at submit time that it isn't.
  const stillMissing = await missingFieldsFor(listingId);
  const shown = saved?.user_id ? await chatPrice(saved.user_id, price) : String(price);
  const confirmation = stillMissing.length === 0
    ? `✅ Price set to ${shown} for ${label} — ready to submit.`
    : `✅ Price set to ${shown} for ${label}.\n⚠️ Still needs: ${stillMissing.join(", ")} — tap *Edit product ${saved?.whatsapp_seq ?? ""}*.`.trimEnd();

  // The confirmation rides along with the next question rather than going
  // out as its own message — one send per answer, not two.
  const asked = await askForNextMissingPrice(phoneNumber, batchId, { prefix: confirmation })
    || await askForNextMissingValue(phoneNumber, batchId, { prefix: `${confirmation}\n\nThat's every price filled in.` });
  if (!asked) {
    await replyButtons(phoneNumber, `${confirmation}\n\nThat's every price filled in.`, [
      { id: "submit all", title: "Submit all ✅" },
      START_ANOTHER,
    ]);
  }
}

/**
 * Listings whose analysis job hit its retry cap without ever reaching
 * runQueuedAnalysis's own graceful failure reply.
 *
 * status='done' with no title already means runQueuedAnalysis got far
 * enough to call replyError itself before returning — that job is marked
 * done regardless of whether the draft it produced is usable, precisely
 * so finalizeBatch can tell "handled" apart from "never handled" here.
 * status='failed' is the OTHER kind: claim_analysis_jobs retired the job
 * itself after repeated crashes (a Vercel function-timeout kill, live and
 * confirmed, is silent at the platform level — no catch block, no
 * replyError, nothing runs), so nobody ever told the seller anything.
 */
async function hardFailedListingIds(batchId: string): Promise<Set<string>> {
  const db = createServerClient();
  const { data, error } = await db
    .from("analysis_jobs")
    .select("listing_id")
    .eq("batch_id", batchId)
    .eq("status", "failed");
  if (error) {
    console.warn(`[whatsapp intake] hard-failed lookup failed for batch ${batchId}: ${error.message}`);
    return new Set();
  }
  return new Set((data ?? []).map((r) => r.listing_id as string));
}

/**
 * Close out a batch once every job has settled — the tail of what used to
 * be startBatchAnalysis, called by the worker that finished the last job.
 *
 * Everything is derived from the database rather than accumulated in
 * memory, because the products are now analysed across several worker
 * ticks (and possibly several processes), so there is no single run to
 * collect state in.
 *
 * Assumes the caller already won claimBatchFinalization — that's what
 * moves the session out of "analyzing", and what guarantees only one
 * worker gets here per batch.
 */
/** Held reasons as one sentence: "a; b." Some reasons are already full
 *  sentences ending in "." (the prohibited-category one), which used to
 *  come out as "sent..". */
function heldReasonsText(reasons: string[]): string {
  return `${reasons.map((r) => r.trim().replace(/[.\s]+$/, "")).join("; ")}.`;
}

export async function finalizeBatch(
  batchId:     string,
  phoneNumber: string,
  batchSize:   number,
): Promise<void> {
  const listings = await getBatchListings(batchId);

  if (batchSize === 1) {
    const only = listings[0];
    if (only?.title) {
      // The single source of truth for Ready vs Held — see
      // lib/whatsapp/readiness.ts's doc comment for why this replaced a
      // bare missing-fields check: a listing can have every field filled
      // and still be something a real push would reject or silently
      // corrupt (a capacity Jumia needs whole, a variant value outside
      // the category's stocked options, ...). noteWarningsFor's sale-date
      // and variant-claim checks catch a case the payload builder can't
      // (zero variant rows despite a stated claim, so there's nothing for
      // it to validate against) — merged in alongside, not replaced. Its
      // softWarnings (wording that doesn't literally match, e.g. "Xtra
      // Large" against a drafted "XL") only count once the push itself
      // would NOT otherwise succeed — see NoteWarnings' doc comment.
      const [assessment, noteResult] = await Promise.all([
        assessFillingMissing(only.user_id as string, only.id),
        noteWarningsFor(only.id),
      ]);
      const reasons = [
        ...assessment.reasons,
        ...noteResult.warnings,
        ...(assessment.ready ? [] : noteResult.softWarnings),
      ];
      const ready = reasons.length === 0;
      const heldText = reasons.length > 0 ? `\n⚠️ ${heldReasonsText(reasons)}` : "";
      // A disconnected Jumia account can't be fixed by opening the editor —
      // "Edit product" would send the seller to a form with nothing wrong
      // on it. Offer Reconnect Jumia instead: the tap asks for whatever this
      // seller's connection needs (a new token, or a login) and keeps the
      // draft (promptReconnectKeepingBatch). One message, not two: Meta
      // charges per message the bot sends from 2026-10-01.
      if (assessment.needsReconnect) {
        const reconnect = "Jumia needs to be reconnected before it can go: tap *Reconnect Jumia*.";
        await replyButtons(
          phoneNumber,
          await fitInteractiveBody(phoneNumber, `✅ Product drafted: ${only.title}.${heldText}\n\n` + reconnect, reconnect),
          [RECONNECT_JUMIA_BUTTON],
        );
      } else if (ready) {
        const body =
          `✅ Product drafted: ${only.title}. Ready to submit!\n\n` +
          `Edit it here: ${focusedEditorUrl(only.id)}\n\n` +
          `Reply *submit*, or say something like "change the price to 150" to edit it first.`;
        const buttons = [{ id: "submit all", title: "Submit ✅" }, START_ANOTHER];
        if (body.length <= INTERACTIVE_BODY_MAX) {
          await replyButtons(phoneNumber, body, buttons);
        } else {
          await replyCta(phoneNumber, `✅ Product drafted: ${only.title}. Ready to submit!`, "Edit product", focusedEditorUrl(only.id));
          await replyButtons(phoneNumber, `Reply *submit*, or say something like "change the price to 150" to edit it first.`, buttons);
        }
      } else if (!only.selling_price) {
        // The draft and its price question as one message: "✅ Product
        // drafted… ⚠️ needs price… What price…?" Anything else it's held
        // for is asked once the price is in (applyChatPrice).
        await askForNextMissingPrice(phoneNumber, batchId, {
          drafted: `✅ Product drafted: ${only.title}.\n⚠️ *${heldReasonsText(reasons)}*`,
        });
        return;
      } else {
        // Never offer Submit on a Held product — confidence over optimism:
        // a seller should never be handed a button that would fail or ship
        // something other than what they typed. The editor is the action.
        const askable = (assessment.missingFields?.length ?? 0) > 0 || !only.selling_price || reasons.some(isVariationBlock);
        await replyCtaOrSplit(
          phoneNumber,
          `✅ Product drafted: ${only.title}.${heldText}\n\n` +
            (askable ? "Answer the question below, or fix it in the editor, then reply *submit*." : "Fix it in the editor, then reply *submit*."),
          "Edit product",
          focusedEditorUrl(only.id),
        );
      }
      // A missing price, then any other field the category requires, is
      // asked for right here rather than left as a warning: each is one
      // word the seller knows, and the editor was the only other way on.
      if (!(await askForNextMissingPrice(phoneNumber, batchId))) {
        await askForNextMissingValue(phoneNumber, batchId, {
          known:   new Map([[only.id, assessment.missingFields ?? []]]),
          reasons: new Map([[only.id, reasons]]),
        });
      }
      return;
    }
    // No title: runQueuedAnalysis's own graceful failure reply already
    // covered this UNLESS the job never got that far — a hard crash or a
    // platform timeout kill mid-analysis, silent by nature, is the one
    // case with nobody ever telling the seller anything went wrong.
    if (only && (await hardFailedListingIds(batchId)).has(only.id)) {
      const seq = only.whatsapp_seq ?? 1;
      await replyError(
        phoneNumber,
        `⚠️ Product couldn't be drafted after several tries — sorry about that. You can retry, or fill it in yourself.`,
        {
          retryId: `retry product ${seq}`,
          cta:     { label: `Fix product ${seq}`, url: focusedEditorUrl(only.id) },
        },
      );
    }
    return;
  }

  const drafted = listings
    .filter((l) => l.title && l.whatsapp_seq != null)
    .sort((a, b) => (a.whatsapp_seq as number) - (b.whatsapp_seq as number));

  // A hard failure gets its OWN bubble, per product — the batchSize===1
  // branch above already does this for a single product; this is the same
  // rule for a batch of several. The combined "Done drafting N of M"
  // headline further down still names every gap together, but a seller
  // needs THIS product's own Fix/Retry buttons, not just its number folded
  // into a list — and hardFailedListingIds is exactly the set that never
  // got runQueuedAnalysis's own graceful failure reply (a title-less
  // listing whose job status ISN'T 'failed' already got that reply, so is
  // deliberately left alone here — see hardFailedListingIds's doc comment).
  const notDrafted = listings.filter((l) => !l.title || l.whatsapp_seq == null);
  if (notDrafted.length > 0) {
    const hardFailed = await hardFailedListingIds(batchId);
    for (const l of notDrafted) {
      if (!hardFailed.has(l.id)) continue;
      const seq = l.whatsapp_seq ?? "?";
      await replyError(
        phoneNumber,
        `⚠️ Product ${seq} couldn't be drafted after several tries — sorry about that. You can retry, or fill it in yourself.`,
        {
          retryId: `retry product ${seq}`,
          cta:     { label: `Fix product ${seq}`, url: focusedEditorUrl(l.id) },
        },
      );
    }
  }

  // Ready vs Held for every drafted product, via the single "would this
  // push?" brain (lib/whatsapp/readiness.ts) — see its doc comment for why
  // a bare missing-fields check isn't enough. Concurrency-capped the same
  // way handleSubmit caps actual pushes below: a batch's worth of
  // simultaneous brand/schema lookups against Jumia would risk the same
  // "200 req/min, max 4 req/sec" ceiling a real submit already respects,
  // and most of a batch is typically still missing basic fields anyway —
  // assessListingPushReadiness only reaches Jumia once those are filled.
  const ASSESS_CONCURRENCY = 3;
  const assessments: { ready: boolean; reasons: string[]; needsReconnect?: boolean; missingFields?: JumiaCategoryAttribute[] }[] = new Array(drafted.length);
  {
    let cursor = 0;
    const assessWorker = async (): Promise<void> => {
      for (let i = cursor++; i < drafted.length; i = cursor++) {
        const l = drafted[i];
        let assessment: Awaited<ReturnType<typeof assessListingPushReadiness>>;
        let noteResult: NoteWarnings;
        try {
          [assessment, noteResult] = await Promise.all([
            assessFillingMissing(l.user_id as string, l.id),
            noteWarningsFor(l.id),
          ]);
        } catch (e) {
          // Never let an assessor crash read as Ready — staging 2026-09-22
          // canaries kept scoring ✅ Ready while capacity/size Holds should
          // have fired; degrading to Held on throw is the safe default.
          assessment = {
            ready: false,
            reasons: [`couldn't verify readiness (${(e as Error).message || "error"}) — open Edit before submitting`],
          };
          noteResult = { warnings: [], softWarnings: [] };
        }
        // noteWarningsFor catches a case the payload builder structurally
        // can't (zero variant rows despite a stated size/colour claim —
        // there is nothing for it to validate against) — merged in
        // alongside the assessor's own reasons, not replaced by them. Its
        // softWarnings only count once the push itself would NOT otherwise
        // succeed — see NoteWarnings' doc comment.
        const applicableSoft = assessment.ready ? [] : noteResult.softWarnings;
        assessments[i] = {
          ready:   assessment.ready && noteResult.warnings.length === 0 && applicableSoft.length === 0,
          reasons: [...assessment.reasons, ...noteResult.warnings, ...applicableSoft],
          needsReconnect: assessment.needsReconnect,
          missingFields:  assessment.missingFields,
        };
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(ASSESS_CONCURRENCY, drafted.length) }, assessWorker),
    );
  }

  const readyListings = drafted.filter((_, i) => assessments[i].ready);

  // ONE status line per drafted product — Ready, or Held with why —
  // replacing what used to be a separate live message the moment EACH one
  // finished (runQueuedAnalysis). Real 20-product batch, 2026-09-19: ~108
  // bot messages total, and this was most of them.
  let statusText = "";
  if (drafted.length > 0) {
    const statusLines = drafted.map((l, i) => {
      const { ready, reasons } = assessments[i];
      return ready
        ? `Product ${l.whatsapp_seq}: ✅ Ready — ${l.title}.`
        : `Product ${l.whatsapp_seq}: ⚠️ Held — ${heldReasonsText(reasons)}`;
    });
    // One product held on a disconnected Jumia account means every OTHER
    // product held for the same reason is fixed by the exact same step, so
    // it's said once under the status lines rather than per line. The
    // reply asks for whatever this seller's connection needs (a new token,
    // or a login) and keeps the batch (promptReconnectKeepingBatch).
    const anyNeedsReconnect = assessments.some((a) => a.needsReconnect);
    const reconnectFooter = anyNeedsReconnect
      ? "\n\n🔗 Jumia needs to be reconnected before these can go: reply *reconnect jumia*."
      : "";
    statusText = statusLines.join("\n") + reconnectFooter;
  }

  // Report what actually drafted, not what was promised — and not
  // conflated with Ready/Held, which is a separate axis (a product can
  // draft perfectly and still be Held pending a fix). A product whose
  // analysis failed for good has no title at all, so it's absent from
  // `drafted` here — but the closing line used to announce the full batch
  // size regardless, so a seller who asked for 4 and got 3 was
  // congratulated on 4 and left to notice the gap themselves. Worse, the
  // missing numbers are exactly the ones they need in order to ask for a
  // retry.
  const draftedSeqs = drafted.map((l) => l.whatsapp_seq as number);
  const draftedCount = draftedSeqs.length;
  const missingSeqs = Array.from({ length: batchSize }, (_, i) => i + 1)
    .filter((seq) => !draftedSeqs.includes(seq));

  // Points at *retry N*, not *restart*. They are not interchangeable:
  // retry re-drafts just the products that failed, on the photos already
  // sent; restart throws the whole batch away, including the products that
  // drafted perfectly well, and makes the seller send everything again.
  // Naming the numbers matters for the same reason — "retry 3" is only
  // usable if you know it was 3 that failed.
  const retryHint = missingSeqs.length === 1
    ? `reply *retry ${missingSeqs[0]}*`
    : `reply *retry ${missingSeqs[0]}* (and the same for ${missingSeqs.slice(1).join(", ")})`;

  const headline = missingSeqs.length === 0
    ? `🎉 Done drafting your ${batchSize} products!`
    : `Done drafting ${draftedCount} of your ${batchSize} products.\n` +
      `⚠️ ${missingSeqs.length === 1 ? "Product" : "Products"} ${missingSeqs.join(", ")} ` +
      `couldn't be drafted — ${retryHint} to try again on the photos you already sent.`;

  // The status lines, the closing line and the submit actions go out as
  // ONE message. They used to be three (the status lines, a "Submit a
  // specific product" buttons or list message, and the closing buttons);
  // Meta charges per message the bot sends from 2026-10-01. A Held product
  // never gets a Submit action — confidence over optimism: its status line
  // says what to fix, never a button that would fail or ship something
  // other than what the seller typed.
  //
  // Up to two ready products fit reply buttons ("Submit all" + one each),
  // which render inline. More go in a list, which holds ten rows in one
  // message: "Submit all", the products, and Start another. Status lines too long
  // for an interactive body (about a dozen products) go first as plain
  // text, and the buttons or list carry just the closing line.
  const closing = `${headline} Reply *submit all* when ready — or tell me a product number (e.g. *submit 2*) to submit just one.`;
  const body = [statusText, closing].filter(Boolean).join("\n\n");
  const submitAll = { id: "submit all", title: "Submit all ✅" };

  let statusSent = false;
  try {
    let actionBody = body;
    if (body.length > INTERACTIVE_BODY_MAX) {
      if (statusText) await replyLongText(phoneNumber, statusText);
      statusSent = true;
      actionBody = closing;
    }
    if (readyListings.length <= 2) {
      await replyButtons(
        phoneNumber,
        actionBody,
        readyListings.length === 2
          ? [submitAll, ...readyListings.map((l) => ({ id: `submit ${l.whatsapp_seq}`, title: `Submit product ${l.whatsapp_seq}` }))]
          : [submitAll, START_ANOTHER],
      );
    } else {
      // Rows past the ninth would overflow the list: "submit N" still works typed.
      await replyList(phoneNumber, actionBody, "Submit", [
        { id: "submit all", title: "Submit all ✅", description: `All ${readyListings.length} ready products` },
        ...readyListings.slice(0, LIST_MAX_ROWS - 2).map((l) => ({
          id:          `submit ${l.whatsapp_seq}`,
          title:       `Submit product ${l.whatsapp_seq}`,
          // The row's own subtitle — a product number alone tells a seller
          // nothing about which product it is.
          description: l.title as string,
        })),
        { ...START_ANOTHER, description: "List more products" },
      ]);
    }
  } catch (e) {
    // The seller must hear the batch is done whatever Meta makes of the
    // buttons: the closing line spells out every command as text. A failed
    // send here used to end the batch in silence, already marked finished
    // so nothing retried it (live, 2026-10-02).
    console.error(`[whatsapp intake] batch ${batchId} summary didn't send, sending it as text: ${(e as Error).message}`);
    await replyLongText(phoneNumber, statusSent ? closing : body);
  }

  if (!(await askForNextMissingPrice(phoneNumber, batchId))) {
    await askForNextMissingValue(phoneNumber, batchId, {
      known:   new Map(drafted.map((l, i) => [l.id, assessments[i].missingFields ?? []])),
      reasons: new Map(drafted.map((l, i) => [l.id, assessments[i].reasons])),
    });
  }
}

async function handleAwaitingBatchConfirmation(
  userId: string,
  phoneNumber: string,
  session: WhatsAppSession,
  content: { text?: string; imageMediaId?: string },
): Promise<void> {
  const batchId = session.batchId;
  const batchSize = session.batchSize ?? 1;
  const text = content.text?.trim();

  if (!batchId || !text) {
    await replyCta(
      phoneNumber,
      "Reply *submit all* to push your drafted listings to Jumia, or tell me the product number you want to submit.",
      "Review listings",
      whatsappListingsUrl(batchId ?? undefined),
    );
    return;
  }

  const submitCmd = parseSubmitCommand(text);
  if (submitCmd) {
    await handleSubmit(userId, phoneNumber, batchId, submitCmd);
    return;
  }

  // "Review listing(s)" button tap — reply-buttons can't open a URL
  // directly (only a standalone cta_url message can), so tapping this one
  // costs an extra round trip: we reply with the link as its own tappable
  // button. Checked before parseEditCommand so it can never be swallowed
  // by the batchSize===1 implicit-edit fallback (plain "review" contains
  // no action word, so looksActionable would reject it there anyway, but
  // handling it explicitly here is clearer than relying on that).
  if (/^review( listings?)?[.!]?$/i.test(text)) {
    await replyCta(phoneNumber, "Here's your batch:", "Review listings", whatsappListingsUrl(batchId));
    return;
  }

  // "Edit product" button tap for a specific listing — id is `edit:<uuid>`,
  // set when that listing was drafted (see startBatchAnalysis). Same
  // round-trip reasoning as "review" above: reply with the focused
  // editor's link as its own button rather than trying to open it directly.
  const editButtonMatch = text.match(/^edit:(.+)$/);
  if (editButtonMatch) {
    await replyCta(phoneNumber, "Here's the form for this product:", "Open editor", focusedEditorUrl(editButtonMatch[1]));
    return;
  }

  // An answer to askForNextMissingPrice's question. Sits below the button
  // ids above (none of which extractPrice can match) and above
  // parseEditCommand, which would otherwise swallow a bare number as an
  // edit instruction for a 1-product batch.
  //
  // Anything that ISN'T a price drops the pointer and carries on being
  // handled normally — the seller moving on is the answer "no". That keeps
  // the state self-correcting: there is no reply that can strand the
  // conversation waiting for a number.
  if (session.awaitingPriceFor) {
    const priceFor = session.awaitingPriceFor;
    const price = extractPrice(text, await shopCurrencyForUser(userId));
    if (price != null && price > 0) {
      await applyChatPrice(phoneNumber, batchId, priceFor, price);
      return;
    }
    if (PRICE_SKIP_RE.test(text)) {
      const asked = await askForNextMissingPrice(phoneNumber, batchId, { after: priceFor })
        || await askForNextMissingValue(phoneNumber, batchId);
      if (!asked) {
        await replyButtons(
          phoneNumber,
          "No problem — you can set prices on the review page any time. Jumia won't accept a product without one.",
          [
            { id: "submit all", title: "Submit all ✅" },
            START_ANOTHER,
          ],
        );
      }
      return;
    }
    await updateSession(phoneNumber, { awaitingPriceFor: null });
  }

  // An answer to askForNextMissingValue's question (a weight, or another
  // field the category requires). Same rule as the price: anything that
  // isn't an answer drops the pointer and is handled as usual.
  if (session.awaitingValueFor) {
    if (await answerMissingValue(userId, phoneNumber, batchId, batchSize, session.awaitingValueFor, text)) return;
    await updateSession(phoneNumber, { awaitingValueFor: null });
  }

  const editCmd = parseEditCommand(text, batchSize);
  // Only the explicit "N: text" form is unambiguous. needsSeq and the
  // batchSize===1 implicit-edit fallback both match ANY text at all
  // (confirmed live: "Hi", "New listing", "Done", "Delete" were all
  // getting treated as edit attempts for a 1-product batch) — gate those
  // on looksActionable so plain chit-chat falls through to the generic
  // help message (or the AI classifier below) instead of misfiring.
  if (editCmd?.needsSeq && looksActionable(text)) {
    await replyCta(
      phoneNumber,
      `Which product number is this for? e.g. "2: change the price to 150"`,
      "Review listings",
      whatsappListingsUrl(batchId),
    );
    return;
  }
  if (editCmd && !editCmd.needsSeq && (editCmd.explicit || looksActionable(text))) {
    await handleEdit(userId, phoneNumber, batchId, editCmd.seq, editCmd.text);
    return;
  }

  // Neither deterministic parser matched (or matched but didn't look
  // actionable) — try to understand what the seller actually meant before
  // falling back to a generic help message. Kept as a fallback (not the
  // primary path) so well-formed commands above stay fast, free, and
  // fully deterministic. looksActionable is a cheap pre-filter so an
  // off-topic reply ("thanks", "ok") never costs a Gemini call for
  // nothing.
  if (looksActionable(text)) {
    const listings = await getBatchListings(batchId);
    const intent = await classifyBatchIntent(text, listings.map((l) => ({ seq: l.whatsapp_seq ?? 0, title: l.title })));

    if (intent.type === "submit_all") {
      await handleSubmit(userId, phoneNumber, batchId, { all: true });
      return;
    }
    if (intent.type === "submit_specific") {
      await handleSubmit(userId, phoneNumber, batchId, { all: false, seqs: intent.seqs });
      return;
    }
    if (intent.type === "edit") {
      await handleEdit(userId, phoneNumber, batchId, intent.seq, intent.instruction);
      return;
    }
    if (intent.type === "restart") {
      await handleGlobalRestart(userId, phoneNumber);
      return;
    }
  }

  await replyCta(
    phoneNumber,
    `Reply *submit all* to push your drafted listings to Jumia, or tell me the product number you want to submit. You can also say "2: change the price to 150" to edit one.`,
    "Review listings",
    whatsappListingsUrl(batchId),
  );
}

async function handleSubmit(
  userId: string,
  phoneNumber: string,
  batchId: string,
  cmd: { all: true } | { all: false; seqs: number[] },
): Promise<void> {
  const listings = await getBatchListings(batchId);
  if (listings.length === 0) {
    // A batch that reached submission always has at least one listing —
    // an empty result here means the lookup itself failed (see
    // getBatchListings), not that the seller asked for the wrong number.
    await replyError(
      phoneNumber,
      `⚠️ I couldn't load this batch right now — tap Retry in a moment, or start a new one.`,
    );
    return;
  }

  const requested = cmd.all
    ? listings
    : listings.filter((l) => l.whatsapp_seq != null && cmd.seqs.includes(l.whatsapp_seq));

  if (requested.length === 0) {
    await replyError(
      phoneNumber,
      "I couldn't find those product numbers in this batch — check the review page and try again.",
      { retryId: "submit all", retryTitle: "Submit all ✅", cta: { label: "Review listings", url: whatsappListingsUrl(batchId) } },
    );
    return;
  }

  // Confirmed live: a seller submitted a product (→ pending_approval), then
  // replied "submit" again for the same one — pushListingToJumia had no
  // status check at all, so it silently treated the already-pending
  // listing exactly like a failed-retry, generated a NEW sku suffix, and
  // pushed it to Jumia a second time as a genuine duplicate product, with
  // nothing telling the seller it had already been submitted. "processing"
  // means a push for this exact listing is already in flight RIGHT NOW
  // (set by pushListingToJumia itself right before calling Jumia) — same
  // duplicate risk if a seller taps submit twice in quick succession.
  const ALREADY_SUBMITTED_STATUSES = new Set<ListingRow["status"]>(["pending_approval", "live", "processing"]);

  // Before deciding who's "already submitted", check any pending listing's
  // REAL current status against Jumia — it may have already resolved
  // (approved OR rejected) since it was last polled, and the once-daily
  // cron (app/api/cron/jumia-feeds — Vercel's Hobby plan caps cron
  // frequency to once a day) alone could leave that stale for up to 24h.
  // A pending listing that turns out to have been REJECTED must fall
  // through to the normal retry path below, not get reported as "already
  // submitted, don't resubmit" — only "still pending" or "now live" should.
  const refreshedStatuses = new Map<string, ListingRow["status"]>();
  const stillPending = requested.filter((l) => l.status === "pending_approval");
  if (stillPending.length > 0) {
    try {
      const { accessToken } = await getValidJumiaCredentials(userId);
      await Promise.all(
        stillPending.map(async (l) => {
          const { status } = await refreshPendingFeedStatus(accessToken, { id: l.id, status: l.status, jumia_ref: l.jumia_ref });
          if (status !== l.status) refreshedStatuses.set(l.id, status as ListingRow["status"]);
        }),
      );
    } catch {
      // Credentials unavailable right now — fall back to each listing's
      // last-known DB status; getValidJumiaCredentials below (for the
      // actual push) will surface the same problem properly if it's real.
    }
  }
  const effectiveStatus = (l: ListingRow): ListingRow["status"] => refreshedStatuses.get(l.id) ?? l.status;

  const targets = requested.filter((l) => !ALREADY_SUBMITTED_STATUSES.has(effectiveStatus(l)));
  const alreadySubmittedMessages = requested
    .filter((l) => ALREADY_SUBMITTED_STATUSES.has(effectiveStatus(l)))
    .map((l) => {
      const status = effectiveStatus(l);
      return `Product ${l.whatsapp_seq}: already ${STATUS_LABELS[status]?.toLowerCase() ?? status} — no need to resubmit.`;
    });

  if (targets.length === 0) {
    // Every requested product was already submitted — nothing to push.
    // Still never a dead end: check whether the WHOLE batch (not just what
    // was requested here) is done, same as the real-push path below.
    const refreshed = await getBatchListings(batchId);
    const allSubmitted = refreshed.every((l) => l.status !== "draft" && l.status !== "failed");
    if (allSubmitted) {
      await finishSubmittedBatch(phoneNumber, batchId);
      // The per-product lines go first as plain text when they're too long
      // to share the button message (sendBatchDoneMessage).
      await sendBatchDoneMessage(phoneNumber, alreadySubmittedMessages);
    } else {
      // Plain text first (a long list of "already submitted" lines can
      // exceed the interactive-message body cap), then a short, fixed-
      // length CTA so this never dead-ends either.
      await replyLongText(phoneNumber, alreadySubmittedMessages.join("\n"));
      await replyCta(phoneNumber, "Check what's left:", "Review listings", whatsappListingsUrl(batchId));
    }
    return;
  }

  // Warm up the Jumia token before fanning out. getValidJumiaCredentials
  // has no de-dup for concurrent refreshes — if the token were within its
  // 5-minute refresh window, N simultaneous pushListingToJumia calls below
  // could each try to refresh it at once, and a second refresh using an
  // already-rotated refresh_token can fail. One await here forces any
  // needed refresh to happen exactly once; every concurrent call after
  // sees the now-fresh token and skips its own refresh. Errors are
  // swallowed — pushListingToJumia below surfaces the same failure
  // per-listing either way.
  await getValidJumiaCredentials(userId).catch(() => {});

  try {
    // Pushed concurrently, not sequentially — a "submit all" on a large
    // batch doing N sequential Jumia calls could exceed this route's 60s
    // ceiling (see maxDuration in app/api/whatsapp/webhook/route.ts) and
    // leave a reply never sent. But NOT unbounded either: lib/jumia/api.ts's
    // own doc comment states Jumia's limit as "200 req/min, max 4 req/sec"
    // — confirmed a real risk, not just theoretical, since each push can be
    // 1-2 Jumia calls (an occasional live brand lookup that misses the
    // local jumia_brands cache, plus the create-feed call itself). Firing
    // all ≤20 pushes from a single "submit all" at once could burst well
    // past 4/sec and get some products 429-rejected, which would have
    // looked to the seller like an unexplained generic push failure on a
    // handful of otherwise-fine products. A capped worker pool (same
    // cursor-based shape as embedTextBatch in lib/ai/embeddings.ts) keeps
    // it comfortably under that ceiling while adding negligible wall-clock
    // time against SUBMIT_DEADLINE_MS.
    const PUSH_CONCURRENCY = 3;
    const messages: string[] = new Array(targets.length);
    // Products that did NOT reach Jumia. Collected rather than just
    // described, because a line of text is not an action: the seller needs
    // to be able to open the one that failed and fix it, and hunting for
    // the right product on the site is the step where they give up. reason
    // is carried alongside so the compiled follow-up message below can say
    // WHY each one needs a look, not just that it does.
    const notSent: { seq: number | null; listingId: string; title: string | null; reason: string }[] = [];
    // Held back for lack of credits: nothing to edit, so these get a Buy
    // credits button after the results instead of an editor link.
    let shortOfCredits = false;
    // Products Jumia couldn't take because the connection needs redoing:
    // one reconnect prompt after the results covers them all.
    let reconnectCount = 0;
    let cursor = 0;
    const pushWorker = async (): Promise<void> => {
      for (let i = cursor++; i < targets.length; i = cursor++) {
        const listing = targets[i];
        const seq = listing.whatsapp_seq;
        try {
          const result = await pushListingToJumia(userId, listing.id);
          if (result.ok) {
            // "submitted — pending Jumia review" is reserved for a listing
            // that genuinely reached Jumia and is now waiting on their
            // review. Nothing else may claim it.
            //
            // Anything Jumia did not receive as written is still named,
            // because a push that reports plain success while a value the
            // seller typed was dropped is the quiet failure this whole pass
            // is about — but it is phrased as what it is: the LISTING went,
            // one of its fields did not.
            messages[i] = result.adjustments?.length
              ? `Product ${seq}: ✅ submitted — pending Jumia review.\n` +
                `⚠️ The listing went, but ${result.adjustments.join("; ")}.`
              : `Product ${seq}: ✅ submitted — pending Jumia review.`;
          } else if (result.code === "already_submitted") {
            // Not a failure, and not the seller's mistake — they tapped
            // "Submit all" twice, or a webhook retry replayed it. Saying
            // "❌" here would send them chasing a problem that does not
            // exist, and the thing that WOULD be a problem (a duplicate
            // product on their storefront) is precisely what was just
            // prevented.
            messages[i] = `Product ${seq}: ℹ️ ${result.message}`;
          } else if (result.code === "validation") {
            notSent.push({ seq, listingId: listing.id, title: listing.title ?? null, reason: result.message });
            messages[i] = `Product ${seq}: ⚠️ Not submitted — ${result.message}`;
          } else if (result.code === "insufficient_credits") {
            shortOfCredits = true;
            messages[i] = `Product ${seq}: ⚠️ Not submitted — not enough credits (${LIVE_LISTING_CREDIT_COST} are charged when it goes live).`;
          } else if (result.needsReconnect) {
            reconnectCount++;
            messages[i] = `Product ${seq}: ⚠️ Not submitted — Jumia needs to be reconnected.`;
          } else {
            notSent.push({ seq, listingId: listing.id, title: listing.title ?? null, reason: result.message });
            messages[i] = `Product ${seq}: ❌ Not submitted — ${result.message}`;
          }
        } catch (e) {
          // One product's push throwing must never sink the rest of the
          // batch — every other worker still needs to keep going, or the
          // seller gets zero reply and no way to tell what happened (this
          // had no per-listing catch at all before).
          console.error(`[whatsapp intake] product ${seq} submit threw: ${(e as Error).message}`);
          notSent.push({ seq, listingId: listing.id, title: listing.title ?? null, reason: "something went wrong on our side" });
          messages[i] = `Product ${seq}: ❌ Not submitted — something went wrong on our side.`;
        }
      }
    };
    const pushWork = Promise.all(
      Array.from({ length: Math.min(PUSH_CONCURRENCY, targets.length) }, pushWorker),
    ).then(() => messages);

    // Race against SUBMIT_DEADLINE_MS (see its doc comment) rather than
    // just awaiting pushWork directly — same reasoning as
    // startBatchAnalysis's ANALYSIS_DEADLINE_MS race.
    const DEADLINE = Symbol("deadline");
    const deadline = new Promise<typeof DEADLINE>((resolve) => {
      setTimeout(() => resolve(DEADLINE), SUBMIT_DEADLINE_MS);
    });
    const raceResult = await Promise.race([pushWork, deadline]);

    if (raceResult === DEADLINE) {
      console.warn(`[whatsapp intake] batch ${batchId} submit hit the ${SUBMIT_DEADLINE_MS}ms soft deadline`);
      await replyCta(
        phoneNumber,
        `⏳ Submitting is taking longer than usual. Check the status of each product below — anything still processing will update shortly, and *submit all* is safe to try again for whatever didn't go through.`,
        "Review listings",
        whatsappListingsUrl(batchId),
      );
      return;
    }

    // Plain text, not replyButtons — a full batch's worth of per-product
    // result lines can run well past WhatsApp's ~1024-char interactive-
    // body cap (a plain text message allows far more), and a rejected
    // send here would look like "submitting failed" even though every
    // product actually went through.
    const resultLines = [...alreadySubmittedMessages, ...raceResult];

    // Jumia stopped accepting the connection. Reconnecting comes before
    // anything else here, and the batch is kept for straight after it
    // (promptReconnectKeepingBatch): a Self Authorization seller pastes a
    // new token, which the old login link could never take. Anything else
    // that went wrong shows again on the next Submit all.
    if (reconnectCount > 0) {
      const kind = await getJumiaConnectionKind(userId);
      if (kind !== "connected") {
        const nothingElse = reconnectCount === targets.length && alreadySubmittedMessages.length === 0;
        if (!nothingElse) await replyLongText(phoneNumber, resultLines.join("\n"));
        await promptReconnectKeepingBatch(
          userId, phoneNumber, kind,
          nothingElse ? "⚠️ Nothing was sent: Jumia needs to be reconnected first.\n\n" : "",
        );
        return;
      }
    }

    // Everything reached Jumia: the results and the sign-off go as one
    // message, not two (Meta charges per message the bot sends from
    // 2026-10-01).
    if (!shortOfCredits && notSent.length === 0) {
      const settled = await getBatchListings(batchId);
      if (settled.every((l) => l.status !== "draft" && l.status !== "failed")) {
        await finishSubmittedBatch(phoneNumber, batchId);
        await sendBatchDoneMessage(phoneNumber, resultLines);
        return;
      }
    }

    await replyLongText(phoneNumber, resultLines.join("\n"));

    if (shortOfCredits) {
      await replyCta(
        phoneNumber,
        `You only pay for listings that go live on Jumia: ${LIVE_LISTING_CREDIT_COST} credits each. Top up, then reply *submit all* to send the rest.`,
        "Buy credits",
        buyCreditsUrl(),
      );
    }

    // One tappable way back in per product that did not reach Jumia,
    // compiled into ONE message rather than a separate cta_url send per
    // product — a batch with several failures used to fan out into that
    // many near-identical bubbles, each carrying its own single button,
    // which read as several unrelated problems instead of one batch that
    // needs a few taps. A list row/button can't carry a URL directly
    // (only a standalone cta_url message can), so each one reuses the
    // `edit:<uuid>` id the "Edit product" tap already handles elsewhere in
    // this file — tapping it replies with the focused editor link as its
    // own follow-up button, same round trip "review" and the Held-product
    // edit flow already use.
    let askedForValue = false;
    if (notSent.length > 0) {
      const shortReason = (r: string) => r.length > 60 ? `${r.slice(0, 59)}…` : r;
      // Named, not just numbered: "Edit product 4" alone left the seller
      // working out which product 4 was.
      const named = (item: (typeof notSent)[number]) =>
        `Product ${item.seq}${item.title ? ` (${item.title.length > 50 ? `${item.title.slice(0, 49)}…` : item.title})` : ""}`;
      const body = notSent.length === 1
        ? `${named(notSent[0])} wasn't sent to Jumia: ${shortReason(notSent[0].reason)}`
        : [
            `${notSent.length} products weren't sent to Jumia:`,
            ...notSent.map((item) => `${named(item)}: ${shortReason(item.reason)}`),
          ].join("\n");

      // What the seller can answer in a word (a price, a field the category
      // requires, a variation from its stocked options) is asked for here,
      // one product at a time, as the price is; an answered value sends the
      // product straight back. Only what can't be answered gets Edit taps.
      askedForValue = await askForNextMissingPrice(phoneNumber, batchId, { prefix: body })
        || await askForNextMissingValue(phoneNumber, batchId, {
          prefix:           body,
          resubmit:         true,
          variationBlocked: new Set(notSent.filter((item) => isVariationBlock(item.reason)).map((item) => item.listingId)),
        });
      if (askedForValue) {
        // Asked; the Edit taps below would only repeat it.
      } else if (notSent.length <= 3) {
        await replyButtons(
          phoneNumber,
          body,
          notSent.map((item) => ({ id: `edit:${item.listingId}`, title: `Edit product ${item.seq}`.slice(0, 20) })),
        );
      } else {
        const firstBody = await fitInteractiveBody(phoneNumber, body, "Tap a product to fix it:");
        for (let idx = 0; idx < notSent.length; idx += LIST_MAX_ROWS) {
          const chunk = notSent.slice(idx, idx + LIST_MAX_ROWS);
          await replyList(
            phoneNumber,
            idx === 0 ? firstBody : "…and the rest:",
            "Pick a product",
            chunk.map((item) => ({
              id:    `edit:${item.listingId}`,
              title: `Edit product ${item.seq}`,
              description: item.title ?? shortReason(item.reason),
            })),
          );
        }
      }
    }

    const refreshed = await getBatchListings(batchId);
    const allSubmitted = refreshed.every((l) => l.status !== "draft" && l.status !== "failed");
    if (allSubmitted) {
      await finishSubmittedBatch(phoneNumber, batchId);
      await sendBatchDoneMessage(phoneNumber);
    } else if (!askedForValue) {
      // Still stuff left in this batch — never leave the seller to guess
      // the next command from the result text alone. Short, fixed body
      // here (not the result text) so this one's always well under the
      // button-message length limit.
      //
      // This message fires ONLY when something did not go through, so it
      // names the actual next step rather than asking an open question:
      // the Edit buttons are already sitting above it, one per unsent
      // product, and Submit all is the button right underneath.
      await replyButtons(
        phoneNumber,
        "What's next?\nEdit to fix all un-submitted products and tap *Submit all*.",
        [
          { id: "submit all", title: "Submit all ✅" },
          START_ANOTHER,
        ],
      );
    }
  } catch (e) {
    console.error(`[whatsapp intake] handleSubmit failed for batch ${batchId}: ${(e as Error).message}`);
    // The failed step was the PUSH, not the drafting — so Retry here has
    // to mean "submit again", not "re-draft". Everything is already
    // drafted at this point; re-analysing would cost credits for nothing.
    await replyError(
      phoneNumber,
      `⚠️ Something went wrong while submitting. Check what's there below, then try again.`,
      { retryId: "submit all", retryTitle: "Submit all ✅", cta: { label: "Review listings", url: whatsappListingsUrl(batchId) } },
    );
  }
}

/**
 * Reached from both parseEditCommand's deterministic "N: text" pattern and
 * classifyBatchIntent's AI-fallback {type:"edit"} guess. Deliberately does
 * NOT re-run AI analysis on editText anymore — that used to call
 * runAutoAnalyze(userId, listing.id, editText) here, which was slow (a full
 * Gemini pass), imprecise (asking the AI to guess which field a free-form
 * instruction meant), and cost a real API call for what's often a one-field
 * change. Any explicit price/stock in the text is still applied instantly
 * (cheap, deterministic, unchanged) — everything else gets pointed at the
 * focused single-product editor instead, where the seller can change the
 * exact field they meant directly.
 */
async function handleEdit(
  userId: string,
  phoneNumber: string,
  batchId: string,
  seq: number,
  editText: string,
): Promise<void> {
  const listings = await getBatchListings(batchId);
  if (listings.length === 0) {
    await replyError(
      phoneNumber,
      `⚠️ I couldn't load this batch right now — tap Retry in a moment, or start a new one.`,
    );
    return;
  }

  const listing = listings.find((l) => l.whatsapp_seq === seq);
  if (!listing) {
    await replyError(
      phoneNumber,
      `I don't see product ${seq} in this batch — check the review page.`,
      { cta: { label: "Review listings", url: whatsappListingsUrl(batchId) } },
    );
    return;
  }

  const db = createServerClient();
  const currency = await shopCurrencyForUser(userId);
  const price = extractPrice(editText, currency);
  const stock = extractStock(editText);
  const sale  = extractSalePrice(editText, new Date(), currency);
  // Jumia requires the sale price AND both dates together ("The Global
  // StartAt and EndAt are mandatory when Sale Price is filled") — only
  // apply it when the seller gave all three in this one message; a price
  // stated alone used to get saved anyway and silently fail to reach Jumia
  // much later at push time with no explanation.
  const saleComplete = sale != null && !!sale.startDate && !!sale.endDate;
  const applied: string[] = [];
  if (price != null) { applied.push(`price to ${await chatPrice(userId, price)}`); }
  if (stock != null) { applied.push(`stock to ${stock}`); }
  if (saleComplete) { applied.push(`sale price to ${await chatPrice(userId, sale!.salePrice)} with dates`); }
  if (applied.length > 0) {
    await db
      .from("listings")
      .update({
        ...(price != null ? { selling_price: price } : {}),
        ...(stock != null ? { quantity: stock } : {}),
        // Listing-level fallback every variant resolves to when it has no
        // sale price of its own — see applyNotes's identical comment.
        ...(saleComplete ? {
          sale_price:      sale!.salePrice,
          sale_start_date: sale!.startDate,
          sale_end_date:   sale!.endDate,
        } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", listing.id);
  }

  let ack = applied.length > 0 ? `✅ Updated product ${seq}'s ${applied.join(" and ")}. ` : "";
  if (sale != null && !saleComplete) {
    ack += `I didn't set the sale price of ${await chatPrice(userId, sale.salePrice)} — Jumia needs a start AND end date with it. Tell me both together (e.g. "sale 80 from 20 Sept to 30 Sept") and I'll set it. `;
  }
  await replyCta(
    phoneNumber,
    `${ack}For anything else, edit product ${seq} here:`,
    "Edit product",
    focusedEditorUrl(listing.id),
  );
}

/**
 * Reached from tapping an alternate-category button on the low-confidence
 * prompt startBatchAnalysis sends (id `category:<listingId>:<code>`).
 * Runs refillAttributesForCategory — the exact pipeline the web editor's
 * category drawer uses (validate the category, ensure its attribute
 * schema is cached, run Gemini to fill it, persist) — so switching to the
 * right category and getting a filled-in listing back happens in one tap,
 * without needing the focused editor for the common case.
 */
/**
 * Turns a Jumia rejection into extra context for a full re-draft, so the
 * rerun doesn't just regenerate the identical mistake. Combined with the
 * seller's own original note — a fresh draft must not lose what they said
 * about the product just because it's also being told what went wrong.
 *
 * Deliberately hint-based rather than a rewrite of the AI pipeline: this
 * is free text fed into userContext, which lib/actions/auto-analyze.ts
 * already threads into the department-pick, category-rank and attribute
 * passes (that's how a seller's own "this is a pack of 6" note already
 * steers a draft) — so a plain instruction here reaches every pass that
 * could act on it, with no new plumbing.
 */
/**
 * Undoes buildRerunContext's own wrapping. Without this, a listing
 * rejected on two rerun cycles in a row had EACH rejection's "Jumia
 * rejected the previous draft: ..." text nested inside the next one's
 * "seller's own notes" section, since the listing's persisted user_prompt
 * (see runAutoAnalyze's userPromptOverride persistence) is exactly what
 * the NEXT rerun reads back as "originalNote". Two effects, both bad: the
 * seller's actual original note gets pushed out of the 1000-char budget a
 * little further each cycle, and the note-intent pass then reads Jumia's
 * OWN rejection prose as if the seller had typed it — confirmed live,
 * 2026-09-20: "material_family] Is Not Visible For Category" landed in
 * the main_material field, extracted word-for-word out of a previous
 * rejection message a rerun had nested into the note.
 */
function unwrapRerunContext(note: string | null): string | null {
  if (!note) return note;
  const marker = `The seller's own notes about this product: "`;
  const idx = note.indexOf(marker);
  if (idx === -1) {
    // Pure synthetic commentary with no real note ever attached (the
    // originalNote-less branch below) — nothing genuine to recover.
    return /^Jumia rejected the previous draft:/.test(note) ? null : note;
  }
  // Not anchored on a closing quote — buildRerunContext truncates to
  // 1000 chars, which can (and did, live) cut the string off mid-word
  // before the closing quote ever appears.
  const inner = note.slice(idx + marker.length).replace(/"$/, "");
  return unwrapRerunContext(inner);
}

function buildRerunContext(
  rejectionText: string,
  categoryPath:  string | null,
  originalNote:  string | null,
): string {
  originalNote = unwrapRerunContext(originalNote);
  const lower = rejectionText.toLowerCase();
  const hints: string[] = [];

  if (/can'?t list products in this category|more specific|leaf|category not found|attribute set not found/.test(lower)) {
    hints.push(
      categoryPath
        ? `Pick a category OTHER than "${categoryPath}" this time — Jumia said it isn't specific/listable enough. Choose a more specific leaf category.`
        : `Pick a more specific leaf category this time — the previous one wasn't specific/listable enough.`,
    );
  }
  if (/product name.{0,40}(contains|has).{0,10}(brand|seller|company) name|prohibited character/.test(lower)) {
    hints.push(`The title must NOT repeat the brand, seller, or company name, and must avoid blocked characters — write a clean, descriptive title instead.`);
  }
  if (/trademark/.test(lower)) {
    hints.push(`Set the brand field to the actual trademark owner mentioned in the title/description, or reword to remove the trademarked term.`);
  }
  if (/description/.test(lower) && /(short|50|length|characters)/.test(lower)) {
    hints.push(`Write a description of at least 50 characters.`);
  }
  const restricted = rejectionText.match(/restricted words\s*:?\s*\[([^\]]+)\]/i);
  if (restricted) {
    hints.push(`Do not use the word(s) "${restricted[1]}" anywhere in the listing.`);
  }

  const problem = `Jumia rejected the previous draft: "${rejectionText}".${hints.length ? " " + hints.join(" ") : ""}`;
  const combined = originalNote
    ? `${problem}\n\nThe seller's own notes about this product: "${originalNote}"`
    : problem;
  return combined.slice(0, 1000);
}

/**
 * "Fix & resubmit" on a Jumia rejection.
 *
 * A rejection used to be a dead end: the seller got Jumia's own wording
 * ("The column [product_weight] is missing from the file") and was left to
 * translate that into an action. Most rejections fall into a few shapes,
 * and most of them the system can genuinely repair by re-running the same
 * pipeline that drafted the listing in the first place (runAutoAnalyze),
 * with the rejection folded into its context so it doesn't just regenerate
 * the identical mistake — a bad title, an over-broad category, a short
 * description, or an invalid attribute value are all things a fresh draft
 * re-derives from scratch. This replaces the old attribute-only refill,
 * which could never touch a title or a category and so had to hand those
 * cases straight to the seller even though a redraft was fully capable.
 *
 * Deliberately honest about what's left. A price Jumia is missing is a
 * price only the seller has; claiming to have fixed it and re-pushing the
 * same payload would fail identically and waste their time. Those causes
 * are named and handed back with the editor link — see
 * classifyJumiaRejection's own doc comment for exactly which ones.
 */
async function handleFixAndResubmit(
  userId:      string,
  phoneNumber: string,
  listingId:   string,
  opts:        { qcDetailsGiven?: boolean } = {},
): Promise<void> {
  const db = createServerClient();
  const { data: row } = await db
    .from("listings")
    .select("id, whatsapp_seq, title, status, brand, field_sources, field_confidence, jumia_error, category_code, category_path, category_alternates, user_prompt, jumia_rerun_fingerprint, jumia_rerun_count, jumia_qc_status, jumia_qc_reason, jumia_qc_comment")
    .eq("id", listingId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!row) {
    await replyError(phoneNumber, "⚠️ I couldn't find that product — it may have been removed.");
    return;
  }

  const label = row.whatsapp_seq != null ? `Product ${row.whatsapp_seq}` : (row.title as string | null) ?? "That product";

  // A tap with nothing to fix — e.g. the seller tapped a LIVE row in the
  // "Pick a product" list notifyBatchResolved sends when several products
  // resolve in one tick (lib/jumia/push-listing.ts), which puts every
  // item — live or rejected — behind the same fix:<listingId> id rather
  // than inventing a second tap behaviour to explain. Without this,
  // extractRejectionText(null) => "" => classifyJumiaRejection("") =>
  // kind: "unknown" => isAutoFixable === true, which would happily
  // redraft-and-repush a product Jumia already approved.
  if (!row.jumia_error) {
    await replyText(
      phoneNumber,
      row.status === "live"
        ? `✅ ${label} is already live on Jumia — nothing to fix.`
        : `${label} hasn't been rejected by Jumia — nothing to fix here yet.`,
    );
    return;
  }

  // Anything the seller alone can supply blocks the push regardless of
  // what Jumia complained about — check it before spending an AI call.
  const missing = await missingFieldsFor(listingId);
  if (missing.length > 0) {
    await replyError(
      phoneNumber,
      `⚠️ ${label} still needs ${missing.join(" and ")} before Jumia will take it — that part only you can fill in.`,
      { retryId: `fix:${listingId}`, retryTitle: "Fix & resubmit", cta: { label: "Open editor", url: focusedEditorUrl(listingId) } },
    );
    return;
  }

  // Cleaned to plain text once, up front — jumia_error is a JSON blob most
  // of the time, and both the classifier and the rerun context below want
  // the human-readable form, not a string full of braces and quotes.
  const rejectionText = extractRejectionText(row.jumia_error as string | null);

  // A brand Jumia (or our own restricted-brand list) won't allow for this
  // category has exactly one always-safe answer: Jumia's own Generic/
  // Fashion placeholder brand (see BRAND_GENERIC_* in lib/jumia/api.ts,
  // already used as resolveBrand's own last-resort fallback) — there is
  // nothing for a redraft to guess at, and guessing risks the AI
  // confidently re-picking the identical brand from the same photos next
  // time, repeating the identical block forever. Checked directly against
  // the live restricted-brand list rather than by pattern-matching stored
  // text, so this also catches the case where the push never reached
  // Jumia at all — assertListingReady's own "forbidden" block never
  // leaves a Jumia-side rejection to match against, unlike a genuine
  // remote "not allowed to sell this brand" response.
  const brandRestricted =
    checkRestrictedBrand(row.brand as string | null, row.category_path as string | null).status === "forbidden" ||
    /not allowed to sell this brand/i.test(rejectionText);

  if (brandRestricted) {
    const fallbackBrand = isFashionCategory(row.category_path as string | null) ? "Fashion" : "Generic";
    await db.from("listings").update({
      brand: fallbackBrand,
      // Marked "user" so a LATER, unrelated redraft never confidently
      // re-detects and reinstates the same restricted brand from the
      // original photos — same reasoning note-assertion corrections use
      // for a value that must not be silently overwritten again.
      field_sources: { ...(row.field_sources as Record<string, string> | null), brand: "user" },
      field_confidence: { ...(row.field_confidence as Record<string, unknown> | null), brand: { confidence: 1, source: "seller-required" } },
      updated_at: new Date().toISOString(),
    }).eq("id", listingId);
    await replyText(phoneNumber, `🔧 ${label}: "${row.brand}" isn't a brand Jumia will list here, so I switched it to "${fallbackBrand}". Resubmitting…`);
    await pushAndReport(userId, phoneNumber, listingId, label);
    return;
  }

  // Rejected by Jumia's quality check after the upload went through
  // (lib/jumia/qc-followup.ts). Decided by lib/jumia/qc-remedy.ts: the
  // upload-error classifier below reads every QC reason as "unknown".
  // Only a redraft comes back here, to go through the rerun path and its
  // loop guard like any other.
  let remedy: Remedy;
  if (row.jumia_qc_status === "rejected") {
    const next = await fixQcRejection(userId, phoneNumber, row, label, rejectionText, { noDetailsAsk: opts.qcDetailsGiven });
    if (!next) return;
    remedy = next;
  } else {
    remedy = classifyJumiaRejection(rejectionText);
  }

  // Jumia refused the variation itself (not one of the category's stocked
  // options): ask for it, as a stopped submit does, rather than redraft a
  // guess or send the seller to the editor. The answer resubmits.
  if (row.jumia_qc_status !== "rejected" && /attribute\s*\[\s*variation\s*\]|stocked options/i.test(rejectionText)) {
    const { data: full } = await db.from("listings").select("*").eq("id", listingId).eq("user_id", userId).maybeSingle();
    if (full) {
      const who = row.whatsapp_seq != null ? `Product ${row.whatsapp_seq} — ${row.title}` : ((row.title as string | null) ?? label);
      const asked = await askBlockingValue(phoneNumber, full as ListingRow, who, {
        prefix:           `⚠️ ${label}: Jumia won't take its variation.`,
        variationBlocked: true,
        resubmit:         true,
      });
      if (asked) return;
    }
  }

  if (!isAutoFixable(remedy.kind)) {
    await replyError(
      phoneNumber,
      `⚠️ ${label}: ${remedy.explanation} That one needs you — open the editor and I'll resubmit once it's sorted.`,
      { retryId: `fix:${listingId}`, retryTitle: "Fix & resubmit", cta: { label: "Open editor", url: focusedEditorUrl(listingId) } },
    );
    return;
  }

  const sellerPicked = (row.field_sources as Record<string, string> | null)?.category_code === "user";

  // Jumia refused the category: the seller is asked for the right one
  // straight away, not after a redraft that guesses again (owner's
  // request, 2026-10-03). They can see what Vendor Center accepts; the
  // question offers categories not refused in their country and says how
  // to find one on their country's Jumia site.
  if (isUnlistableCategoryError(rejectionText)) {
    await askRefusedCategory(userId, phoneNumber, row, label);
    return;
  }

  // A stale category code needs a fresh pick even if the seller chose it,
  // so the redraft below is allowed to re-pick rather than keep it.
  if (sellerPicked && isStaleCategoryError(rejectionText)) {
    const sources = { ...(row.field_sources as Record<string, string>) };
    delete sources.category_code;
    await db.from("listings").update({ field_sources: sources }).eq("id", listingId);
  }

  // Cap automatic repair to one attempt per rejection shape. Real
  // production loop (2026-09-17/18): a category rejection kept getting
  // redrafted and resubmitted into the identical rejection, repeatedly,
  // for over an hour, with no message ever telling the seller it wasn't
  // working. See shouldBlockRepeatedAutoFix's doc comment.
  const fingerprint = rejectionFingerprint(remedy.kind, rejectionText);
  const prior = {
    fingerprint: (row.jumia_rerun_fingerprint as string | null) ?? null,
    count:       (row.jumia_rerun_count as number | null) ?? 0,
  };
  if (shouldBlockRepeatedAutoFix(remedy.kind, fingerprint, prior)) {
    await db.from("listings").update({
      jumia_rerun_fingerprint: null,
      jumia_rerun_count:       0,
      updated_at:              new Date().toISOString(),
    }).eq("id", listingId);

    await replyError(
      phoneNumber,
      `⚠️ ${label}: I already tried fixing this automatically once and Jumia rejected it the same way again — ${remedy.explanation} This one needs you now: open the editor, sort it out, and I'll resubmit once it's ready.`,
      { retryId: `fix:${listingId}`, retryTitle: "Fix & resubmit", cta: { label: "Open editor", url: focusedEditorUrl(listingId) } },
    );
    return;
  }
  await db.from("listings").update({
    jumia_rerun_fingerprint: fingerprint,
    jumia_rerun_count:       prior.fingerprint === fingerprint ? prior.count + 1 : 1,
    updated_at:              new Date().toISOString(),
  }).eq("id", listingId);

  await replyText(
    phoneNumber,
    remedy.kind === "restricted_words" ? `🔧 ${label}: ${remedy.explanation}` : `🔧 ${label}:\nFixing and resubmitting…`,
  );

  // A banned word Jumia named: record it (logFeedOutcome normally has
  // already) so the pre-push check strips it, and push again. A redraft
  // can't be relied on here: the AI wrote the phrase in the first place.
  if (remedy.kind === "restricted_words") {
    await rememberRestrictedWords(restrictedWordsInJumiaRejection(rejectionText), rejectionText);
    await pushAndReport(userId, phoneNumber, listingId, label);
    return;
  }

  // A "not visible for category" rejection means OUR cached schema is
  // wrong, not the listing — no redraft can fix an attribute that was
  // never usable for this category to begin with. Remove exactly the
  // attributes Jumia named from the cache and push again unchanged;
  // preflightAttributes (lib/jumia/preflight.ts) already drops anything
  // not in the schema, so the corrected cache is enough on its own.
  if (remedy.kind === "not_visible_attributes") {
    const categoryCode = row.category_code ? parseInt(row.category_code as string, 10) : NaN;
    const names = extractNotVisibleAttributeNames(rejectionText);
    if (categoryCode && names.length > 0) {
      await removeAttributesFromCache(categoryCode, names);
    }
    await pushAndReport(userId, phoneNumber, listingId, label);
    return;
  }

  // Re-draft before re-pushing. Skipped only for a pure duplicate-SKU
  // rejection, where the payload was fine and the push path generates a
  // fresh suffix on its own — an AI call there would cost a credit to
  // change nothing. "unknown" still gets a rerun: it's already the
  // "worth one automatic attempt" bucket, and a full redraft is a more
  // capable attempt than the old attribute-only refill ever was.
  if (remedy.kind !== "repush") {
    try {
      const trueOriginalNote = unwrapRerunContext((row.user_prompt as string | null) ?? null);
      const rerunContext = buildRerunContext(
        rejectionText,
        row.category_path as string | null,
        trueOriginalNote,
      );
      const result = await runAutoAnalyze(userId, listingId, rerunContext);
      if (!result.ok) {
        await replyError(
          phoneNumber,
          `⚠️ ${label}: couldn't redraft it (${result.message}).`,
          { retryId: `fix:${listingId}`, retryTitle: "Fix & resubmit", cta: { label: "Open editor", url: focusedEditorUrl(listingId) } },
        );
        return;
      }
      // runAutoAnalyze persists whatever userPromptOverride it's given
      // into listings.user_prompt (so a seller's own free-text edit is
      // remembered for next time) — here that override was our own
      // synthetic "Jumia rejected..." commentary, not anything the seller
      // said. Restore the real note so the NEXT rerun (or anywhere
      // user_prompt is shown back to the seller) sees what they actually
      // wrote, not our diagnostic text nested inside it.
      await db.from("listings").update({ user_prompt: trueOriginalNote }).eq("id", listingId);
    } catch (e) {
      console.error(`[whatsapp intake] fix-and-resubmit rerun failed for ${listingId}: ${(e as Error).message}`);
      await replyError(
        phoneNumber,
        `⚠️ ${label}: something went wrong while fixing it.`,
        { retryId: `fix:${listingId}`, retryTitle: "Fix & resubmit", cta: { label: "Open editor", url: focusedEditorUrl(listingId) } },
      );
      return;
    }
  }

  await pushAndReport(userId, phoneNumber, listingId, label);
}

/** Push a listing and reply with the outcome — shared tail of every
 *  "Fix & resubmit" path, deterministic or redrafted. */
async function pushAndReport(
  userId:      string,
  phoneNumber: string,
  listingId:   string,
  label:       string,
  /** `lead`: a line said first in the same message ("✅ Variation set to 100ml…"). */
  opts: { lead?: string } = {},
): Promise<void> {
  const result = await pushListingToJumia(userId, listingId);
  const lead = opts.lead ? `${opts.lead}\n` : "";

  if (result.ok) {
    const text = result.adjustments?.length
      ? `${lead}✅ ${label}: resubmitted — pending Jumia review.\n⚠️ ${result.adjustments.join("; ")}.`
      : `${lead}✅ ${label}: resubmitted — pending Jumia review.`;
    // The last product of the chat's batch to go finishes that batch.
    const session = await getOrCreateSession(userId, phoneNumber);
    if (session.state === "awaiting_confirmation" && session.batchId) {
      const batch = await getBatchListings(session.batchId);
      if (batch.length > 0 && batch.every((l) => l.status !== "draft" && l.status !== "failed")) {
        await finishSubmittedBatch(phoneNumber, session.batchId);
      }
    }
    // Start another, as under every product that's gone to Jumia, unless
    // the chat is collecting or drafting another batch it would throw away.
    if (session.state === "awaiting_photos" || session.state === "analyzing" || session.state.startsWith("awaiting_jumia")) {
      await replyLongText(phoneNumber, text);
    } else {
      await replyButtons(phoneNumber, await fitInteractiveBody(phoneNumber, text, "List something else?"), [START_ANOTHER]);
    }
    return;
  }

  // Something only the seller can supply (a field the category requires, or
  // a variation from its stocked options): asked for here, and the answer
  // sends it straight back. It used to be "Jumia still isn't happy — … pick
  // one in the editor" (owner's request, 2026-10-03).
  if (result.code === "validation") {
    const db = createServerClient();
    const { data: listing } = await db.from("listings").select("*").eq("id", listingId).eq("user_id", userId).maybeSingle();
    if (listing) {
      const row = listing as ListingRow;
      const who = row.whatsapp_seq != null ? `Product ${row.whatsapp_seq} — ${row.title}` : (row.title ?? label);
      const asked = await askBlockingValue(phoneNumber, row, who, {
        prefix:           `${lead}⚠️ ${label} wasn't sent yet.`,
        variationBlocked: isVariationBlock(result.message) || undefined,
        resubmit:         true,
      });
      if (asked) return;
    }
  }

  if (result.code === "insufficient_credits") {
    await replyError(
      phoneNumber,
      `⚠️ ${label}: not resubmitted — ${result.message}`,
      { retryId: `fix:${listingId}`, retryTitle: "Fix & resubmit", cta: { label: "Buy credits", url: buyCreditsUrl() } },
    );
    return;
  }

  // Already submitted by something else while this fix ran (2026-10-01: a
  // "Submit all" tapped during Fix & resubmit). Not a rejection: say what
  // happened, not "Jumia still isn't happy".
  if (result.code === "already_submitted") {
    await replyText(phoneNumber, `ℹ️ ${label}: already submitted, so I didn't send it again. ${result.message}`);
    return;
  }

  // Failed again. Say so rather than looping silently: a second identical
  // rejection means the automatic repair isn't the right one, and the
  // seller needs to see that instead of tapping the same button forever.
  await replyError(
    phoneNumber,
    `⚠️ ${label}: Jumia still isn't happy — ${result.message}`,
    { retryId: `fix:${listingId}`, retryTitle: "Fix & resubmit", cta: { label: "Open editor", url: focusedEditorUrl(listingId) } },
  );
}

// ─── Quality-check rejections ────────────────────────────────────────────────
//
// lib/jumia/qc-remedy.ts decides; these carry it out. What only the seller
// knows is asked in chat and the answer is applied here (handleQcAnswer):
// the bot never invents an FDA number, a brand or a price.

const NO_QC_REASON_TEXT = /^its quality check gave no reason/i;

/** Jumia's words and the listing, for decideQcAction. */
async function qcContextFor(row: Record<string, unknown>, rejectionText: string): Promise<QcContext> {
  const reason = (row.jumia_qc_reason as string | null) ?? null;
  let comment = (row.jumia_qc_comment as string | null) ?? null;
  // Rejected before Jumia's own words were kept: read the stored message,
  // unless it's the one saying Jumia gave no reason.
  if (!reason && !comment && rejectionText && !NO_QC_REASON_TEXT.test(rejectionText)) comment = rejectionText;

  let fields: QcContext["fields"] = [];
  const code = row.category_code ? parseInt(row.category_code as string, 10) : NaN;
  if (Number.isFinite(code)) {
    const { data } = await createServerClient()
      .from("jumia_category_attributes")
      .select("name, label")
      .eq("category_code", code);
    const seen = new Set<string>();
    fields = ((data ?? []) as { name: string; label: string | null }[]).filter((f) => !seen.has(f.name) && !!seen.add(f.name));
  }
  return {
    reason,
    comment,
    title:        (row.title as string | null) ?? null,
    brand:        (row.brand as string | null) ?? null,
    categoryPath: (row.category_path as string | null) ?? null,
    fields,
  };
}

async function askQc(phoneNumber: string, question: QcQuestion, text: string): Promise<void> {
  await updateSession(phoneNumber, { awaitingQcAnswer: question });
  await replyText(phoneNumber, text);
}

/**
 * Do what decideQcAction says for a listing Jumia's quality check
 * rejected. Returns the remedy for the caller's rerun path when the answer
 * is a redraft, null when it was handled here.
 */
async function fixQcRejection(
  userId:        string,
  phoneNumber:   string,
  row:           Record<string, unknown>,
  label:         string,
  rejectionText: string,
  opts:          { noDetailsAsk?: boolean } = {},
): Promise<Remedy | null> {
  const listingId = row.id as string;

  // Guided QC fixes come with the Standard pack and up
  // (lib/billing/features.ts). Without it: the editor, and where to get it.
  if (!(await hasFeature(userId, "qc_fix"))) {
    await replyCtaOrSplit(
      phoneNumber,
      `⚠️ ${label}: Jumia's quality check rejected it. Guided QC fixes come with the ${featureMinPackName("qc_fix")} pack and up. ` +
      `You can fix it yourself in the editor (${focusedEditorUrl(listingId)}), then tap Fix & resubmit.`,
      "Buy credits",
      buyCreditsUrl(),
    );
    return null;
  }

  const ctx = await qcContextFor(row, rejectionText);
  const decided = await decideQcAction(ctx);
  // The seller already pasted Vendor Center's reason: never ask again.
  const action = decided.action.kind === "ask_details" && opts.noDetailsAsk
    ? { kind: "redraft" as const, why: "Jumia's quality check rejected it." }
    : decided.action;
  console.info(`[qc-fix] ${listingId}: ${action.kind} (${decided.source})`);

  switch (action.kind) {
    case "switch_category": {
      const answer = matchCategoryAnswer(
        action.path,
        await listableLeafCategories(),
        await refusedCategoryCodes(userId, (row.category_code as string | null) ?? null),
        { title: row.title as string | null },
      );
      if (answer.kind === "match") {
        await applySellerCategory(userId, phoneNumber, listingId, answer.category.code);
        return null;
      }
      // A parent with a few categories under it ("Soft Drinks": Multipack,
      // Single): the seller picks, from just those.
      if (answer.kind === "choose" && answer.options.length > 0) {
        await updateSession(phoneNumber, { awaitingCategoryFor: listingId });
        await replyList(
          phoneNumber,
          `${label}: Jumia's quality check says it belongs in "${action.path}". Which one fits it?`,
          "Pick a category",
          answer.options.slice(0, 10).map((c) => categoryListRow(listingId, c)),
        );
        return null;
      }
      await askSellerForCategory(userId, phoneNumber, row, label, `Jumia's quality check says it belongs in "${action.path}", and I can't find a category there it accepts.`);
      return null;
    }
    case "ask_category":
      await askSellerForCategory(userId, phoneNumber, row, label, "Jumia's quality check says the category is wrong, without saying which one is right.");
      return null;
    case "redraft":
      return { kind: "rerun", explanation: action.why };
    case "cannot_fix":
      await replyText(phoneNumber, `⚠️ ${label}: ${action.why}`);
      return null;
    case "ask_value":
      await askQc(
        phoneNumber,
        { listingId, kind: "value", field: action.field, fieldLabel: action.fieldLabel },
        `🔍 ${label}: Jumia's quality check needs something only you have. ${action.question}\n\nReply with it here and I'll add it and resubmit.`,
      );
      return null;
    case "ask_brand":
      await askQc(
        phoneNumber,
        { listingId, kind: "brand" },
        `🔍 ${label}: Jumia's quality check says the brand is wrong${action.why}. What brand is on the product? Reply with the brand name, or *generic* if it has none, and I'll resubmit.`,
      );
      return null;
    case "ask_price":
      await askQc(
        phoneNumber,
        { listingId, kind: "price" },
        `🔍 ${label}: Jumia's quality check flagged the price${action.why}. What should it sell for? Reply with the amount and I'll resubmit.`,
      );
      return null;
    case "ask_photos":
      await createServerClient().from("listings").update({ qc_new_images: null }).eq("id", listingId);
      await askQc(
        phoneNumber,
        { listingId, kind: "photos" },
        `📷 ${label}: Jumia's quality check rejected the photos${action.why}. Send new photos of the product (clear, well lit, plain background, no watermarks), then reply *done* and I'll resubmit with them.`,
      );
      return null;
    case "ask_details":
      await askQc(
        phoneNumber,
        { listingId, kind: "details" },
        `🔍 ${label}: Jumia's quality check didn't say why it rejected this. Open it in Vendor Center (Products → Manage Products → Rejected), copy the rejection reason and its details, and paste them here. I'll work out the fix.`,
      );
      return null;
  }
}

/** Could this be the answer to the question, rather than something else? */
function looksLikeQcAnswer(kind: QcQuestion["kind"], text: string): boolean {
  if (!text || text.length > 1500) return false;
  if (/^(?!https?:)[a-z_]+:\S/i.test(text)) return false; // a tapped button's id
  if (/^submit\b/i.test(text)) return false;
  if (/^(hi|hello|hey|ok|okay|thanks|thank you|thx|yes|yeah|no|good|great|cool|nice|skip)[.!]*$/i.test(text)) return false;
  // An amount, perhaps with its currency: "150", "GHS 150", "150 cedis".
  if (kind === "price") return /^\D{0,6}\d[\d,]*(?:\.\d+)?\s*[a-z₵]{0,8}\.?$/i.test(text);
  // A batch edit ("2 change price to 150", "2: …") belongs to the batch.
  if (/^(?:product\s*)?#?\d+\s*(?:[:.)-]|\s(?:change|set|make|edit|update|price|stock|qty|quantity)\b)/i.test(text)) return false;
  // A short bare number is a product count or number, not a brand or a reason.
  if (/^\d{1,3}$/.test(text)) return false;
  return true;
}

/**
 * A reply while a quality-check question is open. True when it was the
 * answer (and was handled); false hands it to the normal flow, dropping
 * the question unless it's a photo answer still in progress.
 */
async function handleQcAnswer(
  userId:      string,
  phoneNumber: string,
  session:     WhatsAppSession,
  content:     { text?: string; imageMediaId?: string },
): Promise<boolean> {
  const q = session.awaitingQcAnswer!;
  if (!CATEGORY_ANSWER_STATES.has(session.state)) return false;
  const text = content.text?.trim() ?? "";

  if (q.kind === "photos") {
    if (content.imageMediaId) {
      await addQcPhoto(userId, phoneNumber, q.listingId, content.imageMediaId);
      return true;
    }
    if (/^(done|finished|that'?s all|ok done)[.!]*$/i.test(text)) {
      await finishQcPhotos(userId, phoneNumber, q.listingId);
      return true;
    }
    await updateSession(phoneNumber, { awaitingQcAnswer: null });
    return false;
  }

  if (content.imageMediaId || !looksLikeQcAnswer(q.kind, text)) {
    await updateSession(phoneNumber, { awaitingQcAnswer: null });
    return false;
  }
  await applyQcAnswer(userId, phoneNumber, q, text);
  return true;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

async function applyQcAnswer(userId: string, phoneNumber: string, q: QcQuestion, text: string): Promise<void> {
  const db = createServerClient();
  const { data: row } = await db
    .from("listings")
    .select("id, whatsapp_seq, title, description, dynamic_attributes, field_sources, sale_price")
    .eq("id", q.listingId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!row) {
    await updateSession(phoneNumber, { awaitingQcAnswer: null });
    await replyError(phoneNumber, "⚠️ I couldn't find that product — it may have been removed.");
    return;
  }
  const label = row.whatsapp_seq != null ? `Product ${row.whatsapp_seq}` : (row.title as string | null) ?? "That product";
  const sources = { ...((row.field_sources as Record<string, string> | null) ?? {}) };

  if (q.kind === "price") {
    const n = Number(text.replace(/,/g, "").match(/\d+(?:\.\d+)?/)?.[0]);
    if (!Number.isFinite(n) || n <= 0) {
      await replyText(phoneNumber, `I couldn't read a price in that. Reply with just the amount, e.g. *150*.`);
      return;
    }
    const sale = row.sale_price != null ? Number(row.sale_price) : null;
    await db.from("listings").update({
      selling_price: n,
      ...(sale != null && sale >= n ? { sale_price: null } : {}),
      field_sources: { ...sources, selling_price: "user" },
    }).eq("id", q.listingId);
    await updateSession(phoneNumber, { awaitingQcAnswer: null });
    await replyText(phoneNumber, `🔧 ${label}: price set to ${n}. Resubmitting…`);
    await pushAndReport(userId, phoneNumber, q.listingId, label);
    return;
  }

  if (q.kind === "brand") {
    const brand = /^(generic|none|no brand|unbranded|n\/?a)[.!]*$/i.test(text) ? "Generic" : text.slice(0, 80);
    await db.from("listings").update({ brand, field_sources: { ...sources, brand: "user" } }).eq("id", q.listingId);
    await updateSession(phoneNumber, { awaitingQcAnswer: null });
    await replyText(phoneNumber, `🔧 ${label}: brand set to "${brand}". Resubmitting…`);
    await pushAndReport(userId, phoneNumber, q.listingId, label);
    return;
  }

  if (q.kind === "value") {
    const value = text.slice(0, 300);
    const fieldLabel = q.fieldLabel ?? "Detail";
    if (q.field) {
      const attrs = { ...((row.dynamic_attributes as Record<string, unknown> | null) ?? {}), [q.field]: value };
      await db.from("listings").update({
        dynamic_attributes: attrs,
        field_sources: { ...sources, [`dynamic_attributes.${q.field}`]: "user" },
      }).eq("id", q.listingId);
    } else {
      // The category has no field for it: say it in the description.
      const description = `${(row.description as string | null) ?? ""}<p><strong>${escapeHtml(fieldLabel)}:</strong> ${escapeHtml(value)}</p>`;
      await db.from("listings").update({ description }).eq("id", q.listingId);
    }
    await updateSession(phoneNumber, { awaitingQcAnswer: null });
    await replyText(phoneNumber, `🔧 ${label}: added ${fieldLabel} "${value}". Resubmitting…`);
    await pushAndReport(userId, phoneNumber, q.listingId, label);
    return;
  }

  // details: the reason the seller copied from Vendor Center. Decided
  // again from their words, and never asked for a second time.
  await db.from("listings").update({
    jumia_qc_comment: text.slice(0, 1000),
    jumia_error:      `quality check: ${text.slice(0, 450)}`,
  }).eq("id", q.listingId);
  await updateSession(phoneNumber, { awaitingQcAnswer: null });
  await handleFixAndResubmit(userId, phoneNumber, q.listingId, { qcDetailsGiven: true });
}

async function addQcPhoto(userId: string, phoneNumber: string, listingId: string, mediaId: string): Promise<void> {
  const url = await ingestWhatsAppImage(mediaId, userId);
  if (!url) {
    await replyError(phoneNumber, "⚠️ That photo didn't come through cleanly (unsupported format or too large) — try another one.");
    return;
  }
  // Atomic append — an album arrives as concurrent deliveries
  // (2026-10-01_qc-remedies.sql, like append_listing_image).
  const { data } = await createServerClient().rpc("append_qc_photo", {
    p_listing_id: listingId, p_url: url, p_max: MAX_LISTING_IMAGES,
  });
  const count = ((data as { image_count: number }[] | null)?.[0]?.image_count) ?? 0;
  if (count === 1) {
    await replyButtons(phoneNumber, "📷 Got it. Send any more photos, then reply *done*.", [{ id: "done", title: "Done ✅" }]);
  }
}

async function finishQcPhotos(userId: string, phoneNumber: string, listingId: string): Promise<void> {
  const db = createServerClient();
  const { data: row } = await db
    .from("listings")
    .select("id, whatsapp_seq, title, qc_new_images")
    .eq("id", listingId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!row) {
    await updateSession(phoneNumber, { awaitingQcAnswer: null });
    await replyError(phoneNumber, "⚠️ I couldn't find that product — it may have been removed.");
    return;
  }
  const photos = ((row.qc_new_images as string[] | null) ?? []).filter(Boolean);
  if (photos.length === 0) {
    await replyText(phoneNumber, "I haven't received any new photos yet. Send them, then reply *done*.");
    return;
  }
  const label = row.whatsapp_seq != null ? `Product ${row.whatsapp_seq}` : (row.title as string | null) ?? "That product";
  await db.from("listings").update({ images: photos, image_variants: null, qc_new_images: null }).eq("id", listingId);
  await updateSession(phoneNumber, { awaitingQcAnswer: null });
  await replyText(phoneNumber, `🔧 ${label}: using your ${photos.length} new photo${photos.length === 1 ? "" : "s"}. Resubmitting…`);
  await pushAndReport(userId, phoneNumber, listingId, label);
}

/** The category question's opening for a category Jumia refused, in the owner's words (2026-10-03). */
const CATEGORY_REFUSED_LEAD =
  "Jumia can't list products in this category. Let's choose a different (more specific) category and try again.";

/**
 * Ask for the category Jumia refused, naming the product by its title
 * ("Product 3" alone left sellers guessing). A category the seller picked
 * themselves is named too, with the tip for finding one first.
 */
async function askRefusedCategory(
  userId:      string,
  phoneNumber: string,
  row:         Record<string, unknown>,
  fallback:    string,
): Promise<void> {
  const db = createServerClient();
  await db.from("listings").update({
    jumia_rerun_fingerprint: null,
    jumia_rerun_count:       0,
    updated_at:              new Date().toISOString(),
  }).eq("id", row.id as string);

  const title = ((row.title as string | null) ?? "").trim();
  const label = title ? `"${title.length > 120 ? `${title.slice(0, 119)}…` : title}"` : fallback;
  if ((row.field_sources as Record<string, string> | null)?.category_code === "user") {
    const refusedName = ((row.category_path as string | null) ?? "").split(">").pop()?.trim() || "that category";
    await askSellerForCategory(userId, phoneNumber, row, label, `Jumia refused "${refusedName}", the category you picked.`, { tipFirst: true });
    return;
  }
  await askSellerForCategory(userId, phoneNumber, row, label, CATEGORY_REFUSED_LEAD);
}

/**
 * Jumia refused a WhatsApp listing's category: its rejection message is
 * the category question, asked straight away (lib/jumia/push-listing.ts).
 * False when the listing isn't found, so the caller sends the usual
 * rejection with its Fix & resubmit button.
 */
export async function askCategoryForRefusedListing(phoneNumber: string, listingId: string): Promise<boolean> {
  const db = createServerClient();
  const { data: row } = await db
    .from("listings")
    .select("id, user_id, whatsapp_seq, title, category_code, category_path, category_alternates, field_sources")
    .eq("id", listingId)
    .maybeSingle();
  if (!row) return false;
  const fallback = row.whatsapp_seq != null ? `Product ${row.whatsapp_seq}` : "Your product";
  await askRefusedCategory(row.user_id as string, phoneNumber, row, fallback);
  return true;
}

/**
 * Ask the seller which category Jumia will accept for this product. Used
 * whenever Jumia refuses a category (askRefusedCategory: the moment the
 * rejection arrives, or on Fix & resubmit) or its quality check says the
 * category is wrong without one we can find.
 *
 * The seller can see which categories Vendor Center accepts and we can't.
 * They get suggestions Jumia hasn't refused in their country, can type a
 * category name or path (handleCategoryAnswer), and are told how to copy
 * one off a similar product already listed on Jumia. Any answer switches
 * the category and resubmits (applySellerCategory). Never the editor for
 * this: it has no Vendor Center-style category picker to offer them.
 */
async function askSellerForCategory(
  userId:      string,
  phoneNumber: string,
  listing:     Record<string, unknown>,
  label:       string,
  lead:        string,
  opts:        { tipFirst?: boolean } = {},
): Promise<void> {
  const listingId = listing.id as string;
  const [suggestions, country] = await Promise.all([
    categorySuggestionsFor(userId, listing),
    sellerCountry(userId).catch(() => null),
  ]);
  await updateSession(phoneNumber, { awaitingCategoryFor: listingId });

  // tipFirst: the seller's own pick was just refused, so a list like the
  // one they already chose from is the weaker option — lead with the tip.
  const body = opts.tipFirst
    ? `⚠️ ${label}: ${lead} ${findOnJumiaTip(country)}${suggestions.length > 0 ? " Or pick one below." : ""}`
    : `⚠️ ${label}: ${lead} Which category does Vendor Center allow for it? ` +
      `${suggestions.length > 0 ? "Pick one below or type" : "Type"} the category name, and I'll redraft and resubmit it for you.\n\n` +
      `Not sure? ${findOnJumiaTip(country)}`;

  if (suggestions.length > 0) {
    await replyList(phoneNumber, body, "Pick a category", suggestions.map((c) => categoryListRow(listingId, c)));
  } else {
    await replyText(phoneNumber, body);
  }
}

/** Suggestions for the category question — never one Jumia has refused
 *  in this seller's country. Categories similar products went live in
 *  come first (lib/jumia/live-listings.ts), then the last draft's AI
 *  alternates, then title matches. Empty on any failure: the question
 *  still works with a typed name. */
async function categorySuggestionsFor(userId: string, listing: Record<string, unknown>): Promise<CategoryChoice[]> {
  try {
    const title = (listing.title as string | null) ?? null;
    const [leaves, refused, country] = await Promise.all([
      listableLeafCategories(),
      refusedCategoryCodes(userId, (listing.category_code as string | null) ?? null),
      sellerCountry(userId).catch(() => null),
    ]);
    const pickable = leaves.filter((c) => !refused.has(Number(c.code)));
    const proven = title ? await provenCategoriesFor(country, { title }, pickable) : [];
    return suggestCategories(
      {
        title,
        category_alternates: [
          ...proven.map((p) => ({ code: p.code })),
          ...((listing.category_alternates as { code: number }[] | null) ?? []),
        ],
      },
      pickable,
    );
  } catch (e) {
    console.warn(`[whatsapp intake] couldn't build category suggestions for ${listing.id}: ${(e as Error).message}`);
    return [];
  }
}

/**
 * A typed reply while askSellerForCategory's question is open: a category
 * name, a full or partial path, or a breadcrumb copied off a Jumia product
 * page. One clear fit is applied straight away; anything else is shown
 * back as a list to pick from, never guessed at. Returns false, and drops
 * the question, when the message isn't an answer at all, so the caller
 * can handle it normally.
 */
async function handleCategoryAnswer(
  userId:      string,
  phoneNumber: string,
  listingId:   string,
  text:        string,
): Promise<boolean> {
  const skipped = CATEGORY_SKIP_RE.test(text);
  if (!skipped && !looksLikeCategoryAnswer(text)) {
    await updateSession(phoneNumber, { awaitingCategoryFor: null });
    return false;
  }

  const db = createServerClient();
  const { data: listing } = await db
    .from("listings")
    .select("id, whatsapp_seq, title, category_code, category_alternates")
    .eq("id", listingId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!listing) {
    await updateSession(phoneNumber, { awaitingCategoryFor: null });
    return false;
  }
  const label = listing.whatsapp_seq != null ? `Product ${listing.whatsapp_seq}` : "This product";
  const country = await sellerCountry(userId).catch(() => null);

  // "I don't know": the question stays open for the category they find.
  if (skipped) {
    await replyText(phoneNumber, `No problem. ${findOnJumiaTip(country)}`);
    return true;
  }

  const [leaves, refused] = await Promise.all([
    listableLeafCategories(),
    refusedCategoryCodes(userId, (listing.category_code as string | null) ?? null),
  ]);
  const answer = matchCategoryAnswer(text, leaves, refused, { title: listing.title as string | null });

  if (answer.kind === "match") {
    await applySellerCategory(userId, phoneNumber, listingId, answer.category.code);
    return true;
  }

  if (answer.kind === "choose") {
    const body = answer.exact
      ? `${label}: Jumia has more than one category by that name. Which one is it?`
      : answer.under
        ? `${label}: Which of these under "${answer.under}" is it?`
        : `${label}: I couldn't find that exact category. Is it one of these? If not, copy the category path from a similar product on ${jumiaStorefront(country)} and paste it here.`;
    await replyList(phoneNumber, body, "Pick a category", answer.options.map((c) => categoryListRow(listingId, c)));
    return true;
  }

  if (answer.kind === "product_link") {
    await replyText(
      phoneNumber,
      `${label}: That's a link to a product, and the link doesn't say its category. Open it and copy the category path shown at the top of the page instead, e.g. Phones & Tablets > Accessories > Power Banks.`,
    );
    return true;
  }

  // Refused or not found: say which, and point them at a listed product's
  // category, with the suggestions again.
  const suggestions = await categorySuggestionsFor(userId, listing);
  const lead = answer.kind === "refused"
    ? `${label}: Jumia has already refused "${answer.name}" in your country, so I can't use it.`
    : `${label}: I couldn't find that category on Jumia.`;
  const body = `${lead} ${findOnJumiaTip(country)}${suggestions.length > 0 ? " Or pick one below." : ""}`;
  if (suggestions.length > 0) {
    await replyList(phoneNumber, body, "Pick a category", suggestions.map((c) => categoryListRow(listingId, c)));
  } else {
    await replyText(phoneNumber, body);
  }
  return true;
}

/**
 * Switch a listing to the category the seller named and resubmit it — the
 * answer to askSellerForCategory, tapped or typed. Keeps the title,
 * description and photos; the new category's own fields are refilled for
 * its schema, the same way the category buttons at drafting time do.
 * refillAttributesForCategory marks the category as the seller's, so no
 * later redraft replaces it (see runAutoAnalyze).
 */
async function applySellerCategory(
  userId:       string,
  phoneNumber:  string,
  listingId:    string,
  categoryCode: number,
): Promise<void> {
  const db = createServerClient();
  const { data: row } = await db
    .from("listings")
    .select("id, whatsapp_seq, title, category_code, user_prompt")
    .eq("id", listingId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!row) {
    await updateSession(phoneNumber, { awaitingCategoryFor: null });
    await replyError(phoneNumber, "⚠️ I couldn't find that product — it may have been removed.");
    return;
  }
  const label = row.whatsapp_seq != null ? `Product ${row.whatsapp_seq}` : (row.title as string | null) ?? "That product";

  // A row tapped from an earlier list, after the switch already happened.
  if (String(categoryCode) === String(row.category_code)) {
    await updateSession(phoneNumber, { awaitingCategoryFor: null });
    await replyText(phoneNumber, `${label} is already in that category — nothing to change.`);
    return;
  }

  // An older list can offer a category Jumia has refused since it was sent.
  const refused = await refusedCategoryCodes(userId, (row.category_code as string | null) ?? null);
  if (refused.has(categoryCode)) {
    await replyText(
      phoneNumber,
      `${label}: Jumia has already refused that category in your country. Pick another one, or paste the category path of a similar product on ${jumiaStorefront(await sellerCountry(userId).catch(() => null))}.`,
    );
    return;
  }

  await updateSession(phoneNumber, { awaitingCategoryFor: null });
  const category = await getCategoryByCode(categoryCode);
  await replyText(phoneNumber, `🔧 ${label}:\nSwitching to "${category?.name ?? "your category"}" and resubmitting…`);

  const result = await refillAttributesForCategory(userId, listingId, categoryCode, {
    userContext: unwrapRerunContext((row.user_prompt as string | null) ?? null),
  });
  if (!result.ok && (result.code === "category_not_found" || result.code === "not_listable")) {
    // Still a category problem, so still the seller's call — not the editor.
    await updateSession(phoneNumber, { awaitingCategoryFor: listingId });
    await replyText(
      phoneNumber,
      `⚠️ ${label}: Jumia can't take listings in that category. Pick another one, or paste the category path of a similar product on ${jumiaStorefront(await sellerCountry(userId).catch(() => null))}.`,
    );
    return;
  }
  if (!result.ok) {
    await replyError(
      phoneNumber,
      `⚠️ ${label}: couldn't switch to that category (${result.message}).`,
      { retryId: `recat:${listingId}:${categoryCode}`, retryTitle: "Try again 🔁", cta: { label: "Open editor", url: focusedEditorUrl(listingId) } },
    );
    return;
  }

  await pushAndReport(userId, phoneNumber, listingId, label);
}

/**
 * A typed answer to the drafting-time "🤔 not sure of product N's
 * category" message: switch that draft to the category named and refill
 * its fields, without submitting it. Read while the rest of the batch is
 * still drafting as well as after it. The message's buttons carry the
 * listing id, but a seller whose category isn't on them can only type it
 * (2026-10-01: "Product one category is “Educational Tablets”" got the
 * generic help back).
 *
 * Text that says "category" is an answer ("1 category: Educational
 * Tablets"). A bare name ("Educational Tablets") counts only while exactly
 * one draft's category is in question (listings.category_unsure) and the
 * name matches one Jumia category outright; anything else is left to the
 * batch's own handling, so an edit or a note is never taken for a category.
 * Returns false when the text isn't an answer.
 */
async function handleDraftCategoryAnswer(
  userId:      string,
  phoneNumber: string,
  session:     WhatsAppSession,
  text:        string,
): Promise<boolean> {
  const batchId = session.batchId;
  if (!batchId) return false;
  const instruction = parseCategoryInstruction(text);
  if (!instruction && (!looksLikeCategoryAnswer(text) || looksActionable(text) || parseSubmitCommand(text))) return false;

  const db = createServerClient();
  const { data } = await db
    .from("listings")
    .select("id, whatsapp_seq, title, category_code, status, category_unsure")
    .eq("whatsapp_batch_id", batchId)
    .eq("user_id", userId);
  const drafts = (data ?? []) as { id: string; whatsapp_seq: number | null; title: string | null; category_code: string | null; status: string; category_unsure: boolean | null }[];
  const unsure = drafts.filter((r) => r.category_unsure && r.status === "draft");
  if (!instruction && unsure.length !== 1) return false;

  const target = instruction?.seq != null
    ? drafts.find((r) => r.whatsapp_seq === instruction.seq)
    : unsure.length === 1 ? unsure[0] : drafts.length === 1 ? drafts[0] : undefined;
  const named = instruction?.category ?? text.trim();
  if (!target) {
    await replyText(phoneNumber, `Which product is that category for? Send it like "2 category: ${named}".`);
    return true;
  }
  const label = `Product ${target.whatsapp_seq ?? "?"}`;
  if (target.status !== "draft") {
    if (!instruction) return false;
    await replyText(phoneNumber, `${label} has already been submitted, so its category can't change here. If Jumia rejects it, tap Fix & resubmit.`);
    return true;
  }

  // Still being drafted: its own analysis would overwrite the switch.
  const { data: drafting } = await db
    .from("analysis_jobs")
    .select("id")
    .eq("listing_id", target.id)
    .in("status", ["queued", "running"])
    .limit(1);
  if ((drafting ?? []).length > 0) {
    await replyText(phoneNumber, `⏳ ${label} is still being drafted. Send its category again once it's done.`);
    return true;
  }

  const [leaves, refused] = await Promise.all([
    listableLeafCategories(),
    refusedCategoryCodes(userId, target.category_code),
  ]);
  const answer = matchCategoryAnswer(named, leaves, refused, { title: target.title });

  if (answer.kind === "match") {
    await handleCategoryCorrection(userId, phoneNumber, target.id, answer.category.code);
    return true;
  }
  if (!instruction) return false;

  const country = await sellerCountry(userId).catch(() => null);
  if (answer.kind === "choose") {
    const body = answer.exact
      ? `${label}: Jumia has more than one category by that name. Which one is it?`
      : answer.under
        ? `${label}: Which of these under "${answer.under}" is it?`
        : `${label}: I couldn't find that exact category. Is it one of these? If not, copy the category path from a similar product on ${jumiaStorefront(country)} and send it as "${target.whatsapp_seq} category:" and the path.`;
    // `category:` ids, not the rejection question's `recat:`: a draft is
    // switched and refilled, not resubmitted.
    await replyList(phoneNumber, body, "Pick a category", answer.options.map((c) => ({
      ...categoryListRow(target.id, c),
      id: `category:${target.id}:${c.code}`,
    })));
    return true;
  }
  if (answer.kind === "product_link") {
    await replyText(phoneNumber, `${label}: That's a link to a product, and the link doesn't say its category. Open it and copy the category path shown at the top of the page instead.`);
    return true;
  }
  await replyText(
    phoneNumber,
    answer.kind === "refused"
      ? `${label}: Jumia has already refused "${answer.name}" in your country, so I can't use it. ${findOnJumiaTip(country)}`
      : `${label}: I couldn't find "${named}" among Jumia's categories. ${findOnJumiaTip(country)}`,
  );
  return true;
}

async function handleCategoryCorrection(
  userId: string,
  phoneNumber: string,
  listingId: string,
  categoryCode: number,
): Promise<void> {
  const db = createServerClient();
  const { data: row } = await db
    .from("listings")
    .select("whatsapp_seq, user_prompt")
    .eq("id", listingId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!row) {
    await replyError(phoneNumber, "⚠️ I couldn't find that product to recategorize — it may have been removed.");
    return;
  }
  const seq = row.whatsapp_seq ?? "?";

  const result = await refillAttributesForCategory(userId, listingId, categoryCode, {
    userContext: (row.user_prompt as string | null) ?? null,
  });

  if (!result.ok) {
    // Retry re-runs the category switch itself — the same id the
    // alternates buttons send, so a tap here is identical to tapping that
    // category again.
    await replyError(
      phoneNumber,
      `⚠️ Couldn't switch product ${seq}'s category: ${result.message}`,
      {
        retryId:    `category:${listingId}:${categoryCode}`,
        retryTitle: "Try again 🔁",
        cta:        { label: `Fix product ${seq}`, url: focusedEditorUrl(listingId) },
      },
    );
    return;
  }

  await db.from("listings").update({ category_unsure: false }).eq("id", listingId);
  const head = `✅ Product ${seq} switched to "${result.category.path}" and refilled (${result.aiFilled}/${result.attributesSchema} fields).`;

  // The full Ready check, not just the basic fields: live, 2026-10-01, this
  // said "Ready to submit" for a product the batch summary then held for
  // "Weight (kg)", which the new category requires. A missing field is
  // filled where the photos allow, and asked for while the batch is
  // waiting on the seller; while it's still drafting, the summary asks.
  const missing = await describeMissingFields(listingId);
  const assessment = missing ? null : await assessFillingMissing(userId, listingId);
  if (assessment?.ready) {
    await replyButtons(phoneNumber, `${head} Ready to submit.`, [{ id: `submit ${seq}`, title: `Submit product ${seq}` }]);
    return;
  }
  const session = await getOrCreateSession(userId, phoneNumber);
  if (assessment?.missingFields?.length && session.state === "awaiting_confirmation" && session.batchId) {
    const asked = await askForNextMissingValue(phoneNumber, session.batchId, {
      from:   listingId,
      prefix: head,
      known:  new Map([[listingId, assessment.missingFields]]),
    });
    if (asked) return;
  }
  await replyCtaOrSplit(
    phoneNumber,
    `${head}\n⚠️ ${missing || heldReasonsText(assessment?.reasons ?? [])}`,
    `Fix product ${seq}`,
    focusedEditorUrl(listingId),
  );
}
