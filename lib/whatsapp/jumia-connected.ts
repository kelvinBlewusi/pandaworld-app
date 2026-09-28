/**
 * Tell a seller in WhatsApp that Jumia is connected, when they connected on
 * the website (the login callback, or a pasted Self Authorization token on
 * /onboarding/connect) while the chat was waiting on it.
 *
 * Only for a chat in awaiting_jumia_oauth or awaiting_jumia_credentials
 * (the connect-from-chat flow in lib/whatsapp/intake.ts): it moves the
 * chat on to "how many products?". An unrelated reconnect from the website
 * mid-batch never resets a seller's batch. Best-effort: a WhatsApp hiccup
 * must never break the connection itself.
 */

import { createServerClient } from "@/lib/supabase/server";
import { getWhatsAppConnection } from "@/lib/whatsapp/link";
import { sendTextIfConfigured } from "@/lib/whatsapp/client";
import { updateSession } from "@/lib/whatsapp/session";

export async function notifyWhatsAppJumiaConnected(userId: string, storeName: string | null): Promise<void> {
  try {
    const wa = await getWhatsAppConnection(userId);
    if (!wa.connected || !wa.phoneNumber) return;
    const db = createServerClient();
    const { data: session } = await db
      .from("whatsapp_sessions")
      .select("state")
      .eq("phone_number", wa.phoneNumber)
      .maybeSingle();
    if (session?.state !== "awaiting_jumia_oauth" && session?.state !== "awaiting_jumia_credentials") return;
    await updateSession(wa.phoneNumber, {
      state: "awaiting_count", listingId: null, batchId: null, batchSize: null, batchSeq: null, pendingAppId: null,
    });
    await sendTextIfConfigured(
      wa.phoneNumber,
      `🎉 Jumia connected${storeName ? ` — ${storeName}` : ""}! How many products are you listing today? Reply with a number to get started.`,
    );
  } catch (e) {
    console.warn(`[jumia connected] WhatsApp notify failed for user=${userId}: ${(e as Error).message}`);
  }
}
