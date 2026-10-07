/**
 * What the assistant remembers about a seller across their whole journey
 * (owner, 2026-10-07: "you do not make it about what we just said but about
 * our entire journey"). The prompt carries the last messages as they were;
 * this carries everything before them, as a short running summary in
 * seller_memory: what they sell, how they like to work, what's unfinished,
 * what went wrong before.
 *
 * Refreshed by the AI every MEMORY_EVERY of the seller's messages, from the
 * previous summary and their recent conversation on WhatsApp and the
 * website. Codes (a Client ID, a token, a key) are blanked before anything
 * reaches the AI, and the summary is told never to hold one.
 */

import { createServerClient } from "@/lib/supabase/server";
import { callGeminiBackend } from "@/lib/ai/gemini-client";
import { withAiUsageContext } from "@/lib/ai/usage";
import { webAddress } from "@/lib/whatsapp/channel";

/** The seller's messages between two refreshes of the summary. */
export const MEMORY_EVERY = 12;
/** The first summary, after this many. */
const FIRST_MEMORY_AT = 4;
const MEMORY_MAX = 900;
const MEMORY_MODEL = "gemini-2.5-flash-lite";

/**
 * A pasted code (Client ID, token, API key, LINK code) as "[a code]": a
 * UUID, or a long unbroken run of letters, digits and _-. that isn't a word
 * or a number.
 */
export function blankCodes(text: string): string {
  return text
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{8,14}\b/gi, "[a code]")
    .replace(/\b(?:pw_live_|LINK-)\S+/gi, "[a code]")
    .replace(/(?<![\w/.])(?=[A-Za-z0-9_\-.]*\d)(?=[A-Za-z0-9_\-.]*[A-Za-z])[A-Za-z0-9_\-.]{24,}(?![\w/.])/g, "[a code]");
}

/** The summary, or "" when there's none yet. */
export async function sellerMemory(userId: string): Promise<string> {
  try {
    const { data } = await createServerClient().from("seller_memory").select("summary").eq("user_id", userId).maybeSingle();
    return typeof data?.summary === "string" ? data.summary : "";
  } catch {
    return "";
  }
}

/** The seller's addresses: their linked WhatsApp number(s) and their web chat. */
async function addresses(userId: string): Promise<string[]> {
  const { data } = await createServerClient().from("whatsapp_connections").select("phone_number").eq("user_id", userId);
  const numbers = ((data ?? []) as { phone_number: string | null }[])
    .map((r) => (r.phone_number ?? "").replace(/^\+/, ""))
    .filter(Boolean);
  return [...numbers, webAddress(userId)];
}

/** Their recent conversation, everywhere, oldest first, codes blanked. */
async function recentLines(userId: string, limit = 60): Promise<string[]> {
  const { data } = await createServerClient()
    .from("whatsapp_message_log")
    .select("direction, message_type, body_text, created_at")
    .in("phone_number", await addresses(userId))
    .order("created_at", { ascending: false })
    .limit(limit);
  return ((data ?? []) as { direction: string; message_type: string | null; body_text: string | null; created_at: string }[])
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map((r) => {
      const body = (r.body_text ?? "").trim();
      const shown = !body ? (r.message_type === "image" ? "[a photo]" : "[a message]")
        : /^[a-z_]+:\S+$/i.test(body) ? "[tapped a button]" : blankCodes(body.replace(/\s+/g, " ").slice(0, 240));
      return `${String(r.created_at).slice(0, 10)} ${r.direction === "inbound" ? "Seller" : "Bot"}: ${shown}`;
    });
}

export function memoryPrompt(previous: string, lines: string[]): string {
  return [
    "You keep short notes about a seller who uses PandaWorld (it lists their products on Jumia and helps run their Jumia shop by chat).",
    "Update the notes from the previous notes and their recent conversation below. Keep what lasts and still matters:",
    "- what they sell and their shop (kinds of products, typical prices and currency, brands)",
    "- how they like to work (one product at a time or many, photos then price, the language or words they use)",
    "- what's unfinished or promised to come back to (a product waiting for a price, a rejected listing, a question not answered)",
    "- problems they had and what solved them; things they asked for that PandaWorld can't do",
    "Drop what's done and no longer matters. Never write a code, token, Client ID, key, password, phone number or email.",
    `Plain short lines starting with "- ", at most ${MEMORY_MAX - 100} characters in all. Only the notes, nothing else.`,
    "",
    "Previous notes:",
    previous || "(none yet)",
    "",
    "Recent conversation (oldest first):",
    ...lines,
  ].join("\n");
}

/**
 * Counts this message and, every MEMORY_EVERY of them, refreshes the
 * summary. Never throws: a summary that didn't refresh is tried again on
 * the next count.
 */
export async function noteSellerMessage(userId: string): Promise<void> {
  try {
    const db = createServerClient();
    const { data } = await db.from("seller_memory").select("summary, since_refresh").eq("user_id", userId).maybeSingle();
    const row = data as { summary: string | null; since_refresh: number | null } | null;
    const count = (row?.since_refresh ?? 0) + 1;
    // The first summary comes early, so a new seller is remembered soon.
    if (count < (row?.summary ? MEMORY_EVERY : FIRST_MEMORY_AT)) {
      await db.from("seller_memory").upsert({ user_id: userId, since_refresh: count }, { onConflict: "user_id" });
      return;
    }
    const lines = await recentLines(userId);
    if (lines.length === 0) return;
    const { text } = await withAiUsageContext({ feature: "assistant", userId }, () =>
      callGeminiBackend(MEMORY_MODEL, [{ text: memoryPrompt(row?.summary ?? "", lines) }]));
    const summary = blankCodes(text.trim()).slice(0, MEMORY_MAX);
    if (!summary) return;
    await db.from("seller_memory").upsert(
      { user_id: userId, summary, since_refresh: 0, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
  } catch (e) {
    console.warn(`[seller memory] ${userId}: ${(e as Error).message}`);
  }
}
