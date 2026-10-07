/**
 * What keeps the assistant in bounds. Since 2026-10-07 every seller has it,
 * on WhatsApp and the website, with no daily allowance (owner: "AI for all
 * sellers and remove daily limit"): it reads every typed message
 * (lib/whatsapp/intake.ts), and chatting is free. What's left:
 *
 *   - A kill switch: app_settings `assistant_enabled` false turns the
 *     assistant off for everyone, admins included; the fixed flow and its
 *     commands carry on alone.
 *   - A ceiling on all sellers' AI turns in a UTC day (app_settings
 *     `assistant_daily_limit`, else DEFAULT_DAILY_CEILING): past it the
 *     assistant rests for everyone but admins until midnight UTC, whatever
 *     goes wrong (a loop, a flood). The fixed flow answers meanwhile.
 *
 * A turn is a whatsapp_assistant_log row with the AI's answer in `raw`: what
 * was asked of the AI, not the taps and numbers answered without it.
 */

import { createServerClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/is-admin";

/**
 * All sellers' AI turns in a UTC day, unless app_settings
 * `assistant_daily_limit` says otherwise. About $0.001 a turn, so the
 * ceiling caps a bad day near $20.
 */
export const DEFAULT_DAILY_CEILING = 20_000;

async function setting(key: string): Promise<unknown> {
  try {
    const { data } = await createServerClient().from("app_settings").select("value").eq("key", key).maybeSingle();
    return data?.value;
  } catch {
    return undefined;
  }
}

/** The kill switch: false only when app_settings `assistant_enabled` is false. */
export async function assistantSwitchedOn(): Promise<boolean> {
  return (await setting("assistant_enabled")) !== false;
}

async function turnsSince(since: string): Promise<number> {
  const { count } = await createServerClient()
    .from("whatsapp_assistant_log")
    .select("id", { count: "exact", head: true })
    .gt("created_at", since)
    .not("raw", "is", null);
  return count ?? 0;
}

export type AssistantGate = { ok: true } | { ok: false; reason: "ceiling" };

/** Whether the assistant may take another turn now: only the day's ceiling for everyone stops it. */
export async function assistantGate(userId: string, now = new Date()): Promise<AssistantGate> {
  if (isAdmin(userId)) return { ok: true };
  const utcMidnight = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const ceiling = Number(await setting("assistant_daily_limit"));
  if ((await turnsSince(utcMidnight)) >= (Number.isFinite(ceiling) && ceiling > 0 ? ceiling : DEFAULT_DAILY_CEILING)) {
    return { ok: false, reason: "ceiling" };
  }
  return { ok: true };
}

/** Where the commands are: the / menu and + on the web, "menu" on WhatsApp. */
const commandsHint = (web: boolean) => (web ? "type */* or tap *+* for the commands" : "type *menu* for the commands");

/**
 * When the assistant is resting (the ceiling) and a question reaches the
 * fixed flow, which can't answer it: the commands still work.
 */
export function limitedText(web = false): string {
  return `I can't answer questions right now. The commands still work: ${commandsHint(web)}, or tell me how many products you're listing (e.g. *3*).`;
}
