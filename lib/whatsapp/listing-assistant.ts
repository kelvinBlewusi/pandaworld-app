/**
 * The Listing Assistant's page (app/extension/(app)/assistant) talks to the
 * bot through these: a message in, the conversation out. The bot itself is
 * the WhatsApp one, under the seller's web address (lib/whatsapp/channel.ts).
 *
 * Who has it: every signed-in seller since 2026-10-07 (the pilot before),
 * never while the assistant's kill switch is off. The conversational AI on
 * WhatsApp stays the pilot's (assistantFor in lib/whatsapp/assistant.ts).
 */

import { createServerClient } from "@/lib/supabase/server";
import { assistantSwitchedOn } from "@/lib/whatsapp/assistant-limits";
import { webAddress } from "@/lib/whatsapp/channel";
import { sendButtonsIfConfigured, sendTextIfConfigured } from "@/lib/whatsapp/client";
import { recordInboundMessage } from "@/lib/whatsapp/message-log";
import { WEB_MEDIA_PREFIX } from "@/lib/whatsapp/media";
import { handleLinkedMessage } from "@/lib/whatsapp/intake";
import { botPausedForCredits, creditGate } from "@/lib/whatsapp/credit-gate";

/** One message as the page shows it. */
export interface AssistantMessage {
  id:        string;
  /** The page's own id for a message it sent, so it can replace its placeholder. */
  clientId:  string | null;
  direction: "inbound" | "outbound";
  type:      string;
  text:      string | null;
  payload:   Record<string, unknown> | null;
  at:        string;
}

export const listingAssistantFor = (_userId: string) => assistantSwitchedOn();

/** The conversation, oldest first: the last `limit` messages, or those after `after` (an ISO time). */
export async function assistantMessages(userId: string, opts: { after?: string | null; limit?: number } = {}): Promise<AssistantMessage[]> {
  const limit = Math.min(Math.max(opts.limit ?? 80, 1), 200);
  let q = createServerClient()
    .from("whatsapp_message_log")
    .select("id, direction, message_type, body_text, payload, created_at, wamid")
    .eq("phone_number", webAddress(userId));
  if (opts.after) q = q.gt("created_at", opts.after);
  const { data } = await q.order("created_at", { ascending: false }).limit(limit);
  return ((data ?? []) as { id: string; direction: string; message_type: string | null; body_text: string | null; payload: Record<string, unknown> | null; created_at: string; wamid: string | null }[])
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .slice(-limit)
    .map((r) => ({
      id: String(r.id), clientId: r.wamid ?? null, direction: r.direction === "inbound" ? "inbound" : "outbound", type: r.message_type ?? "text",
      text: r.body_text, payload: r.payload, at: r.created_at,
    }));
}

/**
 * Whether the chat is locked at 0 credits (lib/whatsapp/credit-gate.ts): the
 * page then locks its composer until the balance is above 0 again. The
 * first time, the bot's one "top up" reply is put in the conversation, so a
 * seller who opens the page at 0 is told why before it locks.
 */
export async function creditLock(userId: string): Promise<boolean> {
  if (!(await botPausedForCredits(userId))) return false;
  await creditGate(userId, webAddress(userId), undefined); // sends the one reply, once
  return true;
}

/** A photo's media id from the page, if it's this seller's own upload. */
function ownMedia(userId: string, mediaId: string | null | undefined): string | null {
  if (!mediaId || !mediaId.startsWith(WEB_MEDIA_PREFIX)) return null;
  const path = mediaId.slice(WEB_MEDIA_PREFIX.length);
  return path.startsWith(`${userId}/`) && !path.includes("..") ? mediaId : null;
}

/** The product being collected, while the seller is sending a batch's photos. */
interface Collecting { batchId: string | null; seq: number; size: number }

async function collecting(address: string): Promise<Collecting | null> {
  const { data } = await createServerClient()
    .from("whatsapp_sessions")
    .select("state, batch_id, batch_seq, batch_size")
    .eq("phone_number", address)
    .maybeSingle();
  const s = data as { state: string; batch_id: string | null; batch_seq: number | null; batch_size: number | null } | null;
  return s?.state === "awaiting_photos" ? { batchId: s.batch_id, seq: s.batch_seq ?? 1, size: s.batch_size ?? 1 } : null;
}

/** How many messages the bot has sent here, to tell whether it answered one. */
async function replyCount(address: string): Promise<number | null> {
  const { count, error } = await createServerClient()
    .from("whatsapp_message_log")
    .select("id", { count: "exact", head: true })
    .eq("phone_number", address)
    .eq("direction", "outbound");
  return error ? null : count ?? 0;
}

/** One product of the batch so far: its photos, and whether it has notes. */
async function productSoFar(userId: string, at: Collecting, seq: number): Promise<{ photos: number; notes: boolean } | null> {
  if (!at.batchId) return null;
  const { data } = await createServerClient()
    .from("listings")
    .select("images, user_prompt")
    .eq("user_id", userId)
    .eq("whatsapp_batch_id", at.batchId)
    .eq("whatsapp_seq", seq)
    .limit(1);
  const row = ((data ?? []) as { images: string[] | null; user_prompt: string | null }[])[0];
  return row ? { photos: (row.images ?? []).filter(Boolean).length, notes: Boolean(row.user_prompt?.trim()) } : null;
}

const photoCount = (p: { photos: number; notes: boolean }) =>
  `${p.photos} photo${p.photos === 1 ? "" : "s"}${p.notes ? ", notes saved" : ""}`;

/**
 * What the seller hears on the web while sending a product's photos, where
 * WhatsApp says nothing. There, a photo gets no reply (each would be a paid
 * message, once per photo of an album) and the quiet way of sending (I)
 * moves from product to product in silence; the seller's own WhatsApp shows
 * the photos went. Here, silence after an upload reads as "it didn't work"
 * (owner, 2026-10-07: "I uploaded an image and got no response"). So when
 * the bot said nothing: a product that closed is confirmed with the next one
 * named, and the last photo of an upload gets the count with a Done button.
 * Messages here cost nothing.
 */
async function sayWhereWeAre(
  userId: string,
  address: string,
  before: Collecting,
  repliesBefore: number | null,
  sent: { photo: boolean; lastPhoto: boolean; text: string | null },
) {
  if (repliesBefore == null || (await replyCount(address)) !== repliesBefore) return; // the bot answered (or we can't tell)
  const now = await collecting(address);
  if (!now || now.batchId !== before.batchId) return;

  if (now.seq > before.seq) {
    const closed = await productSoFar(userId, before, before.seq);
    await sendTextIfConfigured(
      address,
      `✅ Product ${before.seq} saved${closed ? ` (${photoCount(closed)})` : ""}. ` +
        `Next: product ${now.seq} of ${now.size}. Upload its photos with the price and notes.`,
    );
    return;
  }
  if (sent.photo && !sent.lastPhoto) return; // more of this upload is on its way
  // An earlier product's number, which the quiet way ignores: not a note.
  if (!sent.photo && /^\*?\d{1,2}\*?[.,!]*$/.test(sent.text ?? "")) return;

  const product = await productSoFar(userId, now, now.seq);
  const which = now.size > 1 ? `Product ${now.seq} of ${now.size}` : "Your product";
  if (!product) {
    if (!sent.photo) await sendTextIfConfigured(address, `📝 Noted for product ${now.seq}. Upload its photos next.`);
    return;
  }
  const next = product.notes
    ? "Upload more photos, or tap *Done* when it's complete."
    : "Type its price and any notes, or tap *Done* when it's complete.";
  await sendButtonsIfConfigured(
    address,
    sent.photo ? `📷 ${which}: ${photoCount(product)}. ${next}` : `📝 Noted for product ${now.seq} (${photoCount(product)}). ${next}`,
    [{ id: "done", title: "Done ✅" }],
  );
}

/**
 * A message from the page: recorded (a photo with its link, a tap with the
 * button's words), then handled by the bot exactly as one from WhatsApp.
 * `id` is the page's own id for it, so a resend isn't handled twice.
 * `last` is false on every photo of an upload but the final one.
 */
export async function receiveAssistantMessage(
  userId: string,
  input: { id: string; text?: string | null; mediaId?: string | null; label?: string | null; last?: boolean | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const address = webAddress(userId);
  const text = (input.text ?? "").trim().slice(0, 2000) || undefined;
  const mediaId = ownMedia(userId, input.mediaId);
  if (input.mediaId && !mediaId) return { ok: false, error: "That photo isn't yours to send." };
  if (!text && !mediaId) return { ok: false, error: "Nothing to send." };
  const id = input.id.slice(0, 80);

  const link = mediaId ? createServerClient().storage.from("product-images").getPublicUrl(mediaId.slice(WEB_MEDIA_PREFIX.length)).data.publicUrl : null;
  const label = input.label?.trim().slice(0, 80) || null;
  await recordInboundMessage(
    address, id, mediaId ? "image" : label ? "interactive" : "text", text ?? null,
    mediaId ? { imageMediaId: mediaId, link } : label ? { label } : undefined,
  );
  const [before, repliesBefore] = await Promise.all([collecting(address), replyCount(address)]);
  await handleLinkedMessage(userId, address, id, { ...(text ? { text } : {}), ...(mediaId ? { imageMediaId: mediaId } : {}) });
  if (before) await sayWhereWeAre(userId, address, before, repliesBefore, { photo: Boolean(mediaId), lastPhoto: input.last !== false, text: text ?? null });
  return { ok: true };
}
