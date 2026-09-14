import { createServerClient } from "@/lib/supabase/server";
import { sendTextIfConfigured, sendCtaUrlIfConfigured, sendButtonsIfConfigured } from "@/lib/whatsapp/client";
import { ingestWhatsAppImage } from "@/lib/whatsapp/media";
import { getOrCreateSession, updateSession, resetSession, type WhatsAppSession } from "@/lib/whatsapp/session";
import { createListingForUser } from "@/lib/listings/create";
import { runAutoAnalyze } from "@/lib/actions/auto-analyze";
import { getOrCreateCreditBalance, deductCredits } from "@/lib/billing/extension-credits";
import { WHATSAPP_DRAFT_CREDIT_COST } from "@/lib/billing/credit-packs";
import { pushListingToJumia, missingFieldLabels, refreshPendingFeedStatus } from "@/lib/jumia/push-listing";
import { refillAttributesForCategory } from "@/lib/jumia/refill-attributes";
import { classifyJumiaRejection, isAutoFixable } from "@/lib/jumia/rejection-remedy";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import { getJumiaConnectionKind, testJumiaCredentials, saveJumiaCredentialsForUser, disconnectJumiaForUser } from "@/lib/jumia/credentials";
import { createConnectToken } from "@/lib/jumia/connect-token";
import { parseGlobalCommand, type GlobalCommand } from "@/lib/whatsapp/commands";
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
  focusedEditorUrl,
  buyCreditsUrl,
  COUNT_QUICK_PICKS,
  MAX_BATCH_SIZE,
} from "@/lib/whatsapp/batch";
import { splitCredentialTokens, identifyCredentials, looksLikeCredential, isResendCommand, jumiaConnectLink, promptJumiaConnection } from "@/lib/whatsapp/jumia-connect";
import { classifyBatchIntent, looksActionable } from "@/lib/whatsapp/intent";
import { pickStory } from "@/lib/whatsapp/waiting-stories";
import type { ListingRow } from "@/lib/supabase/types";
import { enqueueAnalysisJobs, nudgeWorker, isBatchSettled, type AnalysisJob } from "@/lib/whatsapp/analysis-queue";

/**
 * WhatsApp chatbot, Stage 4: multi-product batches, entirely in chat.
 *
 * Flow: link -> "how many products?" (awaiting_count) -> for each product,
 * photos + notes then "done" (awaiting_photos, batch-scoped, no AI calls
 * yet) -> once the LAST product's "done" arrives, every product in the
 * batch is analyzed together (concurrently, with a live per-product
 * update as each finishes) -> one consolidated review link
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

// Batch size at or above which drafting is slow enough to be worth filling
// the silence (the "tell me a story" offer). Was a hardcoded 10, which
// became unreachable when MAX_BATCH_SIZE dropped to 5 — and 10 was always
// the wrong shape for this, since it has to move whenever the cap does.
// At ~22s for a single product, three concurrent is already a real wait.
const BIG_BATCH_SIZE = 3;

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

/** Saves a seller's free-text note against a product, plus a deterministic
 *  (non-AI) pass for an explicit price/stock — see batch.ts for why this
 *  is regex, not an AI guess: those two fields are seller-owned everywhere
 *  else in this codebase and stay that way here. */
async function applyNotes(listingId: string, text: string): Promise<void> {
  if (!text) return;
  const db = createServerClient();
  const updates: Record<string, unknown> = { user_prompt: text.slice(0, 1000), updated_at: new Date().toISOString() };
  const price = extractPrice(text);
  const stock = extractStock(text);
  if (price != null) updates.selling_price = price;
  if (stock != null) updates.quantity = stock;
  // Listing-level, not variant-level — see migration
  // 2026-09-13_listing-sale-price.sql. mapListingToJumiaProducts falls
  // back to this for every variant that doesn't have its own sale price,
  // so stating it once here applies no matter the variant, exactly like
  // selling_price already does for global_price.
  const sale = extractSalePrice(text);
  if (sale != null) {
    updates.sale_price = sale.salePrice;
    if (sale.startDate) updates.sale_start_date = sale.startDate;
    if (sale.endDate) updates.sale_end_date = sale.endDate;
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
  content: { text?: string; imageMediaId?: string; unsupported?: string },
): Promise<void> {
  const session = await getOrCreateSession(userId, phoneNumber);

  if (messageId && session.lastMessageId === messageId) {
    console.info(`[whatsapp intake] skipping duplicate message ${messageId} for ${phoneNumber}`);
    return;
  }

  // Something the bot cannot read — say so rather than dropping it. This
  // used to fall through the whole state machine in silence, which is the
  // worst possible answer and lands hardest on a seller's first attempt.
  // State is deliberately left untouched: they can simply send a photo
  // next and carry on exactly where they were.
  if (content.unsupported) {
    console.info(`[whatsapp intake] unsupported message type "${content.unsupported}" from ${phoneNumber}`);
    await replyText(phoneNumber, unsupportedMediaMessage(content.unsupported));
    if (messageId) await updateSession(phoneNumber, { lastMessageId: messageId });
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
    if (messageId) await updateSession(phoneNumber, { lastMessageId: messageId });
    return;
  }

  const globalCmd = content.text ? parseGlobalCommand(content.text) : null;

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
        await handleAwaitingCount(userId, phoneNumber, content);
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

  if (messageId) await updateSession(phoneNumber, { lastMessageId: messageId });
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
 * The end of a batch — every product submitted, session already reset.
 * Carries a button because this was the one place the flow still stopped
 * dead: the seller had nothing to tap and no stated phrase to type, so
 * listing a second batch meant guessing. The id is "restart", the same
 * canonical phrase the typed command uses (see lib/whatsapp/commands.ts),
 * so a tap and a typed *restart* run the identical path — and the body
 * still names the phrase for clients that can't render buttons.
 */
function sendBatchDoneMessage(phoneNumber: string): Promise<void> {
  return replyButtons(
    phoneNumber,
    "🎉 That's the whole batch submitted! I'll message you here as each one goes live.\n\nWant to list something else? Tap below or reply *restart*.",
    [{ id: "restart", title: "Create new listing" }],
  );
}

async function handleGlobalRestart(userId: string, phoneNumber: string): Promise<void> {
  await resetSession(phoneNumber);
  const kind = await getJumiaConnectionKind(userId);
  if (kind !== "connected") {
    await promptJumiaConnection(userId, phoneNumber, kind, "No problem — let's start fresh.\n\n");
    return;
  }
  await replyButtons(
    phoneNumber,
    "No problem — let's start fresh. How many products are you listing today?",
    COUNT_QUICK_PICKS,
  );
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
    nudgeWorker();
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
  if (status.cta) {
    await replyCta(phoneNumber, status.text, status.cta.label, status.cta.url);
    if (status.buttons) await replyButtons(phoneNumber, "Quick actions:", status.buttons);
  } else if (status.buttons) {
    await replyButtons(phoneNumber, status.text, status.buttons);
  } else {
    await replyText(phoneNumber, status.text);
  }
}

/**
 * Fallback while startBatchAnalysis's Promise.all is still running — the
 * seller can't submit/edit anything yet (nothing's drafted), but a big
 * batch (10+, see startBatchAnalysis) can take a while, so "tell_story"
 * (tapped from the button startBatchAnalysis sends for a batch that size,
 * or typed as a close variant of the phrase) gives them something to do
 * besides repeatedly checking status. Re-offers the same button afterward
 * so asking for another doesn't need retyping anything.
 */
async function handleAnalyzingMessage(
  phoneNumber: string,
  session: WhatsAppSession,
  content: { text?: string },
): Promise<void> {
  const text = content.text?.trim().toLowerCase() ?? "";
  if (text === "tell_story" || /\btell me a( nice)? story\b/.test(text)) {
    await replyButtons(phoneNumber, pickStory(), [{ id: "tell_story", title: "📖 Another one" }]);
    return;
  }
  if ((session.batchSize ?? 1) >= BIG_BATCH_SIZE) {
    await replyButtons(
      phoneNumber,
      "⏳ Still drafting your products — hang tight.",
      [{ id: "tell_story", title: "📖 Tell me a story" }],
    );
    return;
  }
  await replyText(phoneNumber, "⏳ Still drafting your products — one sec.");
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
        text: "Waiting for your Jumia Client ID + Client Secret — paste them here, or reply *restart* to back out.",
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
        buttons: (session.batchSize ?? 1) >= BIG_BATCH_SIZE ? [{ id: "tell_story", title: "📖 Tell me a story" }] : undefined,
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

async function handleAwaitingCount(
  userId: string,
  phoneNumber: string,
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

  const parsed = content.text ? readProductCount(content.text) : { ok: false as const, reason: "no_number" as const };

  if (!parsed.ok) {
    // Say which thing went wrong. Answering "50" with "I need a number"
    // reads as the bot not understanding, when the real answer is that
    // the batch cap is 20 — a fact the seller can act on immediately.
    const message =
      parsed.reason === "too_many"
        ? `⚠️ ${parsed.value} is more than I can draft in one go — the most is ${MAX_BATCH_SIZE} at a time. Reply with a number up to ${MAX_BATCH_SIZE} and you can start another batch straight after.`
        : parsed.reason === "too_few"
          ? `⚠️ I need at least 1 product to get started — reply with how many you're listing today (1–${MAX_BATCH_SIZE}).`
          : `⚠️ I need a number to get started — reply with how many products you're listing today (1–${MAX_BATCH_SIZE}), e.g. *3*.`;
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
  });
  await replyText(
    phoneNumber,
    `Let's go — product 1 of ${count}.\n\nSend its photos, and tell me the price plus any other notes (variations, sizes, sale price etc.), then reply *done*.`,
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
 * Waiting for the seller to paste their Jumia Client ID + Client Secret
 * (see the instructions sent right after linking — buildConnectInstructions
 * in lib/whatsapp/jumia-connect.ts). Accepts both together in one message
 * or one at a time; pendingAppId on the session holds the first half
 * across messages.
 */
async function handleAwaitingJumiaCredentials(
  userId: string,
  phoneNumber: string,
  session: WhatsAppSession,
  content: { text?: string; imageMediaId?: string },
): Promise<void> {
  const text = content.text?.trim();
  if (!text) {
    await replyText(phoneNumber, "Paste your Jumia Client ID and Client Secret here to continue connecting.");
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
      "That doesn't look like a Jumia Client ID or Client Secret — they're both long strings from Vendor Center → Settings → Applications. Paste your Client ID and Client Secret again.",
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
    await replyText(phoneNumber, "Got the Client ID — now paste the Client Secret.");
    return;
  } else {
    await replyText(phoneNumber, "Paste your Jumia Client ID and Client Secret here to continue connecting.");
    return;
  }

  const testResult = await testJumiaCredentials(appId, secretKey);
  if (!testResult.ok) {
    await updateSession(phoneNumber, { pendingAppId: null });
    await replyButtons(
      phoneNumber,
      `⚠️ ${testResult.error}\n\nPaste your Client ID and Client Secret again.`,
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

async function handleAwaitingPhotos(
  userId: string,
  phoneNumber: string,
  session: WhatsAppSession,
  content: { text?: string; imageMediaId?: string },
): Promise<void> {
  const batchSize = session.batchSize ?? 1;
  const seq = session.batchSeq ?? 1;
  let listingId = session.listingId;

  // ── Photo, with or without a caption in the same message ────────────────
  if (content.imageMediaId) {
    if (!listingId) {
      try {
        const listing = await createListingForUser(userId, {});
        listingId = listing.id;
        const db = createServerClient();
        await db
          .from("listings")
          .update({ whatsapp_batch_id: session.batchId, whatsapp_seq: seq })
          .eq("id", listingId);
        await updateSession(phoneNumber, { listingId });
      } catch (e) {
        const message = (e as Error).message.replace(/^QUOTA_EXCEEDED:\s*/, "");
        await replyError(phoneNumber, `⚠️ Couldn't start product ${seq}: ${message}`);
        return;
      }
    }

    const db = createServerClient();
    const { data: row } = await db.from("listings").select("images").eq("id", listingId).maybeSingle();
    const current = (row?.images ?? []) as string[];

    if (current.length >= MAX_LISTING_IMAGES) {
      await replyButtons(
        phoneNumber,
        `You've already sent ${MAX_LISTING_IMAGES} photos (the max) for product ${seq} — reply *done* when you're finished with this one.`,
        [{ id: "done", title: "Done ✅" }],
      );
      return;
    }

    const url = await ingestWhatsAppImage(content.imageMediaId, userId);
    if (!url) {
      await replyError(phoneNumber, "⚠️ That photo didn't come through cleanly (unsupported format or too large) — try another one.");
      return;
    }

    const next = [...current, url].slice(0, MAX_LISTING_IMAGES);
    await db.from("listings").update({ images: next, updated_at: new Date().toISOString() }).eq("id", listingId);

    // Falls through to the text handling below — a caption ("Price 40,
    // done") sent alongside this photo used to be silently dropped
    // because this branch returned early. Now the caption (if any) is
    // processed exactly like a standalone message in the same turn.
  }

  const text = content.text?.trim();

  if (!text) {
    if (content.imageMediaId) {
      await replyButtons(
        phoneNumber,
        `📸 Product ${seq}: got it. Send more photos, or reply *done* once you're finished with this one.`,
        [{ id: "done", title: "Done ✅" }],
      );
    } else {
      await replyText(phoneNumber, `Send a photo for product ${seq} (or reply *done* once you've sent its photos).`);
    }
    return;
  }

  if (endsWithDoneSignal(text)) {
    // The done-signal can be the WHOLE message ("done") or trail a
    // caption/note ("Price 40\nDone") — strip it so anything before it
    // still gets saved instead of discarded.
    const notes = stripDoneSignal(text);
    if (notes && listingId) await applyNotes(listingId, notes);

    if (!listingId) {
      await replyText(phoneNumber, `Send at least one photo for product ${seq} first, then reply *done*.`);
      return;
    }

    if (seq < batchSize) {
      await updateSession(phoneNumber, { state: "awaiting_photos", listingId: null, batchSeq: seq + 1 });
      await replyText(
        phoneNumber,
        `✅ Product ${seq} saved. Now send photos for product ${seq + 1} of ${batchSize}, and tell me the price plus any other notes (variations, sizes, sale price etc.), then reply *done*.`,
      );
      return;
    }

    await startBatchAnalysis(phoneNumber, userId, session);
    return;
  }

  // Free text (or a caption without a done-signal) = seller notes on this
  // product — the same free-text field the web flow threads through
  // auto-analyze as "SELLER CONTEXT" (e.g. "this is a pack of 6", "the
  // colour is teal not blue").
  if (listingId) await applyNotes(listingId, text);
  if (listingId) {
    await replyButtons(
      phoneNumber,
      content.imageMediaId
        ? `📸 Product ${seq}: got it, notes saved. Send more photos, or reply *done* once you're finished with this one.`
        : `Got it — noted for product ${seq}. Send more photos, or reply *done* when ready.`,
      [{ id: "done", title: "Done ✅" }],
    );
  } else {
    // No photo yet for this product — "done" isn't a real option, so no
    // button; the seller still needs to send at least one photo first.
    await replyText(phoneNumber, `Got it — noted for product ${seq}. Send a photo to get started.`);
  }
}

/**
 * Reserve the hourly analyze quota and the credits for a set of products,
 * telling the seller about anything that didn't fit, and return only the
 * ones that may actually be drafted.
 *
 * Extracted so RETRY goes through the identical gate: without this, a
 * seller who ran out of credits or hit the hourly limit could simply tap
 * Retry to queue the drafts anyway, since the ledger is only debited
 * after a draft succeeds (runQueuedAnalysis) and the limiter is only
 * consulted here. Two copies of this would have drifted; one copy makes
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

  // Same up-front reservation against the shared extension-credit ledger
  // (lib/billing/extension-credits.ts) — a WhatsApp draft costs
  // WHATSAPP_DRAFT_CREDIT_COST from the exact same balance the Chrome
  // extension spends from. Checked before anything is queued so a seller
  // who's run out finds out immediately rather than after being billed
  // for some prefix of the batch.
  const creditBalance = await getOrCreateCreditBalance(userId);
  const affordableCount = Number.isFinite(creditBalance)
    ? Math.max(0, Math.floor(creditBalance / WHATSAPP_DRAFT_CREDIT_COST))
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
      `⚠️ Product ${listing.whatsapp_seq}: not enough credits left to draft it (${WHATSAPP_DRAFT_CREDIT_COST} needed). Top up, then tap Retry.`,
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
): Promise<void> {
  const batchId = session.batchId;
  const batchSize = session.batchSize ?? 1;
  if (!batchId) return;

  await updateSession(phoneNumber, { state: "analyzing" });
  await replyText(
    phoneNumber,
    `🔎 Got everything for all ${batchSize} product${batchSize === 1 ? "" : "s"} — drafting them now. I'll update you as each one finishes…`,
  );
  if (batchSize >= BIG_BATCH_SIZE) {
    await replyButtons(
      phoneNumber,
      "This is a bigger batch, so drafting may take a little while. Want something to pass the time?",
      [{ id: "tell_story", title: "📖 Tell me a story" }],
    );
  }

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
    // ~22s could take 80s, which reads as a regression. Not awaited, and
    // pg_cron remains the guarantee if it doesn't land.
    nudgeWorker();
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

  // Gives access to the focused single-product editor the moment this
  // product's draft is ready, rather than making the seller wait for the
  // batch-wide summary. Only worth doing mid-batch when there ARE other
  // products still drafting; a 1-product batch's single "drafted" event
  // folds straight into finalizeBatch's combined message instead.
  if (batchSize > 1) {
    // One message, not two. This used to send the "✅ Product N drafted"
    // line and then a bare follow-up reading only "Still needs: price." —
    // which never named a product, so in a batch the seller could not tell
    // WHICH one was missing a price, and the warning arrived detached from
    // the Edit button that fixes it. Confirmed from a live 2-product
    // batch: "Still needs: price." and "Ready to submit." arrived as two
    // anonymous messages under two drafted products.
    const missing = await missingFieldsFor(job.listing_id);
    await replyCta(
      phoneNumber,
      [
        `✅ Product ${seq} drafted: ${result.title ?? "(untitled)"}.`,
        missing.length > 0
          ? `⚠️ Product ${seq} still needs ${missing.join(" and ")} — tap *Edit product ${seq}* below to add it.`
          : "Ready to submit.",
      ].join("\n"),
      `Edit product ${seq}`,
      focusedEditorUrl(job.listing_id),
    );
  }

  // Low-confidence category pick — surfaced right here in chat (for every
  // batch size) instead of only on a web confidence banner most
  // WhatsApp-only sellers never open.
  if (result.needsUserConfirmation && result.alternates.length > 0) {
    const pct = Math.round(result.category.confidence * 100);
    await replyButtons(
      phoneNumber,
      `🤔 Not fully sure about product ${seq}'s category — picked "${result.category.path}" (${pct}% confident). Tap the right one below if this isn't it:`,
      result.alternates.slice(0, 3).map((alt) => ({
        id:    `category:${job.listing_id}:${alt.code}`,
        title: alt.name.slice(0, 20),
      })),
    );
  }

  // Deducted only after a successful draft — the same rule
  // app/api/extension/fill/route.ts follows. Fire-and-forget on failure:
  // the draft already happened and the seller already has it, so a ledger
  // hiccup here shouldn't block their reply.
  deductCredits(userId, WHATSAPP_DRAFT_CREDIT_COST, "WhatsApp product draft").catch((e) =>
    console.error(`[whatsapp worker] credit deduction failed for product ${seq}: ${(e as Error).message}`),
  );
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
export async function finalizeBatch(
  batchId:     string,
  phoneNumber: string,
  batchSize:   number,
): Promise<void> {
  const listings = await getBatchListings(batchId);

  if (batchSize === 1) {
    const only = listings[0];
    if (only?.title) {
      const missing = await describeMissingFields(only.id);
      await replyCta(
        phoneNumber,
        missing ? `✅ Product drafted: ${only.title}.\n⚠️ ${missing}` : `✅ Product drafted: ${only.title}. Ready to submit!`,
        "Edit product",
        focusedEditorUrl(only.id),
      );
      await replyButtons(
        phoneNumber,
        `Reply *submit*, or say something like "change the price to 150" to edit it first.`,
        [
          { id: "submit all", title: "Submit ✅" },
          { id: "restart",    title: "Restart 🔄" },
        ],
      );
    }
    // else: the product's own failure message (sent by runQueuedAnalysis)
    // already covers what happened — nothing to add.
    return;
  }

  // Every "Edit product N" link already went out live as each product
  // finished — now that the whole batch has settled, send every ready
  // product's "Submit product N" button as its own grouped pass (chunked
  // to 3 per message, WhatsApp's per-message button cap) so edits and
  // submits read as two separate blocks, not alternating pairs.
  const readyToSubmitSeqs = listings
    .filter((l) => l.title && l.whatsapp_seq != null)
    .map((l) => l.whatsapp_seq as number)
    .sort((a, b) => a - b);

  for (let i = 0; i < readyToSubmitSeqs.length; i += 3) {
    const chunk = readyToSubmitSeqs.slice(i, i + 3);
    await replyButtons(
      phoneNumber,
      "Submit a specific product:",
      chunk.map((seq) => ({ id: `submit ${seq}`, title: `Submit product ${seq}` })),
    );
  }

  await replyButtons(
    phoneNumber,
    `🎉 Done drafting your ${batchSize} products! Check the messages above for each one, then reply *submit all* when ready — or tell me a product number (e.g. *submit 2*) to submit just one.`,
    [
      { id: "submit all", title: "Submit all ✅" },
      { id: "restart",    title: "Restart 🔄" },
    ],
  );
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

  // Alternate-category button tap from startBatchAnalysis's low-confidence
  // prompt — id is `category:<listingId>:<code>`. Runs the same refill
  // pipeline the web editor's category drawer uses
  // (lib/jumia/refill-attributes.ts) so the correction and re-fill happen
  // in one action, right here in chat.
  const categoryMatch = text.match(/^category:([^:]+):(\d+)$/);
  if (categoryMatch) {
    await handleCategoryCorrection(userId, phoneNumber, categoryMatch[1], parseInt(categoryMatch[2], 10));
    return;
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
      await resetSession(phoneNumber);
      // Same split as the else-branch below: the per-product lines go as
      // plain text (a full batch's worth can exceed the interactive body
      // cap), then the short sign-off carries the button.
      if (alreadySubmittedMessages.length > 0) {
        await replyText(phoneNumber, alreadySubmittedMessages.join("\n"));
      }
      await sendBatchDoneMessage(phoneNumber);
    } else {
      // Plain text first (a long list of "already submitted" lines can
      // exceed the interactive-message body cap), then a short, fixed-
      // length CTA so this never dead-ends either.
      await replyText(phoneNumber, alreadySubmittedMessages.join("\n"));
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
    let cursor = 0;
    const pushWorker = async (): Promise<void> => {
      for (let i = cursor++; i < targets.length; i = cursor++) {
        const listing = targets[i];
        const seq = listing.whatsapp_seq;
        try {
          const result = await pushListingToJumia(userId, listing.id);
          if (result.ok) {
            messages[i] = `Product ${seq}: ✅ submitted — pending Jumia review.`;
          } else if (result.code === "validation") {
            messages[i] = `Product ${seq}: ⚠️ ${result.message} Fix it at ${focusedEditorUrl(listing.id)} then reply submit again.`;
          } else if (result.needsReconnect) {
            // Same one-time-link mechanism as lib/whatsapp/jumia-connect.ts's
            // promptJumiaConnection, used inline here rather than through it —
            // this must NOT touch session state (still awaiting_confirmation),
            // since the seller is mid-review of this batch, not starting a
            // fresh connect flow. They just tap the link, reconnect, and reply
            // submit again from right where they left off.
            const token = await createConnectToken(userId);
            messages[i] = `Product ${seq}: ⚠️ Jumia needs to be reconnected — tap here: ${jumiaConnectLink(token)}, then reply submit again.`;
          } else {
            messages[i] = `Product ${seq}: ❌ ${result.message}`;
          }
        } catch (e) {
          // One product's push throwing must never sink the rest of the
          // batch — every other worker still needs to keep going, or the
          // seller gets zero reply and no way to tell what happened (this
          // had no per-listing catch at all before).
          console.error(`[whatsapp intake] product ${seq} submit threw: ${(e as Error).message}`);
          messages[i] = `Product ${seq}: ❌ Unexpected error — reply submit again to retry.`;
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
    await replyText(phoneNumber, [...alreadySubmittedMessages, ...raceResult].join("\n"));

    const refreshed = await getBatchListings(batchId);
    const allSubmitted = refreshed.every((l) => l.status !== "draft" && l.status !== "failed");
    if (allSubmitted) {
      await resetSession(phoneNumber);
      await sendBatchDoneMessage(phoneNumber);
    } else {
      // Still stuff left in this batch — never leave the seller to guess
      // the next command from the result text alone. Short, fixed body
      // here (not the result text) so this one's always well under the
      // button-message length limit.
      await replyButtons(phoneNumber, "What's next?", [
        { id: "submit all", title: "Submit all ✅" },
        { id: "restart", title: "Restart 🔄" },
      ]);
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
  const price = extractPrice(editText);
  const stock = extractStock(editText);
  const sale  = extractSalePrice(editText);
  const applied: string[] = [];
  if (price != null) { applied.push(`price to GH₵${price}`); }
  if (stock != null) { applied.push(`stock to ${stock}`); }
  if (sale != null) { applied.push(`sale price to GH₵${sale.salePrice}${sale.startDate || sale.endDate ? " with dates" : ""}`); }
  if (applied.length > 0) {
    await db
      .from("listings")
      .update({
        ...(price != null ? { selling_price: price } : {}),
        ...(stock != null ? { quantity: stock } : {}),
        // Listing-level fallback every variant resolves to when it has no
        // sale price of its own — see applyNotes's identical comment.
        ...(sale != null ? {
          sale_price: sale.salePrice,
          ...(sale.startDate ? { sale_start_date: sale.startDate } : {}),
          ...(sale.endDate ? { sale_end_date: sale.endDate } : {}),
        } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", listing.id);
  }

  const ack = applied.length > 0 ? `✅ Updated product ${seq}'s ${applied.join(" and ")}. ` : "";
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
 * "Fix & resubmit" on a Jumia rejection.
 *
 * A rejection used to be a dead end: the seller got Jumia's own wording
 * ("The column [product_weight] is missing from the file") and was left to
 * translate that into an action. Most rejections fall into a few shapes,
 * and one of them — missing or invalid category attributes — the system
 * can genuinely repair by re-filling the schema and pushing again.
 *
 * Deliberately honest about the rest. A price Jumia is missing is a price
 * only the seller has; claiming to have fixed it and re-pushing the same
 * payload would fail identically and waste their time. Seller-only causes
 * are named and handed back with the editor link.
 */
async function handleFixAndResubmit(
  userId:      string,
  phoneNumber: string,
  listingId:   string,
): Promise<void> {
  const db = createServerClient();
  const { data: row } = await db
    .from("listings")
    .select("id, whatsapp_seq, title, jumia_error, category_code, category_path, user_prompt")
    .eq("id", listingId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!row) {
    await replyError(phoneNumber, "⚠️ I couldn't find that product — it may have been removed.");
    return;
  }

  const label = row.whatsapp_seq != null ? `Product ${row.whatsapp_seq}` : (row.title as string | null) ?? "That product";

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

  const remedy = classifyJumiaRejection(row.jumia_error as string | null);

  if (!isAutoFixable(remedy.kind)) {
    await replyError(
      phoneNumber,
      `⚠️ ${label}: ${remedy.explanation} That one needs you — open the editor and I'll resubmit once it's sorted.`,
      { retryId: `fix:${listingId}`, retryTitle: "Fix & resubmit", cta: { label: "Open editor", url: focusedEditorUrl(listingId) } },
    );
    return;
  }

  await replyText(phoneNumber, `🔧 ${label}: ${remedy.explanation} Fixing and resubmitting…`);

  // Re-fill the category schema before re-pushing. Skipped for a pure
  // duplicate-SKU rejection, where the payload was fine and the push path
  // generates a fresh suffix on its own — an AI call there would cost a
  // credit to change nothing.
  if (remedy.kind !== "repush" && row.category_code) {
    try {
      const refill = await refillAttributesForCategory(userId, listingId, Number(row.category_code), {
        categoryPath: row.category_path as string | null,
        userContext:  (row.user_prompt as string | null) ?? null,
      });
      if (!refill.ok) {
        await replyError(
          phoneNumber,
          `⚠️ ${label}: couldn't refill the category fields (${refill.message}).`,
          { retryId: `fix:${listingId}`, retryTitle: "Fix & resubmit", cta: { label: "Open editor", url: focusedEditorUrl(listingId) } },
        );
        return;
      }
    } catch (e) {
      console.error(`[whatsapp intake] fix-and-resubmit refill failed for ${listingId}: ${(e as Error).message}`);
      await replyError(
        phoneNumber,
        `⚠️ ${label}: something went wrong while fixing it.`,
        { retryId: `fix:${listingId}`, retryTitle: "Fix & resubmit", cta: { label: "Open editor", url: focusedEditorUrl(listingId) } },
      );
      return;
    }
  }

  const result = await pushListingToJumia(userId, listingId);

  if (result.ok) {
    await replyText(phoneNumber, `✅ ${label}: resubmitted — pending Jumia review.`);
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

  const missing = await describeMissingFields(listingId);
  await replyButtons(
    phoneNumber,
    `✅ Product ${seq} switched to "${result.category.path}" and refilled (${result.aiFilled}/${result.attributesSchema} fields). ${missing || "Ready to submit."}`,
    [{ id: `submit ${seq}`, title: `Submit product ${seq}` }],
  );
}
