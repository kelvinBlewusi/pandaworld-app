import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  aiPassA_describeProduct,
  aiPassB_rankCategory,
  extractAttributesForCategory,
} from "@/lib/actions/ai";
import {
  getListableCategories,
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
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

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
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  // Rate limit — 3 Gemini calls per analyse (~$0.02). Per-user.
  const blocked = checkRateLimit(`auto-analyze:${userId}`, RATE_LIMITS.autoAnalyze);
  if (blocked) return blocked;

  // Optional free-text hint from the seller — gets passed to Pass A as
  // "SELLER CONTEXT" so the AI honours things the images don't show
  // (e.g. "this is a pack of 6 not single unit", "the colour is teal").
  let userContext: string | null = null;
  try {
    const body = await req.json();
    if (typeof body?.userPrompt === "string" && body.userPrompt.trim()) {
      userContext = body.userPrompt.trim().slice(0, 1000); // hard cap
    }
  } catch { /* no body / non-JSON — fine */ }

  const db = createServerClient();

  // ── Load listing + verify ownership ───────────────────────────────────────
  const { data: listing } = await db
    .from("listings")
    .select("id, user_id, sku, images, title, brand, selling_price, quantity, dynamic_attributes, field_sources, field_confidence")
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
    description = await aiPassA_describeProduct(images, userContext);
    timings.describe_ms = Date.now() - t0;
  } catch (e) {
    return NextResponse.json(
      { error: `Step 1 (describe) failed: ${(e as Error).message}` },
      { status: 500 }
    );
  }

  // Build a retrieval query that includes the use case + environment from
  // Pass A. Without them the query is just "Pump Sprayer" and Fuse can
  // happily match that against "Carpet Cleaning Machine Accessories"
  // somewhere else in the tree. With "agricultural pesticide spraying farm"
  // tacked on, the environment-specific paths float to the top.
  const retrievalQuery = [
    description.title,
    ...description.keywords,
    description.intended_use_case,
    description.environment && description.environment !== "unknown"
      ? description.environment
      : null,
  ].filter(Boolean).join(" ");

  // ── 2. RETRIEVAL: fuzzy local + Jumia catalog lookup ──────────────────────
  //
  // Pool = every category Jumia marked as listable (matches what the
  // picker shows the seller). Intermediate-but-listable parents like
  // "Watches" are now candidates the AI can suggest, not just leaves.
  const tRet = Date.now();
  const listableCategories = await getListableCategories();

  if (listableCategories.length === 0) {
    return NextResponse.json(
      {
        error: "No categories synced yet. Open Settings → Integrations → Sync categories first.",
      },
      { status: 422 }
    );
  }

  const fuzzyHits = searchCategoriesByText(retrievalQuery, listableCategories, 6);

  // Best-effort Jumia catalog lookup (silently returns [] on failure)
  let jumiaHits: typeof fuzzyHits = [];
  try {
    const { accessToken } = await getValidJumiaCredentials(userId);
    jumiaHits = await searchJumiaProductsByTitle(accessToken, description.title, 3);
  } catch {
    // OK — catalog search is optional enrichment, not critical
  }

  let candidates = mergeCandidates(fuzzyHits, jumiaHits, 8);

  // Fallback: if the fuzzy + Jumia retrieval both came up empty, hand
  // the rank-pass the full listable set (capped) instead of failing the
  // analyze. Better an over-broad pool than blocking the seller. Gemini
  // can absolutely scan ~200 candidates and pick the right one — the
  // narrow retrieval is only an optimisation.
  if (candidates.length === 0) {
    console.warn(
      `[auto-analyze] No fuzzy/Jumia retrieval hits for query="${retrievalQuery.slice(0, 100)}". ` +
      `Falling back to the first ${Math.min(listableCategories.length, 200)} listable categories.`,
    );
    candidates = listableCategories.slice(0, 200).map((c) => ({
      code:               c.code,
      name:               c.name,
      path:               c.path,
      attribute_set_sid:  c.attribute_set_sid,
      retrievalScore:     0,
      source:             "fuzzy" as const,
    }));
  }

  timings.retrieval_ms = Date.now() - tRet;

  if (candidates.length === 0) {
    // Reachable only if listableCategories itself is empty — i.e. the
    // admin has never run a category sync. The seller can't fix that
    // themselves; the error directs them to the right place.
    return NextResponse.json(
      {
        error: "The Jumia category catalog hasn't been synced yet. Please contact support — an admin needs to run the catalog sync at /admin/categories.",
        description,
      },
      { status: 422 }
    );
  }

  // ── 3. Pass B: rank candidates ────────────────────────────────────────────
  const tRank = Date.now();
  let ranked: Awaited<ReturnType<typeof aiPassB_rankCategory>>;
  try {
    ranked = await aiPassB_rankCategory(
      images,
      candidates,
      userContext,
      description.intended_use_case,
      description.environment,
    );
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
    const catRow = listableCategories.find((c) => c.code === chosen.code);
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
    filled = await extractAttributesForCategory(images, chosen.code, userContext);
    timings.fill_ms = Date.now() - tFill;
  } catch (e) {
    console.warn(`[auto-analyze] attribute fill failed: ${(e as Error).message}`);
    // Don't fail the whole pipeline — category was picked, just no AI fill
  }

  // ── 6. Build merged updates and persist ──────────────────────────────────
  //
  // Strategy: fill every empty top-level field from Pass A's response.
  // NEVER overwrite seller-edited values (those with field_sources[k] ===
  // "user"). Brand has a special fallback to "Generic" since Jumia requires
  // it and an empty brand blocks Submit.
  const previousSources    = (listing.field_sources    ?? {}) as Record<string, "ai" | "user">;
  const previousConfidence = (listing.field_confidence ?? {}) as Record<string, { confidence: number; source: string; reasoning?: string }>;

  const isUserEdited = (key: string) => previousSources[key] === "user";

  // Updates payload — every visible top-level field the AI can infer
  const updates: Record<string, unknown> = {};
  const newSources:    Record<string, "ai">                                                                            = {};
  const newConfidence: Record<string, { confidence: number; source: "image" | "ocr" | "inferred" | "seller-required"; reasoning?: string }> = {};

  const setIfEmpty = (col: string, val: string | number | null, conf: { confidence: number; source: "image" | "ocr" | "inferred" | "seller-required"; reasoning?: string }) => {
    if (val == null || val === "") return;
    // Only set when DB is empty OR contains a stale AI value
    const existing = (listing as unknown as Record<string, unknown>)[col];
    const stale = !existing || (typeof existing === "string" && existing.trim() === "");
    if (!stale) return;
    if (isUserEdited(col)) return;
    updates[col] = val;
    newSources[col] = "ai";
    newConfidence[col] = conf;
  };

  // Title — only fill if too short / missing
  if (!isUserEdited("title") && (!listing.title || listing.title.length < 15)) {
    updates.title = description.title;
    newSources["title"] = "ai";
    newConfidence["title"] = { confidence: 0.9, source: "inferred" };
  }

  // Brand — Pass A's brand if confident, else "Generic" fallback so the
  // required field is never empty. Per Jumia API docs, code 1045133 for
  // Generic; resolveBrand maps the name → code at push time.
  if (!isUserEdited("brand") && !listing.brand) {
    const brandValue = description.brand && description.brand.trim() ? description.brand : "Generic";
    updates.brand = brandValue;
    newSources["brand"] = "ai";
    newConfidence["brand"] = description.brand
      ? { confidence: 0.9, source: "image",    reasoning: "Logo visible in image" }
      : { confidence: 0.5, source: "inferred", reasoning: "No brand logo detected — defaulted to Generic. Edit if you know the real brand." };
  }

  // Other top-level fields
  setIfEmpty("description",     description.description,     { confidence: 0.85, source: "inferred" });
  setIfEmpty("highlights",      description.highlights,      { confidence: 0.85, source: "inferred" });
  setIfEmpty("color",           description.color,           { confidence: 0.85, source: "image" });
  setIfEmpty("color_family",    description.color_family,    { confidence: 0.85, source: "image" });
  setIfEmpty("weight_kg",       description.weight_kg,       { confidence: 0.7,  source: "image",  reasoning: "Weight inferred from visible packaging" });
  setIfEmpty("main_material",   description.main_material,   { confidence: 0.8,  source: "inferred" });
  setIfEmpty("material_family", description.material_family, { confidence: 0.8,  source: "inferred" });

  // Merge category alternates → top-3 with confidence
  const alternatesForUI = [
    { code: chosen.code, name: chosen.name, path: chosen.path, confidence: chosen.confidence },
    ...ranked.alternates.map((a) => ({ code: a.code, name: a.name, path: a.path, confidence: a.confidence })),
  ].slice(0, 3);

  // Merge field_sources + field_confidence (keep user-edited keys intact)
  const mergedSources    = { ...previousSources, ...newSources };
  const mergedConfidence = { ...previousConfidence, ...newConfidence };
  for (const [k, v] of Object.entries(filled.field_sources ?? {})) {
    if (mergedSources[k] !== "user") mergedSources[k] = v;
  }
  for (const [k, v] of Object.entries(filled.field_confidence ?? {})) {
    if (mergedSources[k] !== "user") {
      mergedConfidence[k] = v as { confidence: number; source: "image" | "ocr" | "inferred" | "seller-required"; reasoning?: string };
    }
  }

  await db.from("listings").update({
    ...updates,
    category_code:       String(chosen.code),
    category_path:       chosen.path,
    dynamic_attributes:  filled.dynamic_attributes,
    field_sources:       mergedSources,
    field_confidence:    mergedConfidence,
    category_alternates: alternatesForUI,
    updated_at:          new Date().toISOString(),
  }).eq("id", params.id);

  // ── Persist AI-detected variations into the variants table ───────────────
  //
  // The seller's review page hydrates from this table. When Pass A spots
  // distinct variants in the images (bundle types, pack sizes, colour
  // options, etc.) the seller lands on the review page with each as its
  // own variant card — no manual typing needed.
  //
  // We replace the variants list rather than append, so re-running
  // Analyze with fresh images doesn't pile up duplicates. The seller's
  // edits between Analyze runs are not preserved by this path; that's
  // a deliberate tradeoff — Analyze is the "AI proposes, seller refines"
  // step. If the seller wants to keep their custom variants, they
  // shouldn't re-run Analyze.
  //
  // Wrapped in try/catch — if the variants insert fails, the listing
  // update above is still useful, so we surface a warning rather than
  // failing the whole pipeline.
  if (description.variations.length > 0) {
    try {
      const baseSku    = (listing.sku as string | undefined) ?? params.id.slice(0, 8).toUpperCase();
      const basePrice  = (listing.selling_price as number | undefined) ?? null;
      const baseStock  = (listing.quantity as number | undefined) ?? 1;
      const rows = description.variations.map((v) => ({
        listing_id:      params.id,
        variation:       v.label,
        seller_sku:      `${baseSku}-${v.sku_suffix}`,
        gtin:            null,
        quantity:        baseStock,
        global_price:    basePrice,
        sale_price:      null,
        sale_start_date: null,
        sale_end_date:   null,
      }));
      // Clear-then-insert. RLS still enforces ownership via the listings
      // ownership check above.
      await db.from("variants").delete().eq("listing_id", params.id);
      await db.from("variants").insert(rows);
    } catch (e) {
      console.warn(`[auto-analyze] variant persist failed: ${(e as Error).message}`);
    }
  }

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
    variations_detected:   description.variations.length,
    title:                 (updates.title as string | undefined) ?? listing.title,
    brand:                 (updates.brand as string | undefined) ?? listing.brand,
  });
}
