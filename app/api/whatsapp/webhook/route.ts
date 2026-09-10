import { NextRequest, NextResponse } from "next/server";
import { redeemLinkCode, getUserIdForPhoneNumber } from "@/lib/whatsapp/link";
import { sendText, isWhatsAppConfigured } from "@/lib/whatsapp/client";
import { verifyWhatsAppSignature, extractLinkCode } from "@/lib/whatsapp/webhook-verify";

/**
 * WhatsApp Business Cloud API webhook.
 *
 * GET  — Meta's one-time subscription handshake (Meta Developer Console →
 *        your app → WhatsApp → Configuration → Webhook → Verify and save).
 * POST — every inbound event (messages, status updates, etc.).
 *
 * Stage 1 of the plan: only account-linking ("LINK-<code>" messages) is
 * handled here. Everything else from a linked number gets a placeholder
 * reply — the photo-intake → analyze → confirm → push conversation lands
 * in later stages, once whatsapp_sessions exists.
 */

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

interface IncomingMessage {
  from: string;
  type: string;
  text?: { body: string };
  button?: { text: string; payload: string };
  interactive?: { button_reply?: { id: string; title: string } };
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
  const linkCode = extractLinkCode(msg.text?.body);

  if (linkCode) {
    const result = await redeemLinkCode(linkCode, msg.from, contactName);
    if ("error" in result) {
      const reason =
        result.error === "expired" ? "That code has expired — generate a new one from Settings → Integrations."
        : result.error === "used"    ? "That code was already used — generate a new one if you need to link another number."
        :                               "That code isn't valid — check Settings → Integrations for the right one.";
      await replyIfConfigured(msg.from, `⚠️ ${reason}`);
      return;
    }
    await replyIfConfigured(
      msg.from,
      "✅ Your WhatsApp is now linked to PandaWorld! Send a product photo to start a new listing.",
    );
    return;
  }

  const userId = await getUserIdForPhoneNumber(msg.from);
  if (!userId) {
    await replyIfConfigured(
      msg.from,
      "👋 This number isn't linked to a PandaWorld account yet. Open Settings → Integrations in the app and tap \"Connect WhatsApp\" to get a linking code.",
    );
    return;
  }

  // Linked, but the photo-intake conversation isn't wired up yet (later
  // stages) — acknowledge rather than going silent.
  await replyIfConfigured(
    msg.from,
    "You're linked! Listing creation from WhatsApp is coming very soon — hang tight.",
  );
}

async function replyIfConfigured(to: string, text: string): Promise<void> {
  if (!isWhatsAppConfigured()) {
    console.warn(`[whatsapp webhook] WHATSAPP_ACCESS_TOKEN/PHONE_NUMBER_ID not set — would have replied to ${to}: ${text}`);
    return;
  }
  await sendText(to, text);
}
