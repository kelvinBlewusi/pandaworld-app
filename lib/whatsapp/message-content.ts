/**
 * Reduces Meta's raw webhook message shape to the bit
 * lib/whatsapp/intake.ts cares about. Split out from the webhook route for
 * the same reason webhook-verify.ts is — unit-testable without spinning up
 * a NextRequest or pulling in Supabase.
 */

export interface IncomingMessage {
  id:   string; // Meta's wamid — used to de-dupe retried webhook deliveries
  from: string;
  type: string;
  text?: { body: string };
  image?: { id: string; mime_type?: string; caption?: string };
  button?: { text: string; payload: string };
  interactive?: { button_reply?: { id: string; title: string } };
}

/**
 * A WhatsApp image can carry a caption in the SAME message (e.g. a seller
 * attaching "Price 40, done" to a photo) — surfaced as `text` alongside
 * `imageMediaId` so intake.ts sees both instead of silently dropping the
 * caption. A tapped reply button (interactive.button_reply) surfaces as
 * `text` too, using the button's id — see lib/whatsapp/commands.ts's
 * design note: button ids ARE the canonical command phrases ("done",
 * "resend", "submit all", ...), so a tap flows through the exact same
 * deterministic parsers already used for typed text, with no new parsing
 * logic needed per button.
 */
export function contentOf(msg: IncomingMessage): { text?: string; imageMediaId?: string } {
  if (msg.type === "image" && msg.image?.id) {
    return { imageMediaId: msg.image.id, text: msg.image.caption };
  }
  if (msg.type === "interactive" && msg.interactive?.button_reply?.id) {
    return { text: msg.interactive.button_reply.id };
  }
  if (msg.text?.body) return { text: msg.text.body };
  return {};
}
