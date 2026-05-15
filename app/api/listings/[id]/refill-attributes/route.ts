import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { extractAttributesForCategory } from "@/lib/actions/ai";
import {
  getCategoryByCode,
  getCategoryAttributes,
  fetchAttributesFromJumia,
  upsertAttributes,
} from "@/lib/jumia/categories";
import { getValidJumiaCredentials } from "@/lib/jumia/api";

// ─── POST /api/listings/[id]/refill-attributes ────────────────────────────────
//
// Triggered when the seller picks (or switches) a category in the review form.
//
// Pipeline:
//   1. Validate the new category exists and is a leaf
//   2. Ensure attribute schema is cached — fetch live from Jumia if not
//   3. Pass listing images + filtered schema to Gemini
//   4. Persist dynamic_attributes + field_sources + field_confidence
//   5. Return the freshly-filled attributes so the UI can refresh
//
// This is the "category-driven dynamic spec" loop the PDF spec calls for:
// picking the leaf triggers the AI to fill its fields.

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  let body: { categoryCode?: number; categoryPath?: string; userPrompt?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const categoryCode = Number(body.categoryCode);
  if (!categoryCode || isNaN(categoryCode)) {
    return NextResponse.json({ error: "categoryCode is required" }, { status: 400 });
  }

  // Optional free-text seller hint — flows to Pass C so the AI honours
  // things the images don't show (pack size, exact variant, etc.).
  const userContext: string | null =
    typeof body.userPrompt === "string" && body.userPrompt.trim()
      ? body.userPrompt.trim().slice(0, 1000)
      : null;

  const db = createServerClient();

  // ── 1. Load the listing ──────────────────────────────────────────────────
  const { data: listing } = await db
    .from("listings")
    .select("id, user_id, images, dynamic_attributes, field_sources, field_confidence, category_code, category_path")
    .eq("id", params.id)
    .eq("user_id", userId)
    .maybeSingle();

  if (!listing) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }

  const images = (listing.images ?? []) as string[];
  if (images.length === 0) {
    return NextResponse.json(
      { error: "Listing has no images. Upload at least one before changing category." },
      { status: 422 }
    );
  }

  // ── 2. Validate the new category + ensure schema is cached ───────────────
  const cat = await getCategoryByCode(categoryCode);
  if (!cat) {
    return NextResponse.json(
      { error: `Category ${categoryCode} not found in cache. Re-sync categories from Jumia.` },
      { status: 404 }
    );
  }
  if (!cat.is_leaf) {
    return NextResponse.json(
      { error: `"${cat.name}" is a parent category. Jumia only allows listings on leaves.` },
      { status: 422 }
    );
  }

  // ── 3. Make sure we have attribute schema for this category ──────────────
  // If our cache is empty for this category, fetch live from Jumia.
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
      console.warn(`[refill-attributes] couldn't fetch fresh schema:`, (e as Error).message);
    }
  }

  // ── 4. Ask Gemini to fill the attributes for this category ───────────────
  const extracted = await extractAttributesForCategory(images, categoryCode, userContext);

  // ── 5. Merge with existing values: AI fills empty slots, user-edited
  //      values are preserved. The replaced-category-attrs scenario: when
  //      switching categories, old category-specific keys may no longer exist
  //      in the new schema and get dropped (intentionally).
  const validKeys = new Set(attrs.map((a) => a.name));
  const previousDyn = (listing.dynamic_attributes ?? {}) as Record<string, string>;
  const previousSources = (listing.field_sources ?? {}) as Record<string, "ai" | "user">;
  const previousConfidence = (listing.field_confidence ?? {}) as Record<string, { confidence: number; source: string; reasoning?: string }>;

  const mergedDyn: Record<string, string> = {};
  const mergedSources: Record<string, "ai" | "user"> = { ...previousSources };
  const mergedConfidence: Record<string, { confidence: number; source: string; reasoning?: string }> = { ...previousConfidence };

  // Keep core (non-attribute) field_sources / field_confidence entries
  // intact. Strip dynamic_attributes.* keys that no longer apply.
  for (const k of Object.keys(mergedSources)) {
    if (k.startsWith("dynamic_attributes.")) {
      const attrName = k.slice("dynamic_attributes.".length);
      if (!validKeys.has(attrName)) delete mergedSources[k];
    }
  }
  for (const k of Object.keys(mergedConfidence)) {
    if (k.startsWith("dynamic_attributes.")) {
      const attrName = k.slice("dynamic_attributes.".length);
      if (!validKeys.has(attrName)) delete mergedConfidence[k];
    }
  }

  // Preserve user-edited values that ALSO exist in the new schema
  for (const [k, v] of Object.entries(previousDyn)) {
    if (!validKeys.has(k)) continue;
    const sourceKey = `dynamic_attributes.${k}`;
    if (previousSources[sourceKey] === "user") {
      mergedDyn[k] = v;        // user explicitly set — keep their value
    }
  }

  // Layer AI extractions on top (only fills empty slots)
  for (const [k, v] of Object.entries(extracted.dynamic_attributes)) {
    if (!validKeys.has(k)) continue;
    if (!mergedDyn[k]) {
      mergedDyn[k] = v;
      mergedSources[`dynamic_attributes.${k}`] = "ai";
      if (extracted.field_confidence?.[`dynamic_attributes.${k}`]) {
        mergedConfidence[`dynamic_attributes.${k}`] = extracted.field_confidence[`dynamic_attributes.${k}`];
      }
    }
  }

  // ── 6. Persist ───────────────────────────────────────────────────────────
  await db.from("listings").update({
    category_code:      String(categoryCode),
    category_path:      body.categoryPath ?? cat.path,
    dynamic_attributes: mergedDyn,
    field_sources:      mergedSources,
    field_confidence:   mergedConfidence,
    updated_at:         new Date().toISOString(),
  }).eq("id", params.id);

  return NextResponse.json({
    success:           true,
    category: {
      code: cat.code,
      name: cat.name,
      path: cat.path,
    },
    attributesSchema:  attrs.length,
    aiFilled:          Object.keys(extracted.dynamic_attributes).length,
    dynamic_attributes: mergedDyn,
    field_sources:     mergedSources,
    field_confidence:  mergedConfidence,
  });
}
