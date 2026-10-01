/**
 * Logs every WhatsApp message — inbound and outbound — to
 * whatsapp_message_log, so a real conversation can be reviewed later
 * instead of only existing on the seller's phone. Closes a gap hit
 * repeatedly live: neither the app nor Vercel's runtime logs kept a
 * queryable record of what was actually said, and Vercel's own logs are
 * ephemeral, rate-limited, and never captured message bodies at all.
 *
 * Both log functions are fire-and-forget and swallow their own errors —
 * a logging hiccup must never slow down or break an actual send/receive,
 * the same rule deductCredits follows elsewhere in this codebase.
 */

import { createServerClient } from "@/lib/supabase/server";

interface LogFields {
  phoneNumber: string;
  direction:   "inbound" | "outbound";
  messageType: string;
  bodyText?:   string | null;
  wamid?:      string | null;
  payload?:    Record<string, unknown> | null;
}

async function insertLog(fields: LogFields): Promise<void> {
  try {
    const db = createServerClient();
    const { error } = await db.from("whatsapp_message_log").insert({
      phone_number: fields.phoneNumber,
      direction:    fields.direction,
      message_type: fields.messageType,
      body_text:    fields.bodyText ?? null,
      wamid:        fields.wamid ?? null,
      payload:      fields.payload ?? null,
    });
    if (error) console.warn(`[whatsapp] message log insert failed: ${error.message}`);
  } catch (e) {
    console.warn(`[whatsapp] message log insert threw: ${(e as Error).message}`);
  }
}

/** Log an inbound message — call with the same normalized shape
 *  contentOf() already produces, so the webhook route doesn't need to
 *  re-derive anything just to log it. */
export function logInboundMessage(
  phoneNumber: string,
  wamid:       string,
  messageType: string,
  bodyText:    string | null,
  payload?:    Record<string, unknown>,
): void {
  void insertLog({ phoneNumber, direction: "inbound", messageType, bodyText, wamid, payload });
}

/**
 * Pure extraction: what callGraphApi's `body` (the exact object about to
 * be POSTed to the Graph API) says about the message being sent, or null
 * for the mark-read/typing-indicator call (`status: "read"`), which
 * carries no message content of its own. Split out from
 * logOutboundMessage so the branching per Graph API message shape
 * (text/image/button/list/cta_url) has a return value a test can assert on,
 * rather than only being reachable through a fire-and-forget DB insert.
 */
export function describeOutboundMessage(
  to:   string,
  body: Record<string, unknown>,
): Omit<LogFields, "wamid"> | null {
  if (body.status === "read") return null;

  const type = body.type as string | undefined;
  if (type === "text") {
    const text = (body.text as { body?: string } | undefined)?.body;
    return { phoneNumber: to, direction: "outbound", messageType: "text", bodyText: text ?? null };
  }

  if (type === "image") {
    const image = body.image as { link?: string; caption?: string } | undefined;
    return { phoneNumber: to, direction: "outbound", messageType: "image", bodyText: image?.caption ?? null, payload: { link: image?.link } };
  }

  if (type === "interactive") {
    const interactive = body.interactive as {
      type?:   string;
      body?:   { text?: string };
      action?: {
        buttons?:  { reply?: { id?: string; title?: string } }[];
        button?:   string;
        sections?: { rows?: { id?: string; title?: string; description?: string }[] }[];
        name?:     string;
        parameters?: { display_text?: string; url?: string };
      };
    } | undefined;
    const bodyText = interactive?.body?.text ?? null;
    const kind = interactive?.type;

    if (kind === "button") {
      const buttons = (interactive?.action?.buttons ?? []).map((b) => b.reply);
      return { phoneNumber: to, direction: "outbound", messageType: "button", bodyText, payload: { buttons } };
    }
    if (kind === "list") {
      const rows = interactive?.action?.sections?.[0]?.rows ?? [];
      return { phoneNumber: to, direction: "outbound", messageType: "list", bodyText, payload: { buttonText: interactive?.action?.button, rows } };
    }
    if (kind === "cta_url") {
      const params = interactive?.action?.parameters;
      return { phoneNumber: to, direction: "outbound", messageType: "cta_url", bodyText, payload: { buttonText: params?.display_text, url: params?.url } };
    }
  }

  return null;
}

/**
 * Log an outbound message from the exact body callGraphApi is about to
 * POST to the Graph API — one call site covers every send helper in
 * client.ts (text, image, buttons, list, cta_url) with no per-caller wiring.
 */
export function logOutboundMessage(to: string, body: Record<string, unknown>): void {
  const fields = describeOutboundMessage(to, body);
  if (fields) void insertLog(fields);
}
