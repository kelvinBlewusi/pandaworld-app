import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  aiPassA_describeProduct,
  aiPassB_rankCategory,
  extractAttributesForCategory,
} from "@/lib/actions/ai";
import {
  getLeafCategories,
  getCategoryAttributes,
  fetchAttributesFromJumia,
  upsertAttributes,
} from "@/lib/jumia/categories";
import {
  searchCategoriesByText,
  mergeCandidates,
} from "@/lib/jumia/category-search";
import { searchJumiaProductsByTitle } from "@/lib/jumia/catalog-search";
import { getValidJumiaCredentials } from "@/lib/jumia/api";

// ─── POST /api/listings/[id]/auto-analyze ────────────────────────────────────
//
// One-button category detection + attribute fill.
//
// Pipeline (matches the strategy in the architecture spec):
//
//   1. AI Pass A — DESCRIBE
//      images → { title, brand, keywords, summary }
//
//   2. RETRIEVAL — fuzzy local search + Jumia catalog lookup
//      (deterministic, free, no AI tokens)
//      → 6-8 candidate leaf categories
//
//   3. AI Pass B — RANK
//      images + 8 candidates → { primary, alternates, confidence }
//
//   4. AI Pass C — FILL ATTRIBUTES
//      images + chosen leaf's schema → dynamic_attributes
//
// Total: 3 AI calls, ~10 seconds, ~$0.002 per listing. Persists everything
// to the listing row so the review form re-renders with all fields filled.

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const db = createServerClient();

  // ── Load listing + verify ownership ───────────────────────────────────────
  const { data: listing } = await db
    .from("listings")
    .select("id, user_id, images, title, brand, dynamic_attributes, field_sources, field_confidence")
    .eq("id", params.id)
    .eq("user_id", userId)
    .maybeSingle();

  if (!listing) return NextResponse.json({ error: "Listing not found" }, { status: 404 });

  const images = (listing.images ?? []) as string[];
  if (images.length === 0) {
    return NextResponse.json(
      { error: "Upload at least one image before running Analyze with AI." },
      { status: 422 }
    );
  }

  // Capture wall-clock so we can return per-step timing for the UI
  const t0 = Date.now();
  const timings: Record<string, number> = {};

  // ── 1. Pass A: describe the product ───────────────────────────────────────
  let description: Awaited<ReturnType<typeof aiPassA_describeProduct>>;
  try {
    description = await aiPassA_describeProduct(images);
    timings.describe_ms = Date.now() - t0;
  } catch (e) {
    return NextResponse.json(
      { error: `Step 1 (describe) failed: ${(e as Error).message}` },
      { status: 500 }
    );
  }

  // Build a richer query string for retrieval — title plus keywords
  const retrievalQuery = [description.title, ...description.keywords].join(" ");

  // ── 2. RETRIEVAL: fuzzy local + Jumia catalog lookup ──────────────────────
  const tRet = Date.now();
  const leafCategories = await getLeafCategories();

  if (leafCategories.length === 0) {
    return NextResponse.json(
      {
        error: "No categories synced yet. Open Settings → Integrations → Sync categories first.",
      },
      { status: 422 }
    );
  }

  const fuzzyHits = searchCategoriesByText(retrievalQuery, leafCategories, 6);

  // Best-effort Jumia catalog lookup (silently returns [] on failure)
  let jumiaHits: typeof fuzzyHits = [];
  try {
    const { accessToken } = await getValidJumiaCredentials(userId);
    jumiaHits = await searchJumiaProductsByTitle(accessToken, description.title, 3);
  } catch {
    // OK — catalog search is optional enrichment, not critical
  }

  const candidates = mergeCandidates(fuzzyHits, jumiaHits, 8);
  timings.retrieval_ms = Date.now() - tRet;

  if (candidates.length === 0) {
    return NextResponse.json(
      {
        error: "No candidate categories found. Try refreshing categories from Jumia (use the 🔄 icon in the category drawer).",
        description,
      },
      { status: 422 }
    );
  }

  // ── 3. Pass B: rank candidates ────────────────────────────────────────────
  const tRank = Date.now();
  let ranked: Awaited<ReturnType<typeof aiPassB_rankCategory>>;
  try {
    ranked = await aiPassB_rankCategory(images, candidates);
    timings.rank_ms = Date.now() - tRank;
  } catch (e) {
    return NextResponse.json(
      { error: `Step 3 (rank) failed: ${(e as Error).message}`, description, candidates },
      { status: 500 }
    );
  }

  if (!ranked.primary) {
    return NextResponse.json(
      {
        error: "The AI couldn't pick a category from the candidates. Pick manually.",
        description,
        candidates,
      },
      { status: 422 }
    );
  }

  const chosen = ranked.primary;

  // ── 4. Make sure attribute schema is cached for chosen leaf ──────────────
  let attrs = await getCategoryAttributes(chosen.code);
  if (attrs.length === 0) {
    // Need to find the category row to get attribute_set_sid
    const catRow = leafCategories.find((c) => c.code === chosen.code);
    if (catRow?.attribute_set_sid) {
      try {
        const { accessToken } = await getValidJumiaCredentials(userId);
        const fresh = await fetchAttributesFromJumia(accessToken, catRow.attribute_set_sid);
        if (fresh.length > 0) {
          await upsertAttributes(chosen.code, fresh);
          attrs = fresh;
        }
      } catch (e) {
        console.warn(`[auto-analyze] schema fetch failed: ${(e as Error).message}`);
      }
    }
  }

  // ── 5. Pass C: fill attributes ────────────────────────────────────────────
  const tFill = Date.now();
  let filled: Awaited<ReturnType<typeof extractAttributesForCategory>> = {
    dynamic_attributes: {},
    field_sources:      {},
    field_confidence:   {},
  };
  try {
    filled = await extractAttributesForCategory(images, chosen.code);
    timings.fill_ms = Date.now() - tFill;
  } catch (e) {
    console.warn(`[auto-analyze] attribute fill failed: ${(e as Error).message}`);
    // Don't fail the whole pipeline — category was picked, just no AI fill
  }

  // ── 6. Build merged updates and persist ──────────────────────────────────
  const previousSources    = (listing.field_sources    ?? {}) as Record<string, "ai" | "user">;
  const previousConfidence = (listing.field_confidence ?? {}) as Record<string, { confidence: number; source: string; reasoning?: string }>;

  // Apply title + brand-hint to the listing if it's still empty (don't
  // overwrite seller-edited values).
  const titleUpdate: { title?: string; brand?: string | null } = {};
  if (!listing.title || listing.title.length < 15) {
    titleUpdate.title = description.title;
  }
  // Brand: only when truly empty AND Pass A returned a value (only happens
  // when logo is clearly visible per the prompt rules).
  if (!listing.brand && description.brand) {
    titleUpdate.brand = description.brand;
  }

  // Merge category alternates → top-3 with confidence
  const alternatesForUI = [
    { code: chosen.code, name: chosen.name, path: chosen.path, confidence: chosen.confidence },
    ...ranked.alternates.map((a) => ({ code: a.code, name: a.name, path: a.path, confidence: a.confidence })),
  ].slice(0, 3);

  // Merge field_sources + field_confidence (keep user-edited keys intact)
  const mergedSources    = { ...previousSources };
  const mergedConfidence = { ...previousConfidence };
  for (const [k, v] of Object.entries(filled.field_sources ?? {})) {
    if (mergedSources[k] !== "user") mergedSources[k] = v;
  }
  for (const [k, v] of Object.entries(filled.field_confidence ?? {})) {
    if (mergedSources[k] !== "user") {
      mergedConfidence[k] = v as { confidence: number; source: "image" | "ocr" | "inferred" | "seller-required"; reasoning?: string };
    }
  }
  if (titleUpdate.title)         mergedSources["title"] = "ai";
  if (titleUpdate.brand)         mergedSources["brand"] = "ai";

  await db.from("listings").update({
    ...titleUpdate,
    category_code:       String(chosen.code),
    category_path:       chosen.path,
    dynamic_attributes:  filled.dynamic_attributes,
    field_sources:       mergedSources,
    field_confidence:    mergedConfidence,
    category_alternates: alternatesForUI,
    updated_at:          new Date().toISOString(),
  }).eq("id", params.id);

  // ── 7. Return everything the UI needs to refresh in place ───────────────
  return NextResponse.json({
    success: true,
    timings: {
      ...timings,
      total_ms: Date.now() - t0,
    },
    description,
    category: {
      code:       chosen.code,
      name:       chosen.name,
      path:       chosen.path,
      confidence: chosen.confidence,
    },
    alternates:           ranked.alternates,
    needsUserConfirmation: ranked.needsUserConfirmation,
    candidates_considered: candidates.length,
    attributes_in_schema:  attrs.length,
    attributes_filled:     Object.keys(filled.dynamic_attributes).length,
    title:                 titleUpdate.title ?? listing.title,
    brand:                 titleUpdate.brand ?? listing.brand,
  });
}
