/**
 * WhatsApp Business Cloud API — send-message client (server-only).
 *
 * Requires a Meta WhatsApp Business Platform app (Business Manager account,
 * verified phone number) — same class of external, user-owned setup as the
 * Jumia OAuth app each seller creates for the direct-API push (see
 * lib/jumia/oauth.ts). We cannot create this account on the user's behalf;
 * these env vars must be supplied once it exists:
 *
 *   WHATSAPP_ACCESS_TOKEN     — permanent (System User) access token
 *   WHATSAPP_PHONE_NUMBER_ID  — the Cloud API phone number ID (not the
 *                               phone number itself)
 *   WHATSAPP_APP_SECRET       — used by the webhook to verify Meta's
 *                               X-Hub-Signature-256 header (see
 *                               app/api/whatsapp/webhook/route.ts)
 *   WHATSAPP_VERIFY_TOKEN     — arbitrary string you choose, set the same
 *                               value in Meta's webhook subscription config
 *   WHATSAPP_BOT_NUMBER       — the bot's own number, digits only, E.164
 *                               without "+" (e.g. "233241234567") — used
 *                               to build the wa.me deep link in
 *                               lib/whatsapp/link.ts, not for sending
 *
 * Until these are set, isWhatsAppConfigured() is false and send calls
 * throw immediately rather than silently no-op — a chatbot that can't
 * actually reply is worse than one that fails loudly during setup.
 */

import { logOutboundMessage } from "@/lib/whatsapp/message-log";

const GRAPH_API_VERSION = "v21.0";

export function isWhatsAppConfigured(): boolean {
  return Boolean(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

function requireConfig(): { token: string; phoneNumberId: string } {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    throw new Error("WhatsApp is not configured — missing WHATSAPP_ACCESS_TOKEN/WHATSAPP_PHONE_NUMBER_ID.");
  }
  return { token, phoneNumberId };
}

/**
 * Meta's own throttle codes, as opposed to anything wrong with the message.
 *
 *   130429  — "Rate limit hit": too many messages from this phone number id
 *   131056  — "(Business Account, Consumer Account) pair rate limit hit":
 *             too many messages to THIS ONE recipient in a short window
 *   133016  — the number is temporarily rate-limited after a bulk send
 *
 * 131056 is the one that bites here. A 10-product batch is a burst to a
 * single seller, and Meta throttles per business/consumer PAIR — so the
 * send that gets dropped is always one of the last, which is exactly the
 * shape seen live on 2026-09-15: a 10-product batch whose submit buttons
 * arrived for products 1–6 and whose closing message never arrived at all.
 */
const THROTTLE_CODES = new Set([130429, 131056, 133016]);

/** How long to wait before each retry. Two attempts, deliberately short:
 *  this runs inside a serverless invocation with the next product's
 *  analysis queued behind it, so a long backoff would trade a dropped
 *  message for a stalled batch. */
const RETRY_DELAYS_MS = [1_000, 3_000];

function throttleCodeOf(body: string): number | null {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: number } };
    const code = parsed.error?.code;
    return typeof code === "number" && THROTTLE_CODES.has(code) ? code : null;
  } catch {
    return null;
  }
}

/**
 * POST one message to the Graph API, retrying a throttle or a transient
 * upstream failure.
 *
 * Every caller in this codebase sends through a try/catch that logs and
 * moves on, so before this retry existed a throttled message was simply
 * GONE: no error surfaced to the seller, no second attempt, and the
 * conversation carried on as though the message had been delivered. A
 * dropped "Submit product 7" button is indistinguishable, from the
 * seller's side, from the product never having drafted.
 *
 * Only throttles and 5xx are retried. A 400 means the message itself is
 * malformed — sending it again just fails again, more slowly.
 */
async function callGraphApi(body: Record<string, unknown>): Promise<void> {
  const { token, phoneNumberId } = requireConfig();

  // Logged once here — the one chokepoint every send helper below funnels
  // through — rather than per caller, so nothing sent through client.ts
  // can be added later without also being logged. Logged as an attempt,
  // before the retry loop, so a send that ultimately fails after retries
  // still leaves a record of what the bot tried to say.
  if (typeof body.to === "string") {
    logOutboundMessage(body.to, body);
  }

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
    });
    if (res.ok) return;

    const text = await res.text().catch(() => "");
    const throttled = res.status === 429 || throttleCodeOf(text) != null;
    const transient = throttled || res.status >= 500;

    if (!transient || attempt >= RETRY_DELAYS_MS.length) {
      throw new Error(`WhatsApp send failed (${res.status}): ${text}`);
    }

    const wait = RETRY_DELAYS_MS[attempt];
    console.warn(
      `[whatsapp] send ${throttled ? "throttled" : `failed (${res.status})`} — ` +
      `retrying in ${wait}ms (attempt ${attempt + 2}/${RETRY_DELAYS_MS.length + 1})`,
    );
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

/** Plain text reply. With `preview`, WhatsApp shows the first link as a
 *  card (a YouTube link gets its thumbnail and title); a link inside an
 *  interactive message never gets one. */
export async function sendText(to: string, text: string, { preview = false } = {}): Promise<void> {
  await callGraphApi({
    to,
    type: "text",
    text: { body: text, preview_url: preview },
  });
}

/**
 * A short prompt with up to 3 tappable reply buttons (Meta's interactive
 * "button" message type — the max it supports is 3, each title capped at
 * 20 characters).
 */
export async function sendButtons(
  to: string,
  bodyText: string,
  buttons: { id: string; title: string }[],
): Promise<void> {
  if (buttons.length === 0 || buttons.length > 3) {
    throw new Error(`sendButtons: expected 1-3 buttons, got ${buttons.length}`);
  }
  await callGraphApi({
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText },
      action: {
        buttons: buttons.map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    },
  });
}

/**
 * Send a text reply, or log-and-skip when WhatsApp isn't configured yet
 * (local dev, or before the Meta app credentials exist). Shared by the
 * webhook route and the conversation orchestration in
 * lib/whatsapp/intake.ts so neither has to duplicate the "not configured"
 * guard.
 */
export async function sendTextIfConfigured(to: string, text: string, options?: { preview?: boolean }): Promise<void> {
  if (!isWhatsAppConfigured()) {
    console.warn(`[whatsapp] not configured — would have sent to ${to}: ${text}`);
    return;
  }
  await sendText(to, text, options);
}

/** Config-guarded wrapper around sendButtons — matches sendTextIfConfigured's
 *  "warn and skip" behavior instead of throwing when WhatsApp isn't set up. */
export async function sendButtonsIfConfigured(
  to: string,
  bodyText: string,
  buttons: { id: string; title: string }[],
): Promise<void> {
  if (!isWhatsAppConfigured()) {
    console.warn(`[whatsapp] not configured — would have sent buttons to ${to}: ${bodyText}`);
    return;
  }
  await sendButtons(to, bodyText, buttons);
}

/** Meta's hard caps on an interactive list. Exceeding any of them is a
 *  400 from the Graph API, not a truncation. */
export const LIST_MAX_ROWS       = 10;
const LIST_MAX_BUTTON_CHARS      = 20;
const LIST_MAX_ROW_TITLE_CHARS   = 24;
const LIST_MAX_ROW_DESC_CHARS    = 72;

/**
 * A picture by public link (Meta's "image" message), with an optional
 * caption under it. Meta fetches the link itself, so it has to be a public
 * https URL to a JPEG or PNG of at most 5 MB.
 */
export async function sendImage(to: string, link: string, caption?: string): Promise<void> {
  await callGraphApi({
    to,
    type: "image",
    image: caption ? { link, caption } : { link },
  });
}

export async function sendImageIfConfigured(to: string, link: string, caption?: string): Promise<void> {
  if (!isWhatsAppConfigured()) {
    console.warn(`[whatsapp] not configured — would have sent an image to ${to}: ${link}`);
    return;
  }
  await sendImage(to, link, caption);
}

/**
 * Up to 10 tappable rows in ONE message (Meta's interactive "list" type),
 * against sendButtons' three.
 *
 * This is the message-volume fix, not a cosmetic one. A 10-product batch's
 * "Submit product N" block used to go out as four separate button messages
 * (3 + 3 + 3 + 1) on top of ten per-product drafted messages and a closing
 * summary — ~25 sends to one recipient inside about 30 seconds. Meta
 * throttles per business/consumer pair, and live on 2026-09-15 that batch
 * lost its last four sends: submit buttons appeared for products 1–6 and
 * the closing message never arrived. One list replaces all four.
 *
 * A tap comes back as `interactive.list_reply`, handled alongside
 * `button_reply` in lib/whatsapp/message-content.ts — so, exactly like a
 * button, a row id IS the command phrase and flows through the same
 * deterministic parsers as typed text.
 */
export async function sendList(
  to:         string,
  bodyText:   string,
  buttonText: string,
  rows:       { id: string; title: string; description?: string }[],
): Promise<void> {
  if (rows.length === 0 || rows.length > LIST_MAX_ROWS) {
    throw new Error(`sendList: expected 1-${LIST_MAX_ROWS} rows, got ${rows.length}`);
  }
  await callGraphApi({
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: bodyText },
      action: {
        button: buttonText.slice(0, LIST_MAX_BUTTON_CHARS),
        sections: [{
          rows: rows.map((r) => ({
            id:    r.id,
            title: r.title.slice(0, LIST_MAX_ROW_TITLE_CHARS),
            ...(r.description ? { description: r.description.slice(0, LIST_MAX_ROW_DESC_CHARS) } : {}),
          })),
        }],
      },
    },
  });
}

export async function sendListIfConfigured(
  to:         string,
  bodyText:   string,
  buttonText: string,
  rows:       { id: string; title: string; description?: string }[],
): Promise<void> {
  if (!isWhatsAppConfigured()) {
    console.warn(`[whatsapp] not configured — would have sent a list to ${to}: ${bodyText}`);
    return;
  }
  await sendList(to, bodyText, buttonText, rows);
}

/**
 * A single tappable button that opens a URL directly (Meta's interactive
 * "cta_url" message) — no reply event comes back, unlike sendButtons, so
 * sending one needs no webhook-side changes. Used anywhere the whole point
 * of the message is "here's a link, tap it" (a Jumia connect link, a
 * focused-editor link for one product, ...) instead of a plain-text URL.
 */
export async function sendCtaUrl(
  to: string,
  bodyText: string,
  buttonText: string,
  url: string,
): Promise<void> {
  await callGraphApi({
    to,
    type: "interactive",
    interactive: {
      type: "cta_url",
      body: { text: bodyText },
      action: {
        name: "cta_url",
        parameters: { display_text: buttonText.slice(0, 20), url },
      },
    },
  });
}

export async function sendCtaUrlIfConfigured(
  to: string,
  bodyText: string,
  buttonText: string,
  url: string,
): Promise<void> {
  if (!isWhatsAppConfigured()) {
    console.warn(`[whatsapp] not configured — would have sent a link to ${to}: ${url}`);
    return;
  }
  await sendCtaUrl(to, bodyText, buttonText, url);
}

/**
 * Upload a file to WhatsApp's media store and return its media id, so a
 * document can be sent without a public link (a shipping label carries the
 * customer's name and address, so it never gets one).
 */
export async function uploadMedia(bytes: Uint8Array, mimeType: string, filename: string): Promise<string> {
  const { token, phoneNumberId } = requireConfig();
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`WhatsApp media upload failed (${res.status}): ${text}`);
  const id = (JSON.parse(text) as { id?: string }).id;
  if (!id) throw new Error("WhatsApp media upload returned no id");
  return id;
}

/** A PDF (shipping labels) as a WhatsApp document, uploaded first: see uploadMedia. */
export async function sendDocument(to: string, bytes: Uint8Array, filename: string, caption?: string): Promise<void> {
  const id = await uploadMedia(bytes, "application/pdf", filename);
  await callGraphApi({
    to,
    type: "document",
    document: { id, filename, ...(caption ? { caption } : {}) },
  });
}

export async function sendDocumentIfConfigured(to: string, bytes: Uint8Array, filename: string, caption?: string): Promise<void> {
  if (!isWhatsAppConfigured()) {
    console.warn(`[whatsapp] not configured — would have sent a document to ${to}: ${filename}`);
    return;
  }
  await sendDocument(to, bytes, filename, caption);
}

/**
 * An approved template (Meta's "template" message): the only kind WhatsApp
 * delivers outside the 24 hours after the recipient's last message. Body
 * values fill {{1}}, {{2}}…, in order; a value may not contain a new line.
 * Each quick-reply button gets its payload here, at send time, so a tap
 * comes back as that payload whatever language the button is written in
 * (lib/whatsapp/message-content.ts reads it as text).
 */
export async function sendTemplate(
  to:          string,
  name:        string,
  language:    string,
  bodyValues:  string[],
  buttonPayloads: string[] = [],
): Promise<void> {
  await callGraphApi({
    to,
    type: "template",
    template: {
      name,
      language: { code: language },
      components: [
        { type: "body", parameters: bodyValues.map((text) => ({ type: "text", text: text.replace(/\s*\n+\s*/g, " ") })) },
        ...buttonPayloads.map((payload, i) => ({
          type: "button", sub_type: "quick_reply", index: String(i), parameters: [{ type: "payload", payload }],
        })),
      ],
    },
  });
}

export async function sendTemplateIfConfigured(
  to: string, name: string, language: string, bodyValues: string[], buttonPayloads: string[] = [],
): Promise<void> {
  if (!isWhatsAppConfigured()) {
    console.warn(`[whatsapp] not configured — would have sent template ${name} to ${to}`);
    return;
  }
  await sendTemplate(to, name, language, bodyValues, buttonPayloads);
}

/**
 * Marks an incoming message as read (blue ticks) and shows the animated
 * "typing…" indicator in the chat for up to 25 seconds or until the next
 * message is sent, whichever comes first — Meta's Cloud API ties both to
 * the same call, keyed by the incoming message's id. Called once per
 * incoming message right as the webhook receives it (see
 * app/api/whatsapp/webhook/route.ts), before any of the actual handling
 * (image download, AI analyze, Jumia push) that can take several seconds —
 * without it the seller sees dead air the whole time.
 *
 * Best-effort and silent: a seller never needs to know this failed, and it
 * must never take down real message handling over a cosmetic indicator.
 */
export async function markReadWithTypingIfConfigured(messageId: string): Promise<void> {
  if (!isWhatsAppConfigured()) return;
  try {
    await callGraphApi({
      status: "read",
      message_id: messageId,
      typing_indicator: { type: "text" },
    });
  } catch (e) {
    console.warn(`[whatsapp] typing indicator failed for message ${messageId}: ${(e as Error).message}`);
  }
}

/**
 * Blue ticks only, no "typing…": for a message that will get no reply (a
 * seller out of credits who has had the one reply, lib/whatsapp/credit-
 * gate.ts). Best-effort and silent, like the typing version above.
 */
export async function markReadIfConfigured(messageId: string): Promise<void> {
  if (!isWhatsAppConfigured()) return;
  try {
    await callGraphApi({ status: "read", message_id: messageId });
  } catch (e) {
    console.warn(`[whatsapp] read receipt failed for message ${messageId}: ${(e as Error).message}`);
  }
}

/**
 * Fetch an incoming media attachment's bytes. WhatsApp gives you a media ID
 * in the webhook payload, not a direct URL — two hops: resolve the ID to a
 * short-lived authenticated URL, then fetch that URL with the same bearer
 * token. Returns the raw bytes; callers run them through the same
 * validateImageBuffer path as any other upload before trusting them.
 */
export async function downloadMedia(mediaId: string): Promise<Buffer> {
  const { token } = requireConfig();
  const metaRes = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!metaRes.ok) throw new Error(`WhatsApp media lookup failed (${metaRes.status})`);
  const meta = (await metaRes.json()) as { url?: string };
  if (!meta.url) throw new Error("WhatsApp media lookup returned no URL");

  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${token}` } });
  if (!fileRes.ok) throw new Error(`WhatsApp media download failed (${fileRes.status})`);
  return Buffer.from(await fileRes.arrayBuffer());
}
