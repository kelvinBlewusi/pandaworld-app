/**
 * A drafted product held because its category requires a field it has no
 * value for (lib/whatsapp/readiness.ts → missingFields): filled by the bot
 * where it can be, otherwise asked for in chat (askForNextMissingValue in
 * lib/whatsapp/intake.ts) and saved from the seller's reply.
 *
 * Live, 2026-10-01: "Product 1: ⚠️ Held — this category also needs Weight
 * (kg)", and the only way on was the editor. A weight is one number the
 * seller knows, so it's asked for where they already are.
 */

import { createServerClient } from "@/lib/supabase/server";
import { extractAttributesForCategory } from "@/lib/actions/ai";
import { columnFor, fieldChangeToUpdate } from "@/lib/jumia/attribute-mapping";
import type { JumiaCategoryAttribute } from "@/lib/jumia/categories";

/** Columns holding a measurement: a weight in kg, sizes in cm. */
const MEASUREMENT_COLUMNS = new Set(["weight_kg", "size_l", "size_w", "size_h"]);

/** How many allowed values still fit in one list message (Meta's row cap, less Skip). */
export const MAX_LISTED_VALUES = 9;

function isNumeric(attr: JumiaCategoryAttribute): boolean {
  const col = columnFor(attr.name);
  return attr.type === "number" || (col != null && MEASUREMENT_COLUMNS.has(col));
}

/** The allowed value a reply names: a tapped row (`value:3`), the value itself, or the one value it starts. */
function matchAllowed(allowed: string[], text: string): string | null {
  const tapped = /^value:(\d+)$/.exec(text);
  if (tapped) return allowed[Number(tapped[1])] ?? null;
  const t = text.toLowerCase();
  const exact = allowed.find((v) => v.toLowerCase() === t);
  if (exact) return exact;
  const starts = allowed.filter((v) => v.toLowerCase().startsWith(t));
  if (starts.length === 1) return starts[0];
  const contains = allowed.filter((v) => v.toLowerCase().includes(t));
  return contains.length === 1 ? contains[0] : null;
}

/**
 * Read a reply (or an AI value) as this field's value. A weight takes "0.5",
 * "0.5kg" or "500g"; a field with allowed values takes one of them; text is
 * taken as written, within the field's length limits.
 */
export function parseMissingValue(
  attr: JumiaCategoryAttribute,
  text: string,
): { ok: true; value: string } | { ok: false; hint: string } {
  const t = text.trim();
  const allowed = attr.allowed_values ?? [];

  if (allowed.length > 0) {
    const value = t ? matchAllowed(allowed, t) : null;
    if (value) return { ok: true, value };
    return {
      ok: false,
      hint: allowed.length <= MAX_LISTED_VALUES
        ? `Pick one of: ${allowed.join(", ")}.`
        : `Reply with one of Jumia's options for it, e.g. ${allowed.slice(0, 3).join(", ")}.`,
    };
  }

  if (isNumeric(attr)) {
    const weight = columnFor(attr.name) === "weight_kg";
    const m = /(\d+(?:\.\d+)?)\s*(kgs?|kilo(?:gram)?s?|g|gr|grams?)?\b/i.exec(t.replace(/(\d),(\d)/g, "$1.$2"));
    let n = m ? parseFloat(m[1]) : NaN;
    if (weight && m?.[2] && /^g/i.test(m[2])) n = n / 1000;
    if (!Number.isFinite(n) || n <= 0) {
      return { ok: false, hint: weight ? "Reply with the weight in kg, e.g. *0.5* (or *500g*)." : "Reply with just the number, e.g. *12*." };
    }
    if (attr.decimal_places === 0 && !Number.isInteger(n)) {
      return { ok: false, hint: "Jumia needs a whole number for this one, e.g. *2*." };
    }
    return { ok: true, value: String(Number(n.toFixed(3))) };
  }

  if (t.length < Math.max(1, attr.min_length ?? 1)) return { ok: false, hint: "Reply with it in a few words." };
  return { ok: true, value: t.slice(0, attr.max_length ?? 300) };
}

/** The question for one missing field, with taps for its allowed values when they fit. */
export function missingValueQuestion(
  attr: JumiaCategoryAttribute,
  who:  string,
): { body: string; options: { id: string; title: string }[] } {
  const label = attr.label || attr.name;
  const allowed = attr.allowed_values ?? [];
  const intro = `📝 *${who}*\n\nJumia needs its *${label}* before it can be listed.`;
  const skip = { id: "skip value", title: "Skip for now" };

  if (allowed.length > 0 && allowed.length <= MAX_LISTED_VALUES) {
    return {
      body:    `${intro} Pick one below.`,
      options: [...allowed.map((v, i) => ({ id: `value:${i}`, title: v })), skip],
    };
  }
  const example = allowed.length > 0
    ? ` Reply with one of Jumia's options for it, e.g. ${allowed.slice(0, 3).join(", ")}.`
    : columnFor(attr.name) === "weight_kg"
      ? " Reply with the weight in kg, e.g. *0.5*."
      : isNumeric(attr) ? " Reply with just the number." : " Reply with it.";
  return { body: `${intro}${example}`, options: [skip] };
}

/** Save a value for a field: its column when it has one (weight → weight_kg), else the category fields. */
export async function saveMissingValue(
  listingId: string,
  attr:      JumiaCategoryAttribute,
  value:     string,
  source:    "user" | "ai",
): Promise<boolean> {
  const db = createServerClient();
  const { data: row } = await db
    .from("listings")
    .select("dynamic_attributes, field_sources, field_confidence")
    .eq("id", listingId)
    .maybeSingle();
  if (!row) return false;

  const sources    = { ...((row.field_sources as Record<string, string> | null) ?? {}) };
  const confidence = { ...((row.field_confidence as Record<string, unknown> | null) ?? {}) };
  const { columnUpdate, dynUpdate } = fieldChangeToUpdate(attr.name, value);
  const key = columnUpdate ? Object.keys(columnUpdate)[0] : `dynamic_attributes.${attr.name}`;
  sources[key] = source;
  if (source === "ai") {
    confidence[key] = { confidence: 0.6, source: "inferred", reasoning: `Estimated because Jumia requires ${attr.label || attr.name} in this category.` };
  }

  const { error } = await db.from("listings").update({
    ...(columnUpdate ?? {}),
    ...(dynUpdate
      ? { dynamic_attributes: { ...((row.dynamic_attributes as Record<string, unknown> | null) ?? {}), ...dynUpdate } }
      : {}),
    field_sources:    sources,
    field_confidence: confidence,
    updated_at:       new Date().toISOString(),
  }).eq("id", listingId);
  if (error) console.warn(`[missing-value] save of ${attr.name} on ${listingId} failed: ${error.message}`);
  return !error;
}

/**
 * Fill what the photos and notes can answer before asking: one AI pass
 * over just the missing fields (a weight is estimated, the rest only when
 * the photos or notes show it). Returns the labels it filled.
 */
export async function autoFillMissingFields(
  userId:  string,
  listingId: string,
  missing: JumiaCategoryAttribute[],
): Promise<string[]> {
  if (missing.length === 0) return [];
  const db = createServerClient();
  const { data: row } = await db
    .from("listings")
    .select("images, category_code, user_prompt")
    .eq("id", listingId)
    .eq("user_id", userId)
    .maybeSingle();
  const images = ((row?.images ?? []) as string[]).filter(Boolean);
  const code = Number(row?.category_code);
  if (!row || images.length === 0 || !Number.isFinite(code) || code <= 0) return [];

  let extracted: Record<string, string> = {};
  try {
    ({ dynamic_attributes: extracted } = await extractAttributesForCategory(
      images, code, (row.user_prompt as string | null) ?? null, { only: missing.map((a) => a.name) },
    ));
  } catch (e) {
    console.warn(`[missing-value] auto-fill for ${listingId} failed: ${(e as Error).message}`);
    return [];
  }

  const filled: string[] = [];
  for (const attr of missing) {
    const raw = extracted[attr.name];
    if (raw == null) continue;
    const parsed = parseMissingValue(attr, String(raw));
    if (parsed.ok && (await saveMissingValue(listingId, attr, parsed.value, "ai"))) filled.push(attr.label || attr.name);
  }
  if (filled.length > 0) console.info(`[missing-value] listing=${listingId} filled ${filled.join(", ")} without asking`);
  return filled;
}
