/**
 * How much of the WhatsApp assistant a seller gets (owner, 2026-10-07: "Do 1
 * and 2", after the cost review). Every AI turn costs us an AI call and the
 * WhatsApp messages it sends, so:
 *
 *   - A daily allowance of AI turns by pack (DAILY_ALLOWANCE), smaller where
 *     WhatsApp messages cost us more (COUNTRY_FACTOR: Nigeria half, Morocco a
 *     quarter). Admins and sellers who aren't charged (billing off) have no
 *     limit. Past it, the seller is told once that day, and the bot keeps to
 *     its fixed flow until tomorrow: listing by photos, the buttons, "orders",
 *     "status", "help", a product number all still work. Nothing is charged
 *     for the conversation itself.
 *   - A kill switch: app_settings `assistant_enabled` false turns the
 *     assistant off for everyone, admins included (assistantEnabled in
 *     lib/whatsapp/assistant.ts reads it).
 *   - A ceiling on all sellers' AI turns in a day (app_settings
 *     `assistant_daily_limit`, else DEFAULT_DAILY_CEILING): past it the
 *     assistant rests for everyone but admins until midnight UTC, whatever
 *     goes wrong (a loop, a flood).
 *
 * A turn is a whatsapp_assistant_log row with the AI's answer in `raw`: what
 * was asked of the AI, not the taps and numbers answered without it.
 */

import { createServerClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/is-admin";
import { isUnmetered } from "@/lib/billing/extension-credits";
import { currentPack } from "@/lib/billing/features";
import { sellerCountry } from "@/lib/jumia/unlistable-categories";
import { jumiaCountryByCode } from "@/lib/marketing/countries";

/** AI turns a day, by the pack the seller is on ("none": never bought one). */
export const DAILY_ALLOWANCE: Record<string, number> = { none: 10, starter: 20, standard: 30, pro: 50, business: 100 };

/** Where WhatsApp messages cost us more, a smaller allowance (Meta's 2026 rates). */
export const COUNTRY_FACTOR: Record<string, number> = { NG: 0.5, MA: 0.25 };

/** All sellers' AI turns in a UTC day, unless app_settings `assistant_daily_limit` says otherwise. */
export const DEFAULT_DAILY_CEILING = 2000;

/** The seller's allowance today, or null for no limit. */
export async function dailyAllowance(userId: string): Promise<number | null> {
  if (await isUnmetered(userId)) return null;
  const pack = await currentPack(userId).catch(() => null);
  const base = DAILY_ALLOWANCE[pack?.id ?? "none"] ?? DAILY_ALLOWANCE.none;
  const country = (await sellerCountry(userId).catch(() => null))?.toUpperCase() ?? "";
  return Math.max(1, Math.floor(base * (COUNTRY_FACTOR[country] ?? 1)));
}

/** Midnight today in the seller's own timezone, as an ISO instant. */
export function dayStart(timeZone: string, now = new Date()): string {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
  // The zone's offset now ("GMT+01:00"; plain "GMT" for Accra).
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(now)
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
  const offsetMin = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0;
  return new Date(Date.parse(`${day}T00:00:00Z`) - offsetMin * 60_000).toISOString();
}

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

async function turnsSince(since: string, userId?: string): Promise<number> {
  let q = createServerClient().from("whatsapp_assistant_log").select("id", { count: "exact", head: true });
  if (userId) q = q.eq("user_id", userId);
  const { count } = await q.gt("created_at", since).not("raw", "is", null);
  return count ?? 0;
}

export type AssistantGate =
  | { ok: true }
  | { ok: false; reason: "allowance"; allowance: number; told: boolean }
  | { ok: false; reason: "ceiling" };

/** Outcome logged with the turn that's told about the allowance, so it's told once a day. */
export const ALLOWANCE_TOLD = "over daily allowance: told";

/** Whether this seller may have another AI turn now. */
export async function assistantGate(userId: string, now = new Date()): Promise<AssistantGate> {
  if (isAdmin(userId)) return { ok: true };
  const utcMidnight = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const ceiling = Number(await setting("assistant_daily_limit"));
  if ((await turnsSince(utcMidnight)) >= (Number.isFinite(ceiling) && ceiling > 0 ? ceiling : DEFAULT_DAILY_CEILING)) {
    return { ok: false, reason: "ceiling" };
  }
  const allowance = await dailyAllowance(userId);
  if (allowance == null) return { ok: true };
  const tz = jumiaCountryByCode(await sellerCountry(userId).catch(() => null))?.timeZone ?? "UTC";
  const since = dayStart(tz, now);
  if ((await turnsSince(since, userId)) < allowance) return { ok: true };
  const { data } = await createServerClient().from("whatsapp_assistant_log").select("outcome, created_at")
    .eq("user_id", userId).eq("outcome", ALLOWANCE_TOLD).gt("created_at", since);
  return { ok: false, reason: "allowance", allowance, told: ((data ?? []) as unknown[]).length > 0 };
}

/** What a seller past their allowance is told, once a day. */
export function allowanceText(allowance: number): string {
  return [
    `You've used today's ${allowance} chat replies on your pack, so until tomorrow I'll keep to the usual steps.`,
    "",
    "Listing still works as always: tell me how many products (e.g. *3*), then send each one's photos. *orders*, *status* and *help* work too.",
    "Bigger packs come with more chat replies a day.",
  ].join("\n");
}
