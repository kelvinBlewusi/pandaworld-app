/**
 * Re-run category-driven attribute filling for a listing — the core
 * orchestration behind POST /api/listings/[id]/refill-attributes,
 * extracted so a caller with no Clerk session (the WhatsApp webhook,
 * correcting a low-confidence category pick right from chat) can run the
 * exact same flow by passing userId directly instead of it being read
 * from request cookies. See lib/jumia/push-listing.ts for the identical
 * rationale on that extraction.
 *
 * Pipeline: validate the new category is listable → ensure its attribute
 * schema is cached (fetch live from Jumia if not) → in schema-only mode,
 * just reset dynamic_attributes to fit the new schema; otherwise also run
 * Gemini to fill it → merge with any user-edited values that still apply
 * → persist.
 */

import { createServerClient } from "@/lib/supabase/server";
import { extractAttributesForCategory } from "@/lib/actions/ai";
import {
  getCategoryByCode,
  getCategoryAttributes,
  fetchAttributesFromJumia,
  upsertAttributes,
} from "@/lib/jumia/categories";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import { logCategoryCorrection } from "@/lib/jumia/category-corrections";
import { withAiUsageContext } from "@/lib/ai/usage";
import { columnFor } from "@/lib/jumia/attribute-mapping";
import { allowedValueFor } from "@/lib/jumia/preflight";

/** Columns a weight or size attribute mirrors into (product_weight → weight_kg). */
const PHYSICAL_COLUMNS = new Set(["weight_kg", "size_l", "size_w", "size_h"]);

type FieldConfidence = { confidence: number; source: string; reasoning?: string };

export type RefillAttributesResult =
  | {
      ok: true;
      category: { code: number; name: string; path: string };
      attributesSchema:   number;
      aiFilled:            number;
      dynamic_attributes:  Record<string, string>;
      field_sources:       Record<string, "ai" | "user">;
      field_confidence:    Record<string, FieldConfidence>;
    }
  | { ok: false; code: "not_found" | "no_images" | "category_not_found" | "not_listable"; message: string };

export async function refillAttributesForCategory(
  userId:       string,
  listingId:    string,
  categoryCode: number,
  opts: RefillOptions = {},
): Promise<RefillAttributesResult> {
  return withAiUsageContext({ feature: "category_refill", userId, listingId }, () =>
    refillUnmetered(userId, listingId, categoryCode, opts),
  );
}

interface RefillOptions {
  categoryPath?: string | null;
  userContext?:  string | null;
  /** Skip the Gemini fill step — fields reset to empty for the new
   *  schema instead of being AI-filled. Used only where a caller
   *  deliberately wants to defer the AI call (none currently do; kept
   *  for parity with the HTTP route's ?mode=schema-only). */
  schemaOnly?: boolean;
}

async function refillUnmetered(
  userId:       string,
  listingId:    string,
  categoryCode: number,
  opts:         RefillOptions,
): Promise<RefillAttributesResult> {
  const db = createServerClient();

  const { data: listing } = await db
    .from("listings")
    .select("*")
    .eq("id", listingId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!listing) return { ok: false, code: "not_found", message: "Listing not found" };

  const images = (listing.images ?? []) as string[];
  if (images.length === 0) {
    return { ok: false, code: "no_images", message: "Listing has no images. Upload at least one before changing category." };
  }

  const cat = await getCategoryByCode(categoryCode);
  if (!cat) {
    return { ok: false, code: "category_not_found", message: `Category ${categoryCode} not found in cache. Re-sync categories from Jumia.` };
  }
  if (!cat.attribute_set_sid) {
    return { ok: false, code: "not_listable", message: `"${cat.name}" can't accept listings on Jumia (no attribute set).` };
  }

  let attrs = await getCategoryAttributes(categoryCode);
  if (attrs.length === 0 && cat.attribute_set_sid) {
    try {
      const { accessToken } = await getValidJumiaCredentials(userId);
      const fresh = await fetchAttributesFromJumia(accessToken, cat.attribute_set_sid);
      if (fresh.length > 0) {
        await upsertAttributes(categoryCode, fresh);
        attrs = fresh;
      }
    } catch (e) {
      console.warn(`[refill-attributes] couldn't fetch fresh schema: ${(e as Error).message}`);
    }
  }

  const validKeys = new Set(attrs.map((a) => a.name));
  const previousDyn        = (listing.dynamic_attributes ?? {}) as Record<string, string>;
  const previousSources    = (listing.field_sources ?? {}) as Record<string, "ai" | "user">;
  const previousConfidence = (listing.field_confidence ?? {}) as Record<string, FieldConfidence>;

  const carriedSources: Record<string, "ai" | "user"> = { ...previousSources };
  const carriedConfidence: Record<string, FieldConfidence> = { ...previousConfidence };
  for (const k of Object.keys(carriedSources)) {
    if (k.startsWith("dynamic_attributes.") && !validKeys.has(k.slice("dynamic_attributes.".length))) delete carriedSources[k];
  }
  for (const k of Object.keys(carriedConfidence)) {
    if (k.startsWith("dynamic_attributes.") && !validKeys.has(k.slice("dynamic_attributes.".length))) delete carriedConfidence[k];
  }
  // A category switch here is always a seller choosing it (the editor's
  // category picker, WhatsApp's category buttons and category question),
  // so record it as theirs: a later redraft keeps it rather than
  // re-picking — see sellerChosenCategoryCode in lib/actions/auto-analyze.ts.
  // Not on a same-category refill ("Fill empty fields with AI"), which
  // says nothing about who chose the category.
  const previousCategoryCode = listing.category_code ? Number(listing.category_code) : null;
  if (previousCategoryCode !== categoryCode) carriedSources.category_code = "user";

  const category = { code: cat.code, name: cat.name, path: cat.path };
  const categoryPath = opts.categoryPath ?? cat.path;

  // Log an actual override (previous category existed and differs from the
  // new pick) — not the listing's first-ever category assignment, which
  // isn't a "correction" of anything. See lib/jumia/category-corrections.ts.
  if (previousCategoryCode !== null && previousCategoryCode !== categoryCode) {
    const alternates = (listing.category_alternates ?? []) as Array<{ code: number; confidence: number }>;
    const previousAlternate = alternates.find((a) => a.code === previousCategoryCode);
    await logCategoryCorrection({
      listingId,
      previousCategoryCode,
      previousCategoryPath: listing.category_path,
      previousConfidence: previousAlternate?.confidence ?? null,
      newCategoryCode: categoryCode,
      newCategoryPath: categoryPath,
    });
  }

  if (opts.schemaOnly) {
    const carriedDyn: Record<string, string> = {};
    for (const [k, v] of Object.entries(previousDyn)) {
      if (validKeys.has(k) && previousSources[`dynamic_attributes.${k}`] === "user") carriedDyn[k] = v;
    }
    await db.from("listings").update({
      category_code:      String(categoryCode),
      category_path:      categoryPath,
      dynamic_attributes: carriedDyn,
      field_sources:      carriedSources,
      field_confidence:   carriedConfidence,
      updated_at:         new Date().toISOString(),
    }).eq("id", listingId);

    return {
      ok: true,
      category,
      attributesSchema:   attrs.length,
      aiFilled:           0,
      dynamic_attributes: carriedDyn,
      field_sources:      carriedSources,
      field_confidence:   carriedConfidence,
    };
  }

  const extracted = await extractAttributesForCategory(images, categoryCode, opts.userContext);

  const mergedDyn: Record<string, string> = {};
  for (const [k, v] of Object.entries(previousDyn)) {
    if (validKeys.has(k) && previousSources[`dynamic_attributes.${k}`] === "user") mergedDyn[k] = v;
  }
  for (const [k, v] of Object.entries(extracted.dynamic_attributes)) {
    if (!validKeys.has(k) || mergedDyn[k]) continue;
    mergedDyn[k] = v;
    carriedSources[`dynamic_attributes.${k}`] = "ai";
    if (extracted.field_confidence?.[`dynamic_attributes.${k}`]) {
      carriedConfidence[`dynamic_attributes.${k}`] = extracted.field_confidence[`dynamic_attributes.${k}`];
    }
  }

  // What the earlier draft had for a field the new category also has, when
  // this fill left it out. Live, 2026-10-01: a shower cream switched from
  // Body Sunscreens to Body Washes lost every AI value with the old
  // category, the new fill skipped the weight, and the product was held
  // for "Weight (kg)". The values describe the product, not the category,
  // so they still hold (the check below drops any the category refuses).
  for (const [k, v] of Object.entries(previousDyn)) {
    const value = String(v ?? "").trim();
    if (!validKeys.has(k) || mergedDyn[k] || !value) continue;
    mergedDyn[k] = value;
    carriedSources[`dynamic_attributes.${k}`] = previousSources[`dynamic_attributes.${k}`] ?? "ai";
  }

  // Only values the new category accepts, the check a first draft already
  // runs (lib/actions/auto-analyze.ts): close spellings snapped, anything
  // else cleared, since a wrong value looks done until Jumia drops it.
  // Live, 2026-10-02: a switch to Drop & Dangle earrings filled Age Group
  // with "Female" and the product was held over it. The seller's own
  // values are left as they wrote them.
  const fieldByName = new Map(attrs.map((a) => [a.name.toLowerCase(), a]));
  for (const [k, v] of Object.entries(mergedDyn)) {
    const field = fieldByName.get(k.toLowerCase());
    if (!field?.allowed_values?.length || carriedSources[`dynamic_attributes.${k}`] === "user") continue;
    const allowed = allowedValueFor(String(v ?? ""), field);
    if (allowed === null) {
      delete mergedDyn[k];
      delete carriedSources[`dynamic_attributes.${k}`];
      delete carriedConfidence[`dynamic_attributes.${k}`];
      console.info(`[refill-attributes] listing=${listingId} dropped ${k}="${v}": not a value category ${categoryCode} accepts`);
    } else if (allowed !== v) {
      mergedDyn[k] = allowed;
    }
  }
  const columnUpdates: Record<string, unknown> = {};
  for (const field of attrs) {
    const col = columnFor(field.name);
    if (!col || !field.allowed_values?.length || col in columnUpdates || carriedSources[col] === "user") continue;
    const current = (listing as Record<string, unknown>)[col];
    if (current == null || String(current).trim() === "" || Array.isArray(current)) continue;
    const allowed = allowedValueFor(String(current), field);
    if (allowed !== String(current)) columnUpdates[col] = allowed;
  }

  // A weight or size the fill gave, copied into its empty column, which is
  // what the editor shows and the push sends: the same mirror a first draft
  // does (lib/actions/auto-analyze.ts), which a category switch skipped.
  for (const [k, v] of Object.entries(mergedDyn)) {
    const col = columnFor(k);
    if (!col || !PHYSICAL_COLUMNS.has(col) || col in columnUpdates) continue;
    const current = (listing as Record<string, unknown>)[col];
    if (current != null && String(current).trim() !== "") continue;
    const n = parseFloat(String(v).replace(/[^\d.]/g, ""));
    if (!Number.isFinite(n) || n <= 0) continue;
    columnUpdates[col] = n;
    carriedSources[col] = "ai";
  }

  await db.from("listings").update({
    ...columnUpdates,
    category_code:      String(categoryCode),
    category_path:      categoryPath,
    dynamic_attributes: mergedDyn,
    field_sources:      carriedSources,
    field_confidence:   carriedConfidence,
    updated_at:         new Date().toISOString(),
  }).eq("id", listingId);

  return {
    ok: true,
    category,
    attributesSchema:   attrs.length,
    aiFilled:            Object.keys(extracted.dynamic_attributes).length,
    dynamic_attributes:  mergedDyn,
    field_sources:       carriedSources,
    field_confidence:    carriedConfidence,
  };
}
