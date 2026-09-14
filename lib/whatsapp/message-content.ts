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
export interface MessageContent {
  text?:         string;
  imageMediaId?: string;
  /**
   * Set when the message carried something the bot cannot read — a video,
   * voice note, document, sticker, location, contact card, or any future
   * type Meta adds. Carries Meta's own type string so the reply can name
   * the right thing.
   *
   * This used to return {} instead, and the message fell through the whole
   * state machine in silence: a seller sends a video of their product,
   * sees it delivered, and nothing ever comes back. Deny-by-default rather
   * than a list of known-bad types, so a type nobody has thought of yet
   * still gets an answer instead of the void.
   */
  unsupported?: string;
}

export function contentOf(msg: IncomingMessage): MessageContent {
  if (msg.type === "image" && msg.image?.id) {
    return { imageMediaId: msg.image.id, text: msg.image.caption };
  }
  if (msg.type === "interactive" && msg.interactive?.button_reply?.id) {
    return { text: msg.interactive.button_reply.id };
  }
  if (msg.text?.body) return { text: msg.text.body };
  // An image whose media id never arrived is a delivery problem, not an
  // unreadable type — treated as unsupported all the same, since the
  // seller still needs to hear something back.
  return { unsupported: msg.type || "unknown" };
}
