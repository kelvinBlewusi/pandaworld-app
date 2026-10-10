/**
 * Details Jumia won't change once a product is approved (owner, 2026-10-09,
 * from a refused change on WhatsApp: "The [color] cannot be updated since the
 * product has been already approved in at least one country."). Jumia names
 * the detail in its refusal; each one it names is kept (app_settings
 * `jumia_locked_attributes`), so the next seller asking to change it on an
 * approved product is told straight away instead of after a refused feed.
 * Jumia's documentation doesn't list them, so the list grows from what it
 * says, starting with the one it has said.
 */

import { createServerClient } from "@/lib/supabase/server";

const KEY = "jumia_locked_attributes";
/** Refused for the owner's neck fan, 2026-10-09. */
const SEEN: string[] = ["color"];
const CACHE_MS = 10 * 60_000;
let cache: { at: number; names: Set<string> } | null = null;

const LOCKED_RE = /\[([a-z0-9_ ]{1,60})\]\s*cannot be updated since the product has (?:already )?been (?:already )?approved/i;

/** The detail Jumia's refusal says is locked after approval, or null. Pure. */
export function lockedDetailIn(reason: string | null | undefined): string | null {
  const m = (reason ?? "").match(LOCKED_RE);
  return m ? m[1].trim().toLowerCase() : null;
}

/** A detail's name as a seller says it: "color_family" → "colour". Pure. */
export function detailWord(name: string, label?: string | null): string {
  const w = (label || name).replace(/_/g, " ").replace(/\bfamily\b/i, "").trim().toLowerCase();
  return w.replace(/\bcolor\b/g, "colour") || name;
}

/** Why Jumia refused it, in words a seller can act on. Pure. */
export function lockedText(word: string, value?: string | null): string {
  return `Jumia doesn't let a product's ${word} change once its quality check has approved it.` +
    (value ? ` To sell one in ${value}, list it as a new product, or ask Jumia's seller support to correct this one.` : " To change it, list it as a new product, or ask Jumia's seller support to correct this one.");
}

/** The details known to be locked after approval. */
export async function lockedDetails(): Promise<Set<string>> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.names;
  const names = new Set(SEEN);
  try {
    const { data } = await createServerClient().from("app_settings").select("value").eq("key", KEY).maybeSingle();
    const v = (data as { value?: unknown } | null)?.value;
    if (Array.isArray(v)) for (const n of v) if (typeof n === "string" && n) names.add(n.toLowerCase());
  } catch {
    // The ones seen so far still count.
  }
  cache = { at: Date.now(), names };
  return names;
}

/** Keeps a detail Jumia said is locked, for every seller after. */
export async function rememberLocked(name: string): Promise<void> {
  const n = name.trim().toLowerCase();
  if (!n) return;
  const names = await lockedDetails();
  if (names.has(n)) return;
  names.add(n);
  cache = { at: Date.now(), names };
  await createServerClient().from("app_settings")
    .upsert({ key: KEY, value: Array.from(names).sort(), updated_at: new Date().toISOString() }, { onConflict: "key" })
    .then(() => undefined, () => undefined);
}
