import { NextRequest, NextResponse } from "next/server";
import { redeemLinkCode, getUserIdForPhoneNumber } from "@/lib/whatsapp/link";
import { sendTextIfConfigured, sendCtaUrlIfConfigured, markReadWithTypingIfConfigured } from "@/lib/whatsapp/client";
import { verifyWhatsAppSignature, extractLinkCode } from "@/lib/whatsapp/webhook-verify";
import { contentOf, type IncomingMessage } from "@/lib/whatsapp/message-content";
import { handleLinkedMessage } from "@/lib/whatsapp/intake";
import { getJumiaConnectionKind } from "@/lib/jumia/credentials";
import { getOrCreateSession, updateSession } from "@/lib/whatsapp/session";
import { promptJumiaConnection } from "@/lib/whatsapp/jumia-connect";
import { appUrl } from "@/lib/whatsapp/app-url";

/**
 * WhatsApp Business Cloud API webhook.
 *
 * GET  — Meta's one-time subscription handshake (Meta Developer Console →
 *        your app → WhatsApp → Configuration → Webhook → Verify and save).
 * POST — every inbound event (messages, status updates, etc.).
 *
 * Stage 1 handles account-linking ("LINK-<code>" messages). Stage 4 adds
 * the full multi-product batch flow (how many? → photos+notes per product
 * → submit/edit entirely in chat) for already-linked numbers — see
 * lib/whatsapp/intake.ts for the conversation state machine.
 */

// Auto-analyze runs inline within this handler (see lib/whatsapp/intake.ts)
// so the seller's draft reply arrives as a proactive WhatsApp send once it
// finishes — same worst-case duration as the web route, same headroom
// needed. See app/api/listings/[id]/auto-analyze/route.ts for the full
// reasoning.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (mode === "subscribe" && token && process.env.WHATSAPP_VERIFY_TOKEN && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return new NextResponse(challenge ?? "", { status: 200 });
  }
  return new NextResponse("Forbidden", { status: 403 });
}

/** Best-effort extraction — Meta's payload nests several layers deep and
 *  some fields are only present for certain event types. */
function extractMessages(body: unknown): { messages: IncomingMessage[]; contactName?: string } {
  const messages: IncomingMessage[] = [];
  let contactName: string | undefined;
  const entries = (body as { entry?: unknown[] })?.entry ?? [];
  for (const entry of entries) {
    const changes = (entry as { changes?: unknown[] })?.changes ?? [];
    for (const change of changes) {
      const value = (change as { value?: Record<string, unknown> })?.value;
      if (!value) continue;
      const contacts = (value.contacts as { profile?: { name?: string } }[] | undefined) ?? [];
      if (contacts[0]?.profile?.name) contactName = contacts[0].profile.name;
      const msgs = (value.messages as IncomingMessage[] | undefined) ?? [];
      messages.push(...msgs);
    }
  }
  return { messages, contactName };
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  if (!verifyWhatsAppSignature(rawBody, req.headers.get("x-hub-signature-256"), process.env.WHATSAPP_APP_SECRET)) {
    console.warn("[whatsapp webhook] invalid or missing signature — rejected");
    return new NextResponse("Invalid signature", { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new NextResponse("Invalid JSON", { status: 400 });
  }

  const { messages, contactName } = extractMessages(body);

  for (const msg of messages) {
    try {
      await handleMessage(msg, contactName);
    } catch (e) {
      // One malformed/unexpected message must never take down the rest of
      // the batch, or cause Meta to retry the whole webhook delivery.
      console.error(`[whatsapp webhook] failed handling message from ${msg.from}:`, e);
    }
  }

  // Always 200 — Meta retries aggressively on anything else, and a retry
  // storm on a transient error is worse than losing one event.
  return NextResponse.json({ received: true });
}

async function handleMessage(msg: IncomingMessage, contactName?: string): Promise<void> {
  // Fired, not awaited — shows the seller blue ticks + the animated
  // "typing…" indicator right away, while everything below (image
  // download, AI analyze, Jumia push) can take several seconds. Never
  // let a slow/failed typing-indicator call hold up real message
  // handling — see markReadWithTypingIfConfigured's own error handling.
  void markReadWithTypingIfConfigured(msg.id);

  const linkCode = extractLinkCode(msg.text?.body);

  if (linkCode) {
    const result = await redeemLinkCode(linkCode, msg.from, contactName);
    if ("error" in result) {
      const reason =
        result.error === "expired" ? "That code has expired — get a new one."
        : result.error === "used"    ? "That code was already used — get a new one if you need to link another number."
        :                               "That code isn't valid — get the right one.";
      await sendCtaUrlIfConfigured(
        msg.from,
        `⚠️ ${reason}`,
        "Get a new code",
        `${appUrl()}/extension/whatsapp-listings`,
      );
      return;
    }

    // A brand-new seller (or one who never finished connecting Jumia, or
    // whose connection has since expired) gets walked through it right
    // here instead of straight into "how many products?" — see
    // lib/jumia/credentials.ts's getJumiaConnectionKind and
    // lib/whatsapp/jumia-connect.ts's promptJumiaConnection. Always
    // ensure a session row exists first, then overwrite its state
    // explicitly — a returning number relinking to a different account,
    // or one with stale state from a past session, must not carry any
    // of that into this fresh link.
    const kind = await getJumiaConnectionKind(result.userId);
    await getOrCreateSession(result.userId, msg.from);

    if (kind === "connected") {
      await updateSession(msg.from, {
        state: "awaiting_count", listingId: null, batchId: null, batchSize: null, batchSeq: null, pendingAppId: null,
      });
      await sendTextIfConfigured(
        msg.from,
        "✅ Your WhatsApp is now linked to PandaWorld! How many products are you listing today? Reply with a number to get started.",
      );
      return;
    }

    await promptJumiaConnection(result.userId, msg.from, kind, "✅ Your WhatsApp is now linked to PandaWorld!\n\n");
    return;
  }

  const userId = await getUserIdForPhoneNumber(msg.from);
  if (!userId) {
    await sendCtaUrlIfConfigured(
      msg.from,
      "👋 This number isn't linked to a PandaWorld account yet.",
      "Connect WhatsApp",
      `${appUrl()}/extension/whatsapp-listings`,
    );
    return;
  }

  await handleLinkedMessage(userId, msg.from, msg.id, contentOf(msg));
}
