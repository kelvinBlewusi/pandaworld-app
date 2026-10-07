/**
 * The Listing Assistant's page (app/extension/(app)/assistant) talks to the
 * bot through these: a message in, the conversation out. The bot itself is
 * the WhatsApp one, under the seller's web address (lib/whatsapp/channel.ts).
 *
 * Who has it: the assistant's pilot (assistantEnabled: admins and app_settings
 * `assistant_users`; `["*"]` for everyone), and never while the assistant's
 * kill switch is off.
 */

import { createServerClient } from "@/lib/supabase/server";
import { assistantEnabled } from "@/lib/whatsapp/assistant";
import { webAddress } from "@/lib/whatsapp/channel";
import { recordInboundMessage } from "@/lib/whatsapp/message-log";
import { WEB_MEDIA_PREFIX } from "@/lib/whatsapp/media";
import { handleLinkedMessage } from "@/lib/whatsapp/intake";

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

export const listingAssistantFor = (userId: string) => assistantEnabled(userId);

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

/** A photo's media id from the page, if it's this seller's own upload. */
function ownMedia(userId: string, mediaId: string | null | undefined): string | null {
  if (!mediaId || !mediaId.startsWith(WEB_MEDIA_PREFIX)) return null;
  const path = mediaId.slice(WEB_MEDIA_PREFIX.length);
  return path.startsWith(`${userId}/`) && !path.includes("..") ? mediaId : null;
}

/**
 * A message from the page: recorded (a photo with its link, a tap with the
 * button's words), then handled by the bot exactly as one from WhatsApp.
 * `id` is the page's own id for it, so a resend isn't handled twice.
 */
export async function receiveAssistantMessage(
  userId: string,
  input: { id: string; text?: string | null; mediaId?: string | null; label?: string | null },
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
  await handleLinkedMessage(userId, address, id, { ...(text ? { text } : {}), ...(mediaId ? { imageMediaId: mediaId } : {}) });
  return { ok: true };
}
