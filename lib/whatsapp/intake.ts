import { createServerClient } from "@/lib/supabase/server";
import { sendTextIfConfigured } from "@/lib/whatsapp/client";
import { ingestWhatsAppImage } from "@/lib/whatsapp/media";
import { getOrCreateSession, updateSession, resetSession, type WhatsAppSession } from "@/lib/whatsapp/session";
import { createListingForUser } from "@/lib/listings/create";
import { runAutoAnalyze } from "@/lib/actions/auto-analyze";
import { rateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { isDoneMessage, formatDraftSummary, reviewUrl } from "@/lib/whatsapp/draft";

/**
 * WhatsApp chatbot, Stage 3: the photo-intake -> analyze -> draft-reply
 * loop. Everything here runs for an already-linked number (Stage 1 handles
 * the "LINK-<code>" message before this is ever called — see
 * app/api/whatsapp/webhook/route.ts).
 *
 * Scope for this stage, per the build plan: get the seller from "here are
 * my photos" to a draft listing with a plain-text summary, then point them
 * at the review page to set price/stock and push. Chat-native confirm/fix/
 * push (Stage 4) isn't wired up yet — awaiting_confirmation replies say so
 * rather than offering tappable buttons that would go nowhere.
 */

const MAX_LISTING_IMAGES = 8;

function replyText(to: string, text: string): Promise<void> {
  return sendTextIfConfigured(to, text);
}

/**
 * Entry point for every message from an already-linked number. Dispatches
 * on the seller's session state. `messageId`, when given (Meta's wamid),
 * guards against re-processing the same webhook delivery twice — Meta
 * retries aggressively if we don't ack fast enough, and re-running an
 * analyze or re-creating a draft on a retry would be a real (and
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
    case "awaiting_photos":
      await handleAwaitingPhotos(userId, phoneNumber, session, content);
      break;
    case "analyzing":
      await replyText(phoneNumber, "⏳ Still working on your last listing — one sec.");
      break;
    case "awaiting_confirmation":
      await replyText(
        phoneNumber,
        session.listingId
          ? `Finish or push that listing here: ${reviewUrl(session.listingId)}\n\nChat-based edits are coming soon — for now the app has the full picture.`
          : "Open the app to finish your listing. Chat-based edits are coming soon.",
      );
      break;
    case "error":
      await resetSession(phoneNumber);
      await replyText(phoneNumber, "Let's start fresh — send a product photo to begin a new listing.");
      break;
  }

  if (messageId) await updateSession(phoneNumber, { lastMessageId: messageId });
}

async function handleAwaitingPhotos(
  userId: string,
  phoneNumber: string,
  session: WhatsAppSession,
  content: { text?: string; imageMediaId?: string },
): Promise<void> {
  if (content.imageMediaId) {
    let listingId = session.listingId;
    if (!listingId) {
      try {
        const listing = await createListingForUser(userId, {});
        listingId = listing.id;
        await updateSession(phoneNumber, { listingId });
      } catch (e) {
        const message = (e as Error).message.replace(/^QUOTA_EXCEEDED:\s*/, "");
        await replyText(phoneNumber, `⚠️ Couldn't start a new listing: ${message}`);
        return;
      }
    }

    const db = createServerClient();
    const { data: row } = await db.from("listings").select("images").eq("id", listingId).maybeSingle();
    const current = (row?.images ?? []) as string[];

    if (current.length >= MAX_LISTING_IMAGES) {
      await replyText(
        phoneNumber,
        `You've already sent ${MAX_LISTING_IMAGES} photos (the max) — reply *done* to analyze, or finish in the app: ${reviewUrl(listingId)}`,
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

    await replyText(
      phoneNumber,
      `📸 Got it (${next.length}/${MAX_LISTING_IMAGES} photo${next.length === 1 ? "" : "s"}). Send more, or reply *done* when you're ready.`,
    );
    return;
  }

  const text = content.text?.trim();
  if (!text) {
    await replyText(phoneNumber, "Send a product photo to start a listing (or reply *done* once you've sent your photos).");
    return;
  }

  if (isDoneMessage(text)) {
    if (!session.listingId) {
      await replyText(phoneNumber, "Send at least one product photo first, then reply *done*.");
      return;
    }
    await runAnalyzeAndReply(phoneNumber, userId, session.listingId);
    return;
  }

  // Free text before "done" = seller context — the same free-text field
  // the web flow threads through auto-analyze as "SELLER CONTEXT" (e.g.
  // "this is a pack of 6", "the colour is teal not blue").
  if (session.listingId) {
    const db = createServerClient();
    await db
      .from("listings")
      .update({ user_prompt: text.slice(0, 1000), updated_at: new Date().toISOString() })
      .eq("id", session.listingId);
  }
  await replyText(phoneNumber, "Got it — noted. Send more photos, or reply *done* when ready.");
}

async function runAnalyzeAndReply(phoneNumber: string, userId: string, listingId: string): Promise<void> {
  // Reuse the exact same per-user rate limit as the web app's Analyze
  // button — same Gemini cost profile (~$0.02/call), same abuse surface.
  const limited = rateLimit(`auto-analyze:${userId}`, RATE_LIMITS.autoAnalyze.max, RATE_LIMITS.autoAnalyze.windowMs);
  if (!limited.success) {
    await replyText(phoneNumber, "You've hit the hourly analyze limit — try again in a bit, or finish this listing in the app.");
    return;
  }

  await updateSession(phoneNumber, { state: "analyzing" });
  await replyText(phoneNumber, "🔎 Looking at your photos — this takes about 10-15 seconds…");

  const result = await runAutoAnalyze(userId, listingId, null);

  if (!result.ok) {
    await updateSession(phoneNumber, { state: "error" });
    await replyText(
      phoneNumber,
      `⚠️ Couldn't finish analyzing: ${result.message}\n\nYou can still finish this listing in the app: ${reviewUrl(listingId)}`,
    );
    return;
  }

  await updateSession(phoneNumber, { state: "awaiting_confirmation" });
  await replyText(phoneNumber, formatDraftSummary(result, listingId));
}
