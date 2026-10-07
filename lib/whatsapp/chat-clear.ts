/**
 * Clearing the Listing Assistant's chat (owner, 2026-10-07: "a clear button
 * ... where it clears the chat and starts fresh like when users see it for
 * the first time"). The messages stay in the log (what was said and billed
 * is kept); the chat shows only those after `chat_cleared_at`, and the
 * assistant reads only those as the conversation. The session starts over,
 * as restart does: drafts and listings stay on List from WhatsApp, the
 * credits don't change.
 *
 * WhatsApp keeps its own copy of a chat on the phone, which only the seller
 * can clear: there "clear" says how (CLEAR_ON_WHATSAPP).
 */

import { createServerClient } from "@/lib/supabase/server";
import { isWebAddress, webAddress } from "@/lib/whatsapp/channel";
import { getOrCreateSession, resetSession } from "@/lib/whatsapp/session";

export const CLEAR_ON_WHATSAPP =
  "🧹 WhatsApp keeps this chat on your phone, so clear it there: open the chat's menu (⋮, or tap my name) → *Clear chat*. Nothing changes on PandaWorld.\n\nTo start a new batch, type *restart*.";

export const CLEAR_CONFIRM_TEXT =
  "Clear this chat? The conversation goes and I start fresh, like your first visit. Your drafts and listings stay on List from WhatsApp, and your credits don't change.";

/** The tap that clears it, under CLEAR_CONFIRM_TEXT. */
export const CLEAR_NOW_ID = "clear chat now";

/** Clears the seller's web chat; the time it was cleared. */
export async function clearWebChat(userId: string): Promise<string> {
  const address = webAddress(userId);
  await getOrCreateSession(userId, address);
  await resetSession(address);
  const at = new Date().toISOString();
  const { error } = await createServerClient().from("whatsapp_sessions").update({ chat_cleared_at: at }).eq("phone_number", address);
  if (error) throw new Error(`clearing the chat: ${error.message}`);
  return at;
}

/** When the chat at this address was last cleared (web only; WhatsApp's is on the phone). */
export async function chatClearedAt(address: string): Promise<string | null> {
  if (!isWebAddress(address)) return null;
  const { data } = await createServerClient()
    .from("whatsapp_sessions")
    .select("chat_cleared_at")
    .eq("phone_number", address)
    .maybeSingle();
  const at = (data as { chat_cleared_at?: string | null } | null)?.chat_cleared_at;
  return typeof at === "string" ? at : null;
}
