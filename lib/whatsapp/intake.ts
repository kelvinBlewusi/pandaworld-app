import { createServerClient } from "@/lib/supabase/server";
import { sendTextIfConfigured } from "@/lib/whatsapp/client";
import { ingestWhatsAppImage } from "@/lib/whatsapp/media";
import { getOrCreateSession, updateSession, resetSession, type WhatsAppSession } from "@/lib/whatsapp/session";
import { createListingForUser } from "@/lib/listings/create";
import { runAutoAnalyze } from "@/lib/actions/auto-analyze";
import { pushListingToJumia } from "@/lib/jumia/push-listing";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import { getJumiaConnectionKind, testJumiaCredentials, saveJumiaCredentialsForUser } from "@/lib/jumia/credentials";
import { createConnectToken } from "@/lib/jumia/connect-token";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { endsWithDoneSignal, stripDoneSignal } from "@/lib/whatsapp/draft";
import {
  parseProductCount,
  parseSubmitCommand,
  parseEditCommand,
  extractPrice,
  extractStock,
  whatsappListingsUrl,
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

async function getBatchListings(batchId: string): Promise<ListingRow[]> {
  const db = createServerClient();
  const { data } = await db
    .from("listings")
    .select("*")
    .eq("whatsapp_batch_id", batchId)
    .order("whatsapp_seq", { ascending: true });
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

  if (messageId) await updateSession(phoneNumber, { lastMessageId: messageId });
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
    await replyText(phoneNumber, "How many products are you listing today? Reply with a number (1–20) to get started.");
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
    `Let's go — product 1 of ${count}.\n\nSend its photos, plus any notes (price, sizes, variations, etc.), then reply *done*.`,
  );
}

async function sendJumiaConnectLink(userId: string, phoneNumber: string): Promise<void> {
  const token = await createConnectToken(userId);
  await replyText(
    phoneNumber,
    `Tap this link to finish connecting Jumia:\n${jumiaConnectLink(token)}\n\nI'll message you here once it's done.`,
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
  await replyText(
    phoneNumber,
    "Still waiting for you to finish connecting Jumia — tap the link I sent earlier, or reply *resend* for a new one.",
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
      await replyText(
        phoneNumber,
        `You've already sent ${MAX_LISTING_IMAGES} photos (the max) for product ${seq} — reply *done* when you're finished with this one.`,
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
      await replyText(
        phoneNumber,
        `📸 Product ${seq}: got it. Send more photos, or reply *done* once you're finished with this one.`,
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
        `✅ Product ${seq} saved. Now send photos for product ${seq + 1} of ${batchSize}, plus any notes, then reply *done*.`,
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
  await replyText(
    phoneNumber,
    content.imageMediaId
      ? `📸 Product ${seq}: got it, notes saved. Send more photos, or reply *done* once you're finished with this one.`
      : `Got it — noted for product ${seq}. Send more photos, or reply *done* when ready.`,
  );
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
      const result = await runAutoAnalyze(userId, listing.id, null);
      if (result.ok) {
        await replyText(phoneNumber, `✅ Product ${seq} drafted: ${result.title ?? "(untitled)"}.`);
      } else {
        await replyText(
          phoneNumber,
          `⚠️ Product ${seq} couldn't be drafted: ${result.message} Fix it at ${whatsappListingsUrl(batchId)}.`,
        );
      }
    }),
  );

  for (const listing of overQuota) {
    await replyText(
      phoneNumber,
      `⚠️ Product ${listing.whatsapp_seq}: hourly analyze limit reached — finish it at ${whatsappListingsUrl(batchId)} once it resets.`,
    );
  }

  await updateSession(phoneNumber, { state: "awaiting_confirmation" });
  await replyText(
    phoneNumber,
    [
      `🎉 Done drafting! Review everything here: ${whatsappListingsUrl(batchId)}`,
      "",
      `Reply *submit all* to push your drafted listings to Jumia after your review, or tell me the product number you want to submit (e.g. *submit 2*). You can also say "2: change the price to 150" to fix one first.`,
    ].join("\n"),
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
    await replyText(
      phoneNumber,
      `Reply *submit all* to push your drafted listings to Jumia, or tell me the product number you want to submit. Review them here: ${whatsappListingsUrl(batchId ?? undefined)}`,
    );
    return;
  }

  const submitCmd = parseSubmitCommand(text);
  if (submitCmd) {
    await handleSubmit(userId, phoneNumber, batchId, submitCmd);
    return;
  }

  const editCmd = parseEditCommand(text, batchSize);
  if (editCmd?.needsSeq) {
    await replyText(phoneNumber, `Which product number is this for? e.g. "2: change the price to 150" (review at ${whatsappListingsUrl(batchId)}).`);
    return;
  }
  if (editCmd) {
    await handleEdit(userId, phoneNumber, batchId, editCmd.seq, editCmd.text);
    return;
  }

  // Neither deterministic parser matched — try to understand what the
  // seller actually meant before falling back to a generic help message.
  // Kept as a fallback (not the primary path) so well-formed commands
  // above stay fast, free, and fully deterministic. looksActionable is a
  // cheap pre-filter so an off-topic reply ("thanks", "ok") never costs a
  // Gemini call for nothing.
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
  }

  await replyText(
    phoneNumber,
    `Reply *submit all* to push your drafted listings to Jumia, or tell me the product number you want to submit. You can also say "2: change the price to 150" to edit one. Review them here: ${whatsappListingsUrl(batchId)}`,
  );
}

async function handleSubmit(
  userId: string,
  phoneNumber: string,
  batchId: string,
  cmd: { all: true } | { all: false; seqs: number[] },
): Promise<void> {
  const listings = await getBatchListings(batchId);
  const targets = cmd.all
    ? listings
    : listings.filter((l) => l.whatsapp_seq != null && cmd.seqs.includes(l.whatsapp_seq));

  if (targets.length === 0) {
    await replyText(phoneNumber, "I couldn't find those product numbers in this batch — check the review page and try again.");
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
      if (result.code === "validation") return `Product ${seq}: ⚠️ ${result.message} Fix it at ${whatsappListingsUrl(batchId)} then reply submit again.`;
      if (result.needsReconnect) return `Product ${seq}: ⚠️ Jumia needs to be reconnected — Settings → Integrations in the app, then reply submit again.`;
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

async function handleEdit(
  userId: string,
  phoneNumber: string,
  batchId: string,
  seq: number,
  editText: string,
): Promise<void> {
  const listings = await getBatchListings(batchId);
  const listing = listings.find((l) => l.whatsapp_seq === seq);
  if (!listing) {
    await replyText(phoneNumber, `I don't see product ${seq} in this batch — check the review page: ${whatsappListingsUrl(batchId)}`);
    return;
  }

  const db = createServerClient();
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const price = extractPrice(editText);
  const stock = extractStock(editText);
  if (price != null) updates.selling_price = price;
  if (stock != null) updates.quantity = stock;
  if (Object.keys(updates).length > 1) {
    await db.from("listings").update(updates).eq("id", listing.id);
  }

  await replyText(phoneNumber, `✏️ Updating product ${seq}…`);
  const result = await runAutoAnalyze(userId, listing.id, editText);

  if (!result.ok) {
    await replyText(phoneNumber, `⚠️ Couldn't update product ${seq}: ${result.message}`);
    return;
  }

  await replyText(phoneNumber, `✅ Updated product ${seq}. Review: ${whatsappListingsUrl(batchId)}`);
}
