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

async function callGraphApi(body: Record<string, unknown>): Promise<void> {
  const { token, phoneNumberId } = requireConfig();
  const res = await fetch(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`WhatsApp send failed (${res.status}): ${text}`);
  }
}

/** Plain text reply. */
export async function sendText(to: string, text: string): Promise<void> {
  await callGraphApi({
    to,
    type: "text",
    text: { body: text, preview_url: false },
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
