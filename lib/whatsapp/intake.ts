import { createServerClient } from "@/lib/supabase/server";
import { sendTextIfConfigured, sendCtaUrlIfConfigured, sendButtonsIfConfigured } from "@/lib/whatsapp/client";
import { ingestWhatsAppImage } from "@/lib/whatsapp/media";
import { getOrCreateSession, updateSession, resetSession, type WhatsAppSession } from "@/lib/whatsapp/session";
import { createListingForUser } from "@/lib/listings/create";
import { runAutoAnalyze } from "@/lib/actions/auto-analyze";
import { pushListingToJumia } from "@/lib/jumia/push-listing";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import { getJumiaConnectionKind, testJumiaCredentials, saveJumiaCredentialsForUser, disconnectJumiaForUser } from "@/lib/jumia/credentials";
import { createConnectToken } from "@/lib/jumia/connect-token";
import { parseGlobalCommand, type GlobalCommand } from "@/lib/whatsapp/commands";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { endsWithDoneSignal, stripDoneSignal } from "@/lib/whatsapp/draft";
import {
  parseProductCount,
  parseSubmitCommand,
  parseEditCommand,
  extractPrice,
  extractStock,
  whatsappListingsUrl,
  focusedEditorUrl,
} from "@/lib/whatsapp/batch";
import { splitCredentialTokens, isResendCommand, jumiaConnectLink, promptJumiaConnection } from "@/lib/whatsapp/jumia-connect";
import { classifyBatchIntent, looksActionable } from "@/lib/whatsapp/intent";
import type { ListingRow } from "@/lib/supabase/types";

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
  content: { text?: string; imageMediaId?: string },
): Promise<void> {
  const session = await getOrCreateSession(userId, phoneNumber);

  if (messageId && session.lastMessageId === messageId) {
    console.info(`[whatsapp intake] skipping duplicate message ${messageId} for ${phoneNumber}`);
    return;
  }

  // Global commands (restart/cancel, disconnect, status, help) work in ANY
  // state — checked before the per-state dispatch, not folded into it, so
  // they always take effect immediately. This is also the seller's manual
  // escape hatch out of "analyzing" if startBatchAnalysis's own try/catch
  // below somehow doesn't cover a failure — see lib/whatsapp/commands.ts.
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
        await replyText(phoneNumber, "⏳ Still drafting your products — one sec.");
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
    case "status": {
      const status = describeStatus(session);
      if (status.cta) {
        await replyCta(phoneNumber, status.text, status.cta.label, status.cta.url);
      } else {
        await replyText(phoneNumber, status.text);
      }
      return;
    }
    case "help":
      await replyText(phoneNumber, HELP_TEXT);
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
      await replyText(phoneNumber, "👍 No changes made — Jumia stays connected.");
      return;
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
async function handleGlobalRestart(userId: string, phoneNumber: string): Promise<void> {
  await resetSession(phoneNumber);
  const kind = await getJumiaConnectionKind(userId);
  if (kind !== "connected") {
    await promptJumiaConnection(userId, phoneNumber, kind, "No problem — let's start fresh.\n\n");
    return;
  }
  await replyText(phoneNumber, "No problem — let's start fresh. How many products are you listing today? Reply with a number (1–20).");
}

async function handleGlobalConfirmDisconnect(userId: string, phoneNumber: string): Promise<void> {
  const result = await disconnectJumiaForUser(userId);
  if (!result.ok) {
    await replyText(phoneNumber, `⚠️ Couldn't disconnect: ${result.error}. Try again in a moment.`);
    return;
  }
  await promptJumiaConnection(userId, phoneNumber, "needs_credentials", "✅ Jumia disconnected.\n\n");
}

const HELP_TEXT = [
  "Here's what I understand at any point in the conversation:",
  "• *restart* (or *cancel*) — stop what you're doing and start a new batch",
  "• *status* — see where things stand right now",
  "• *disconnect* — unlink your Jumia store from PandaWorld",
  "• *help* — this message",
].join("\n");

/** A status reply, plus an optional link button when there's somewhere
 *  useful to send the seller alongside the text. */
function describeStatus(session: WhatsAppSession): { text: string; cta?: { label: string; url: string } } {
  switch (session.state) {
    case "awaiting_jumia_credentials":
      return { text: "Waiting for your Jumia Client ID + Client Secret — paste them here, or reply *restart* to back out." };
    case "awaiting_jumia_oauth":
      return { text: "Waiting for you to finish connecting Jumia via the link I sent — reply *resend* for a new one, or *restart* to back out." };
    case "awaiting_count":
      return { text: "Ready when you are — reply with how many products you're listing today." };
    case "awaiting_photos":
      return { text: `Collecting product ${session.batchSeq ?? 1} of ${session.batchSize ?? 1} — send its photos, then reply *done*.` };
    case "analyzing":
      return { text: "Drafting your products right now — this can take up to a minute." };
    case "awaiting_confirmation":
      return {
        text: "Your batch is drafted and ready to review.\n\nReply *submit all* when you're ready.",
        cta: { label: "Review listings", url: whatsappListingsUrl(session.batchId ?? undefined) },
      };
    case "error":
      return { text: "Something went sideways — reply anything to start fresh." };
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

  const count = content.text ? parseProductCount(content.text) : null;

  if (!count) {
    await replyText(phoneNumber, "⚠️ I need a number to get started — reply with how many products you're listing today (1–20), e.g. *3*.");
    return;
  }

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

  // A 2+-token message always wins as a fresh (appId, secretKey) pair —
  // even if a pendingAppId was already waiting — since a seller who
  // changes their mind and re-pastes both clearly means "start over with
  // these", not "append this to what I sent before". Only a single token
  // ever consults pendingAppId, to complete whichever half is missing.
  if (tokens.length >= 2) {
    [appId, secretKey] = tokens;
  } else if (tokens.length === 1 && session.pendingAppId) {
    appId = session.pendingAppId;
    secretKey = tokens[0];
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
    await replyText(phoneNumber, `⚠️ ${testResult.error}\n\nPaste your Client ID and Client Secret again.`);
    return;
  }

  const saveResult = await saveJumiaCredentialsForUser(userId, appId, secretKey);
  if (!saveResult.ok) {
    await updateSession(phoneNumber, { pendingAppId: null });
    await replyText(phoneNumber, `⚠️ ${saveResult.error}\n\nPaste your Client ID and Client Secret again.`);
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
        await replyText(phoneNumber, `⚠️ Couldn't start product ${seq}: ${message}`);
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
      await replyText(phoneNumber, "⚠️ That photo didn't come through cleanly (unsupported format or too large) — try another one.");
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
 * Fires once the LAST product's "done" arrives — every product in the
 * batch is drafted together at this point, not one at a time as each
 * "done" came in. Runs all N analyses concurrently (not sequentially: N
 * products at ~10-15s each could otherwise exceed this route's 60s
 * ceiling — see maxDuration in app/api/whatsapp/webhook/route.ts) and
 * sends a live update the moment each one finishes, so the seller sees
 * real progress instead of one long silence.
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

  // Everything below is wrapped in try/catch: this function already
  // flipped the session to "analyzing" above, and until it reaches a
  // terminal state (awaiting_confirmation, below) that state's own
  // handler just replies "still drafting" to every message — including
  // "restart" or "help", since the global-command check happens before
  // that per-state fallback. An uncaught throw anywhere in here used to
  // leave the seller wedged in "analyzing" forever with no way out and
  // no explanation — confirmed live: runAutoAnalyze (and the DB/rate-
  // limit calls around it) can throw rather than always resolving to
  // {ok:false,...}, and Promise.all rejects the instant any one of its
  // entries does, so one bad product could sink the whole batch.
  try {
    const listings = await getBatchListings(batchId);

    // Reserve rate-limit slots for the whole batch up front — cheap,
    // synchronous checks — so a seller without quota for all N finds out
    // before any (expensive) AI calls fire, rather than partway through a
    // concurrent batch. Same per-user limit the web app's Analyze button
    // and the old single-product flow both used.
    const withQuota: ListingRow[] = [];
    const overQuota: ListingRow[] = [];
    for (const listing of listings) {
      const limited = rateLimit(`auto-analyze:${userId}`, RATE_LIMITS.autoAnalyze.max, RATE_LIMITS.autoAnalyze.windowMs);
      (limited.success ? withQuota : overQuota).push(listing);
    }

    await Promise.all(
      withQuota.map(async (listing) => {
        const seq = listing.whatsapp_seq;
        try {
          const result = await runAutoAnalyze(userId, listing.id, null);
          if (result.ok) {
            // Gives access to the focused single-product editor the
            // moment this product's draft is ready — see
            // components/extension/whatsapp-focused-editor.tsx — rather
            // than making the seller wait for the batch-wide summary or
            // hunt for it on the review page. Only worth doing mid-batch
            // when there ARE other products still drafting (batchSize>1);
            // a 1-product batch's single "drafted" event folds straight
            // into the one combined completion message below instead of
            // sending this as a separate message first.
            if (batchSize > 1) {
              await replyCta(
                phoneNumber,
                `✅ Product ${seq} drafted: ${result.title ?? "(untitled)"}.`,
                `Edit product ${seq}`,
                focusedEditorUrl(listing.id),
              );
            }
          } else {
            await replyCta(
              phoneNumber,
              `⚠️ Product ${seq} couldn't be drafted: ${result.message}`,
              `Fix product ${seq}`,
              focusedEditorUrl(listing.id),
            );
          }
        } catch (e) {
          // One product's analyze throwing must never sink the rest of
          // the batch — every other entry in this Promise.all still
          // needs to resolve, or the whole session stays wedged.
          console.error(`[whatsapp intake] product ${seq} analysis threw: ${(e as Error).message}`);
          await replyCta(
            phoneNumber,
            `⚠️ Product ${seq} couldn't be drafted (unexpected error).`,
            `Fix product ${seq}`,
            focusedEditorUrl(listing.id),
          );
        }
      }),
    );

    for (const listing of overQuota) {
      await replyCta(
        phoneNumber,
        `⚠️ Product ${listing.whatsapp_seq}: hourly analyze limit reached — finish it once it resets.`,
        "Review listings",
        whatsappListingsUrl(batchId),
      );
    }

    await updateSession(phoneNumber, { state: "awaiting_confirmation" });

    // "Edit"/"Review" are cta_url buttons — they leave the chat and open a
    // browser, which Meta's API only allows as a standalone button, never
    // sharing a message with a reply-button. Tried folding all three into
    // one reply-buttons message (so "Edit"/"Review" round-tripped through
    // the bot instead of opening directly); confirmed live that leaving
    // the chat as a real link matters more than one fewer message, so
    // this stays three sends: cta_url, cta_url, then the reply-button.
    if (batchSize === 1) {
      const refreshed = await getBatchListings(batchId);
      const only = refreshed[0];
      if (only?.title) {
        await replyCta(phoneNumber, `✅ Product drafted: ${only.title}.`, "Edit product", focusedEditorUrl(only.id));
        await replyCta(phoneNumber, "🎉 Ready to submit? Review it below first if you like.", "Review listing", whatsappListingsUrl(batchId));
        await replyButtons(
          phoneNumber,
          `Reply *submit all*, or say something like "change the price to 150" to edit it first.`,
          [{ id: "submit all", title: "Submit all ✅" }],
        );
      }
      // else: the one product's own failure message (sent above, inside
      // the Promise.all) already covers what happened — nothing to add.
      return;
    }

    await replyCta(
      phoneNumber,
      `🎉 Done drafting your ${batchSize} products! Review each one below.`,
      "Review listings",
      whatsappListingsUrl(batchId),
    );
    await replyButtons(
      phoneNumber,
      `Reply *submit all*, or tell me a product number (e.g. *submit 2*) — or say "2: change the price to 150" to edit one first.`,
      [{ id: "submit all", title: "Submit all ✅" }],
    );
  } catch (e) {
    console.error(`[whatsapp intake] startBatchAnalysis failed for batch ${batchId}: ${(e as Error).message}`);
    await updateSession(phoneNumber, { state: "awaiting_confirmation" });
    await replyCta(
      phoneNumber,
      `⚠️ Something went wrong while drafting your products.\n\nCheck what's there below, reply *submit all* once you're ready, or *restart* to start over.`,
      "Review listings",
      whatsappListingsUrl(batchId),
    );
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
    await replyText(
      phoneNumber,
      `⚠️ I couldn't load this batch right now — try again in a moment, or reply *restart* to start a new one.`,
    );
    return;
  }

  const targets = cmd.all
    ? listings
    : listings.filter((l) => l.whatsapp_seq != null && cmd.seqs.includes(l.whatsapp_seq));

  if (targets.length === 0) {
    await replyCta(phoneNumber, "I couldn't find those product numbers in this batch — check the review page and try again.", "Review listings", whatsappListingsUrl(batchId));
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

  // Pushed concurrently, not sequentially — a "submit all" on a large
  // batch doing N sequential Jumia calls could exceed this route's 60s
  // ceiling (see maxDuration in app/api/whatsapp/webhook/route.ts) and
  // leave a reply never sent. Each Jumia push is an independent HTTP call,
  // safe to fire in parallel for the batch sizes this flow allows (≤20).
  const results = await Promise.all(
    targets.map(async (listing) => {
      const seq = listing.whatsapp_seq;
      const result = await pushListingToJumia(userId, listing.id);
      if (result.ok) return `Product ${seq}: ✅ submitted — pending Jumia review.`;
      if (result.code === "validation") return `Product ${seq}: ⚠️ ${result.message} Fix it at ${focusedEditorUrl(listing.id)} then reply submit again.`;
      if (result.needsReconnect) {
        // Same one-time-link mechanism as lib/whatsapp/jumia-connect.ts's
        // promptJumiaConnection, used inline here rather than through it —
        // this must NOT touch session state (still awaiting_confirmation),
        // since the seller is mid-review of this batch, not starting a
        // fresh connect flow. They just tap the link, reconnect, and reply
        // submit again from right where they left off.
        const token = await createConnectToken(userId);
        return `Product ${seq}: ⚠️ Jumia needs to be reconnected — tap here: ${jumiaConnectLink(token)}, then reply submit again.`;
      }
      return `Product ${seq}: ❌ ${result.message}`;
    }),
  );

  await replyText(phoneNumber, results.join("\n"));

  const refreshed = await getBatchListings(batchId);
  const allSubmitted = refreshed.every((l) => l.status !== "draft" && l.status !== "failed");
  if (allSubmitted) {
    await resetSession(phoneNumber);
    await replyText(phoneNumber, "🎉 That's the whole batch submitted! I'll message you here as each one goes live.");
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
    await replyText(
      phoneNumber,
      `⚠️ I couldn't load this batch right now — try again in a moment, or reply *restart* to start a new one.`,
    );
    return;
  }

  const listing = listings.find((l) => l.whatsapp_seq === seq);
  if (!listing) {
    await replyCta(phoneNumber, `I don't see product ${seq} in this batch — check the review page.`, "Review listings", whatsappListingsUrl(batchId));
    return;
  }

  const db = createServerClient();
  const price = extractPrice(editText);
  const stock = extractStock(editText);
  const applied: string[] = [];
  if (price != null) { applied.push(`price to GH₵${price}`); }
  if (stock != null) { applied.push(`stock to ${stock}`); }
  if (applied.length > 0) {
    await db
      .from("listings")
      .update({
        ...(price != null ? { selling_price: price } : {}),
        ...(stock != null ? { quantity: stock } : {}),
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
