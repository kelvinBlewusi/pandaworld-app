/**
 * WhatsApp and Jumia connections as conditions on buying credits and on the
 * Chrome extension's autofill (owner, 2026-10-07):
 *
 *   - Buying any pack needs WhatsApp linked and Jumia
 *     connected ("block credit purchase for 80 credits to 940 credits
 *     unless they have Jumia connected and WhatsApp linked ... to be able
 *     to purchase it you must link your WhatsApp and Jumia"), so a big pack
 *     isn't bought for extension autofills alone. Checked by the checkout
 *     route, and by the Buy credits modal before it shows a Buy button
 *     (GET /api/extension/credits/eligibility).
 *   - Autofill on Standard, Pro or Business (the pack bought last) needs
 *     both still connected; the seller is told which one to connect. Free
 *     sign-up credits (and Starter, no longer sold) autofill whatever is connected ("the only
 *     pack that works for the extension even in disconnection is the 80
 *     credits pack"; "free users must not need to connect the WhatsApp and
 *     Jumia to use extension").
 *
 * Admins and everyone while billing is off are never stopped.
 */

import { createServerClient } from "@/lib/supabase/server";
import { isUnmetered } from "@/lib/billing/extension-credits";
import { currentPack } from "@/lib/billing/features";
import { packRank } from "@/lib/billing/credit-packs";
import { getJumiaConnectionKind } from "@/lib/jumia/credentials";

export type Connection = "whatsapp" | "jumia";

const NAMES: Record<Connection, string> = {
  whatsapp: "link your WhatsApp number",
  jumia:    "connect your Jumia account",
};

/** Which of WhatsApp and Jumia this seller hasn't connected (or whose connection stopped working). */
export async function missingConnections(userId: string): Promise<Connection[]> {
  const [wa, jumia] = await Promise.all([
    createServerClient().from("whatsapp_connections").select("phone_number").eq("user_id", userId).limit(1),
    getJumiaConnectionKind(userId).catch(() => "needs_credentials" as const),
  ]);
  const missing: Connection[] = [];
  if (!((wa.data ?? []) as unknown[]).length) missing.push("whatsapp");
  if (jumia !== "connected") missing.push("jumia");
  return missing;
}

/** "link your WhatsApp number and connect your Jumia account". */
export function connectionsText(missing: Connection[]): string {
  return missing.map((c) => NAMES[c]).join(" and ");
}

/** Why this seller can't buy credits yet, or null when they can. */
export async function purchaseBlock(userId: string): Promise<{ message: string; missing: Connection[] } | null> {
  if (await isUnmetered(userId)) return null;
  const missing = await missingConnections(userId);
  if (missing.length === 0) return null;
  return {
    message: `To buy credits, first ${connectionsText(missing)} in Settings. Credits work best with both connected: listing from WhatsApp and the chat, your orders and your live shop.`,
    missing,
  };
}

/**
 * Why this seller's extension autofill is stopped, or null when it runs: on
 * Standard, Pro or Business, until both are connected again.
 */
export async function autofillBlock(userId: string): Promise<{ message: string; missing: Connection[] } | null> {
  if (await isUnmetered(userId)) return null;
  const pack = await currentPack(userId).catch(() => null);
  // Free credits, and a pack no longer sold (Starter), autofill whatever is connected.
  if (!pack || packRank(pack.id) < packRank("standard")) return null;
  const missing = await missingConnections(userId);
  if (missing.length === 0) return null;
  const name = pack.id.charAt(0).toUpperCase() + pack.id.slice(1);
  return {
    message: `Autofill on your ${name} pack needs your WhatsApp linked and your Jumia account connected. Open PandaWorld Settings to ${connectionsText(missing)}, then try again.`,
    missing,
  };
}
