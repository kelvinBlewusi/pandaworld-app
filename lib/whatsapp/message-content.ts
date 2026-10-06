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
  interactive?: {
    button_reply?: { id: string; title: string };
    /** A tapped row from an interactive list (sendList) — up to 10 rows in
     *  one message, where a button message holds three. Carries the same
     *  { id, title } shape as button_reply, so it routes identically. */
    list_reply?:   { id: string; title: string; description?: string };
  };
  /** Present on Meta's own `type: "unsupported"` container — see
   *  METAS_OWN_UNSUPPORTED_TYPE below. */
  errors?: { code?: number; title?: string; message?: string; error_data?: { details?: string } }[];
}

/**
 * Meta's own catch-all container, as distinct from a media type WE can't
 * read.
 *
 * A video the seller actually sent arrives as `type: "video"`. THIS type
 * means WhatsApp itself could not represent the message over the Cloud
 * API at all — a poll, a view-once photo, an edited message, or the
 * grouping envelope that rides along with a multi-photo album. There is no
 * media id, no caption, and no wamid that can be marked read.
 *
 * The distinction is not academic. Confirmed in production on 2026-09-15:
 * two of these arrived in the middle of a seller's album (02:27:08 and
 * 02:29:01), and each one told them "📷 I can't read that kind of
 * message — send a photo instead" while their photos were landing
 * perfectly well in the very next message. Advice that contradicts what
 * the seller can plainly see is worse than saying nothing.
 */
export const METAS_OWN_UNSUPPORTED_TYPE = "unsupported";

/**
 * A WhatsApp image can carry a caption in the SAME message (e.g. a seller
 * attaching "Price 40, done" to a photo) — surfaced as `text` alongside
 * `imageMediaId` so intake.ts sees both instead of silently dropping the
 * caption. A tapped reply button (interactive.button_reply) or list row
 * (interactive.list_reply) surfaces as `text` too, using the tapped id — see lib/whatsapp/commands.ts's
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
  /**
   * Meta's own explanation, present only for METAS_OWN_UNSUPPORTED_TYPE.
   * Its presence is what tells intake.ts this is a platform artifact
   * rather than something the seller chose to send; its content is what
   * tells US which artifact, since Meta's error code is the only signal
   * that distinguishes an album envelope from a poll.
   *
   * Always logged. Nothing decides a seller-visible reply from its text —
   * the codes are undocumented and Meta adds to them freely.
   */
  platformError?: string;
}

function describeError(msg: IncomingMessage): string {
  const err = msg.errors?.[0];
  if (!err) return "no error detail supplied";
  const code = err.code != null ? `${err.code} ` : "";
  const detail = err.error_data?.details ?? err.message ?? "";
  return `${code}${err.title ?? "unknown"}${detail ? `: ${detail}` : ""}`;
}

export function contentOf(msg: IncomingMessage): MessageContent {
  if (msg.type === "image" && msg.image?.id) {
    return { imageMediaId: msg.image.id, text: msg.image.caption };
  }
  if (msg.type === "interactive") {
    // Button tap and list-row tap are the same thing to everything
    // downstream: the id IS the command phrase. Handled together so a
    // command can move between a button and a list row — as "submit N"
    // did, once ten of them stopped fitting in button messages — without
    // touching a single parser.
    const tapped = msg.interactive?.button_reply?.id ?? msg.interactive?.list_reply?.id;
    if (tapped) return { text: tapped };
  }
  // A quick-reply button on a TEMPLATE (an order alert sent outside the
  // 24-hour window) arrives as type "button", carrying the payload set when
  // it was sent (lib/whatsapp/client.ts sendTemplate): the same command
  // phrase an interactive button would have as its id.
  if (msg.type === "button" && msg.button?.payload) return { text: msg.button.payload };
  if (msg.text?.body) return { text: msg.text.body };
  if (msg.type === METAS_OWN_UNSUPPORTED_TYPE) {
    return { unsupported: msg.type, platformError: describeError(msg) };
  }
  // An image whose media id never arrived is a delivery problem, not an
  // unreadable type — treated as unsupported all the same, since the
  // seller still needs to hear something back.
  return { unsupported: msg.type || "unknown" };
}
