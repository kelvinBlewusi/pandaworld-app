import { randomBytes } from "node:crypto";
import { createServerClient } from "@/lib/supabase/server";
import { sendCtaUrlIfConfigured } from "@/lib/whatsapp/client";
import { appUrl } from "@/lib/whatsapp/app-url";

/**
 * Account linking for the WhatsApp chatbot (server-only — imported by API
 * routes, never by a client component). See
 * supabase/migrations/2026-09-10_whatsapp-connections.sql for the schema
 * and the reasoning for why link codes are plaintext (short-lived,
 * single-use nonces, not bearer credentials).
 */

const LINK_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Generates an 8-char uppercase alphanumeric code, e.g. "A1B2C3D4".
 *
 * base64url's `-`/`_` characters get stripped below, which can leave fewer
 * than 8 characters from a single 6-byte draw (~23% of the time). Keep
 * drawing more bytes and appending until there's enough to slice — never
 * return a code shorter than 8, since LINK_CODE_RE requires exactly 8.
 */
export function generateCode(): string {
  let out = "";
  while (out.length < 8) {
    out += randomBytes(6).toString("base64url").replace(/[^A-Za-z0-9]/g, "");
  }
  return out.slice(0, 8).toUpperCase();
}

/**
 * Create a new link code for this user and return it plus the ready-to-tap
 * wa.me deep link. Doesn't invalidate any earlier unused codes for the same
 * user — a seller who generates a few in a row (e.g. one expired) just ends
 * up with several valid codes, all resolving to the same account, which is
 * harmless.
 */
export async function createLinkCode(userId: string): Promise<{ code: string; waLink: string }> {
  const db = createServerClient();
  const botNumber = process.env.WHATSAPP_BOT_NUMBER; // E.164, digits only, e.g. "233241234567"

  // Retry once on the (astronomically unlikely) primary-key collision
  // rather than trusting an 8-char random code is always unique forever.
  for (let attempt = 0; attempt < 2; attempt++) {
    const code = generateCode();
    const { error } = await db.from("whatsapp_link_codes").insert({
      code,
      user_id: userId,
      expires_at: new Date(Date.now() + LINK_CODE_TTL_MS).toISOString(),
    });
    if (!error) {
      const waLink = botNumber
        ? `https://wa.me/${botNumber}?text=${encodeURIComponent(`LINK-${code}`)}`
        : "";
      return { code, waLink };
    }
    if (attempt === 1) throw new Error(`Failed to create link code: ${error.message}`);
  }
  throw new Error("Failed to create link code");
}

/**
 * Redeem a "LINK-<code>" message: validate the code (exists, unused,
 * unexpired), mark it used, and upsert the whatsapp_connections row for
 * this phone number. Returns the linked userId, or an error reason.
 */
export async function redeemLinkCode(
  rawCode: string,
  phoneNumber: string,
  displayName?: string | null,
): Promise<{ userId: string } | { error: "invalid" | "expired" | "used" }> {
  const db = createServerClient();
  const code = rawCode.trim().toUpperCase();

  const { data: row } = await db
    .from("whatsapp_link_codes")
    .select("user_id, expires_at, used_at")
    .eq("code", code)
    .maybeSingle();

  if (!row) return { error: "invalid" };
  if (row.used_at) return { error: "used" };
  if (new Date(row.expires_at as string) < new Date()) return { error: "expired" };

  // Mark used first — if the connection upsert below fails, the code is
  // still burned rather than left replayable.
  await db.from("whatsapp_link_codes").update({ used_at: new Date().toISOString() }).eq("code", code);

  const userId = row.user_id as string;
  const { error: upsertError } = await db.from("whatsapp_connections").upsert(
    {
      user_id: userId,
      phone_number: phoneNumber,
      display_name: displayName ?? null,
      linked_at: new Date().toISOString(),
    },
    { onConflict: "phone_number" },
  );
  if (upsertError) throw new Error(`Failed to save WhatsApp connection: ${upsertError.message}`);

  return { userId };
}

/** Look up the PandaWorld user linked to a WhatsApp number, or null. */
export async function getUserIdForPhoneNumber(phoneNumber: string): Promise<string | null> {
  const db = createServerClient();
  const { data } = await db
    .from("whatsapp_connections")
    .select("user_id")
    .eq("phone_number", phoneNumber)
    .maybeSingle();
  return (data?.user_id as string | undefined) ?? null;
}

export interface WhatsAppConnectionPublic {
  connected:    boolean;
  phoneNumber?: string;
  linkedAt?:    string;
}

/** Connection status for the current user — feeds the Settings page. */
export async function getWhatsAppConnection(userId: string): Promise<WhatsAppConnectionPublic> {
  const db = createServerClient();
  const { data } = await db
    .from("whatsapp_connections")
    .select("phone_number, linked_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return { connected: false };
  return { connected: true, phoneNumber: data.phone_number as string, linkedAt: data.linked_at as string };
}

/**
 * Disconnect — removes the link so this number stops being actionable.
 * Sends the number a final notice first (fetched before the row is gone) —
 * a disconnect triggered from the website would otherwise be invisible to
 * the seller until they next tried messaging the bot and got "this number
 * isn't linked yet", with no idea why.
 */
export async function disconnectWhatsApp(userId: string): Promise<void> {
  const db = createServerClient();
  const { data } = await db
    .from("whatsapp_connections")
    .select("phone_number")
    .eq("user_id", userId)
    .maybeSingle();

  await db.from("whatsapp_connections").delete().eq("user_id", userId);

  const phoneNumber = data?.phone_number as string | undefined;
  if (phoneNumber) {
    await sendCtaUrlIfConfigured(
      phoneNumber,
      "🔌 This number has been disconnected from PandaWorld from the website. Reconnect any time.",
      "Reconnect WhatsApp",
      `${appUrl()}/extension/settings`,
    ).catch((e) => console.warn(`[whatsapp] disconnect notice failed for ${phoneNumber}: ${(e as Error).message}`));
  }
}
