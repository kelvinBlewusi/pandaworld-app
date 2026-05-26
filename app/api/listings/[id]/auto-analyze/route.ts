import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  aiPassA_describeProduct,
  aiPassB_rankCategory,
  extractAttributesForCategory,
  aiPassBC_pickAndFill,
  type CandidateWithSchema,
} from "@/lib/actions/ai";
import {
  getListableCategories,
  getCategoryAttributes,
  fetchAttributesFromJumia,
  upsertAttributes,
} from "@/lib/jumia/categories";
import {
  searchCategoriesByText,
  searchCategoriesByEmbedding,
  mergeCandidates,
  type CategoryCandidate,
} from "@/lib/jumia/category-search";
import { searchJumiaProductsByTitle } from "@/lib/jumia/catalog-search";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { AI_DYNAMIC_ATTR_DEFAULTS } from "@/lib/ai/policy";

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
// Total: 3 AI calls, ~10-15 seconds, ~$0.003 per listing. Persists
// everything to the listing row so the review form re-renders with all
// fields filled.

// Vercel serverless function timeout. Each analyze runs 3 sequential
// Gemini calls; with the resized Supabase Storage images and the
// in-module image cache we typically finish well inside 30s, but the
// occasional Gemini cold-start can push past the 10s Hobby default.
// Explicit 60s here covers worst-case + leaves headroom for the
// concurrent-batch case (3 in-flight analyzes per Vercel function).
export const maxDuration = 60;

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
  //
  // Resolution order:
  //   1. userPrompt from THIS request body (re-run with a different prompt)
  //   2. listing.user_prompt persisted from the initial analyze
  //   3. null (no hint)
  //
  // The first non-empty source wins. We then PERSIST whatever was used
  // back to listing.user_prompt so the next re-run pre-fills correctly.
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
    .select("id, user_id, sku, images, title, brand, selling_price, quantity, dynamic_attributes, field_sources, field_confidence, user_prompt")
    .eq("id", params.id)
    .eq("user_id", userId)
    .maybeSingle();

  if (!listing) return NextResponse.json({ error: "Listing not found" }, { status: 404 });

  // If no prompt came in this request, fall back to the one we persisted
  // from a previous analyze. Means the seller can re-run without
  // re-typing — their original "this is a pack of 6" still applies.
  if (!userContext && listing.user_prompt) {
    userContext = listing.user_prompt as string;
  }

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
  //
  // forceBestModel: true forces Gemini 2.5 Pro for every seller — Free
  // included — because the "own images" flow is the only active path
  // (rebuild + text-to-image are on maintenance). Quality > cost while
  // we channel everyone through one flow.
  let description: Awaited<ReturnType<typeof aiPassA_describeProduct>>;
  try {
    description = await aiPassA_describeProduct(images, userContext, { forceBestModel: true });
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

  // Three-source retrieval (May 2026 + embeddings):
  //   1. Fuzzy lexical search (Fuse.js, local, free)
  //   2. Semantic embedding search (pgvector, ~$0.0001 per call)
  //   3. Jumia catalog lookup (their search API)
  //
  // Embedding search is the new addition — it catches non-English
  // product names (e.g. "Kente cloth"), brand-specific terms
  // ("AirPods Pro"), and vague descriptions where lexical overlap
  // with the category tree is poor. Failure-tolerant: if the
  // embedding RPC isn't set up, this returns [] and the pipeline
  // still works on lexical + Jumia signals.
  //
  // Run all three in parallel — independent network calls.
  const fuzzyPromise: Promise<CategoryCandidate[]> = Promise.resolve(
    searchCategoriesByText(retrievalQuery, listableCategories, 6),
  );
  const embeddingPromise: Promise<CategoryCandidate[]> =
    searchCategoriesByEmbedding(retrievalQuery, 6);
  const jumiaPromise: Promise<CategoryCandidate[]> = (async () => {
    try {
      const { accessToken } = await getValidJumiaCredentials(userId);
      return await searchJumiaProductsByTitle(accessToken, description.title, 3);
    } catch {
      return [];
    }
  })();

  const [fuzzyHits, embeddingHits, jumiaHits] = await Promise.all([
    fuzzyPromise,
    embeddingPromise,
    jumiaPromise,
  ]);

  // Merge all three — categories that appear in multiple sources
  // float to the top (mergeCandidates handles the score boost).
  let candidates = mergeCandidates(mergeCandidates(fuzzyHits, embeddingHits, 8), jumiaHits, 8);

  console.info(
    `[auto-analyze] retrieval: fuzzy=${fuzzyHits.length} embedding=${embeddingHits.length} jumia=${jumiaHits.length} → merged=${candidates.length}`,
  );

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

  // ── 3 + 4 + 5 combined: pick category AND fill its attributes in ONE call.
  //
  // This collapses what used to be three serial steps (Pass B rank → schema
  // fetch → Pass C fill) into one Gemini call + parallel schema prefetch.
  // Saves ~1 round-trip (~5-8s typical, more on Pro). The old separate
  // Pass B + Pass C still exist below as a safety fallback if the combined
  // call returns an invalid result (model picked a code not in candidates,
  // or threw entirely).
  //
  // Step a: take the top 3 candidates and prefetch their attribute schemas
  //         in parallel (cached for repeat categories — fast for the
  //         common case where the seller's catalogue is already cached).
  // Step b: single Gemini call that does both pick + fill, with
  //         server-side validation that the chosen code is in the set.
  // Step c: on combined-call failure (ok=false), fall back to the old
  //         flow: aiPassB_rankCategory → schema fetch → extractAttrs.
  const tCombined        = Date.now();
  const TOP_N_FOR_COMBINED = 3;
  const topNCandidates   = candidates.slice(0, TOP_N_FOR_COMBINED);

  // Parallel schema fetch for top-N candidates. We need them all in hand
  // before the combined Gemini call so the model can pick + fill from
  // any of them. Fetch-from-Jumia fallback for uncached categories.
  const accessTokenForBatch = await getValidJumiaCredentials(userId)
    .then((c) => c.accessToken)
    .catch(() => null);

  const candidatesWithSchemas: CandidateWithSchema[] = await Promise.all(
    topNCandidates.map(async (c) => {
      let attrs = await getCategoryAttributes(c.code);
      if (attrs.length === 0) {
        const catRow = listableCategories.find((lc) => lc.code === c.code);
        if (catRow?.attribute_set_sid && accessTokenForBatch) {
          try {
            const fresh = await fetchAttributesFromJumia(accessTokenForBatch, catRow.attribute_set_sid);
            if (fresh.length > 0) {
              await upsertAttributes(c.code, fresh);
              attrs = fresh;
            }
          } catch (e) {
            console.warn(`[auto-analyze] schema fetch failed for code=${c.code}: ${(e as Error).message}`);
          }
        }
      }
      return {
        code:  c.code,
        name:  c.name,
        path:  c.path,
        attrs,
      };
    }),
  );

  // The combined call — single Gemini round-trip for category + attrs.
  const combined = await aiPassBC_pickAndFill(
    images,
    candidatesWithSchemas,
    userContext,
    description.intended_use_case,
    description.environment,
    { forceBestModel: true },
  );

  let ranked: Awaited<ReturnType<typeof aiPassB_rankCategory>>;
  let filled: Awaited<ReturnType<typeof extractAttributesForCategory>>;

  if (combined.ok && combined.primary) {
    timings.combined_bc_ms = Date.now() - tCombined;
    ranked = {
      primary:               combined.primary,
      alternates:            combined.alternates,
      needsUserConfirmation: combined.needsUserConfirmation,
    };
    filled = {
      dynamic_attributes: combined.dynamic_attributes,
      field_sources:      combined.field_sources,
      field_confidence:   combined.field_confidence,
    };
  } else {
    // ── Fallback path: the combined call failed (model returned an
    // invalid code, threw, or didn't pick anything). Fall back to the
    // proven separate Pass B → schema fetch → Pass C flow so the
    // listing still gets analysed properly.
    console.warn(
      "[auto-analyze] combined Pass B+C did not produce a usable result; falling back to separate passes.",
    );

    const tRank = Date.now();
    try {
      ranked = await aiPassB_rankCategory(
        images,
        candidates,
        userContext,
        description.intended_use_case,
        description.environment,
        { forceBestModel: true },
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

    // Schema-fetch for the chosen category (might not be in our top-N
    // if Pass B picked something different from the combined attempt).
    const chosenSchema = candidatesWithSchemas.find((c) => c.code === ranked.primary!.code);
    if (chosenSchema && chosenSchema.attrs.length > 0) {
      // Already prefetched — reuse.
    } else {
      const catRow = listableCategories.find((c) => c.code === ranked.primary!.code);
      if (catRow?.attribute_set_sid && accessTokenForBatch) {
        try {
          const fresh = await fetchAttributesFromJumia(accessTokenForBatch, catRow.attribute_set_sid);
          if (fresh.length > 0) await upsertAttributes(ranked.primary.code, fresh);
        } catch (e) {
          console.warn(`[auto-analyze] fallback schema fetch failed: ${(e as Error).message}`);
        }
      }
    }

    const tFill = Date.now();
    filled = { dynamic_attributes: {}, field_sources: {}, field_confidence: {} };
    try {
      filled = await extractAttributesForCategory(images, ranked.primary.code, userContext, { forceBestModel: true });
      timings.fill_ms = Date.now() - tFill;
    } catch (e) {
      console.warn(`[auto-analyze] fallback attribute fill failed: ${(e as Error).message}`);
    }
  }

  // Pull `chosen` + `attrs` into the local namespace expected by the
  // downstream merge logic. `attrs` is the chosen category's schema
  // (used only to populate the response's attributes_in_schema diagnostic).
  const chosen = ranked.primary!;
  const chosenWithSchema = candidatesWithSchemas.find((c) => c.code === chosen.code);
  const attrs = chosenWithSchema?.attrs ?? await getCategoryAttributes(chosen.code);

  // ── 6. Build merged updates and persist ──────────────────────────────────
  //
  // Strategy:
  //   - NEVER overwrite seller-edited values (field_sources[k] === "user").
  //     These are the human's authoritative inputs.
  //   - DO overwrite previously-AI-set values OR empty values. Re-runs
  //     are the seller's way of saying "try again, the last attempt
  //     wasn't right" — refusing to refresh AI fields would mean the
  //     second run looks identical to the first.
  //
  // Brand has a special fallback to "Generic" since Jumia requires it
  // and an empty brand blocks Submit.
  const previousSources    = (listing.field_sources    ?? {}) as Record<string, "ai" | "user">;
  const previousConfidence = (listing.field_confidence ?? {}) as Record<string, { confidence: number; source: string; reasoning?: string }>;

  const isUserEdited = (key: string) => previousSources[key] === "user";

  // Updates payload — every visible top-level field the AI can infer
  const updates: Record<string, unknown> = {};
  const newSources:    Record<string, "ai">                                                                            = {};
  const newConfidence: Record<string, { confidence: number; source: "image" | "ocr" | "inferred" | "seller-required"; reasoning?: string }> = {};

  // canFill: true when the field is either empty OR previously-AI-set.
  // The only reason to skip is a user edit (which we must preserve).
  // Previously: only filled when EMPTY — meant re-runs after a partial
  // success silently dropped Pass A's improvements on the floor.
  const canFill = (col: string): boolean => {
    if (isUserEdited(col)) return false;
    // Empty? Always fillable.
    const existing = (listing as unknown as Record<string, unknown>)[col];
    if (existing == null || (typeof existing === "string" && existing.trim() === "")) return true;
    // Non-empty but AI-set? Refresh on re-run.
    if (previousSources[col] === "ai") return true;
    // Non-empty + unknown source = legacy data, treat as user-set.
    return false;
  };

  const setField = (col: string, val: string | number | null, conf: { confidence: number; source: "image" | "ocr" | "inferred" | "seller-required"; reasoning?: string }) => {
    if (val == null || val === "") return;
    if (!canFill(col)) return;
    updates[col] = val;
    newSources[col] = "ai";
    newConfidence[col] = conf;
  };

  // Title — fill if too short / missing OR previously AI-set (so re-runs
  // refresh it). Honour user edits.
  if (canFill("title") || (!listing.title || (listing.title as string).length < 15)) {
    if (!isUserEdited("title")) {
      updates.title = description.title;
      newSources["title"] = "ai";
      newConfidence["title"] = { confidence: 0.9, source: "inferred" };
    }
  }

  // Brand — Pass A's brand if confident, else "Generic" fallback so the
  // required field is never empty. Per Jumia API docs, code 1045133 for
  // Generic; resolveBrand maps the name → code at push time.
  if (canFill("brand") || !listing.brand) {
    if (!isUserEdited("brand")) {
      const brandValue = description.brand && description.brand.trim() ? description.brand : "Generic";
      updates.brand = brandValue;
      newSources["brand"] = "ai";
      newConfidence["brand"] = description.brand
        ? { confidence: 0.9, source: "image",    reasoning: "Logo visible in image" }
        : { confidence: 0.5, source: "inferred", reasoning: "No brand logo detected — defaulted to Generic. Edit if you know the real brand." };
    }
  }

  // Other top-level fields
  setField("description",     description.description,     { confidence: 0.85, source: "inferred" });
  setField("highlights",      description.highlights,      { confidence: 0.85, source: "inferred" });
  setField("color",           description.color,           { confidence: 0.85, source: "image" });
  setField("color_family",    description.color_family,    { confidence: 0.85, source: "image" });

  // Server-side scrub for weight_kg. The Pass A prompt instructs the
  // model to return a pure number or null, but the AI occasionally
  // smuggles text in ("0.5 (estimated)", "0.5 kg", "around 1.2"). Strip
  // anything that's not part of a floating-point number, parse, and
  // only set the field if the result is a finite positive number.
  // Anything else collapses to null so the seller can fill it.
  let scrubbedWeight: number | null = null;
  if (description.weight_kg != null) {
    const raw = String(description.weight_kg);
    // Match the first floating-point number in the string (handles "0.5",
    // "0.5 (estimated)", "0.5 kg", "approx 1.2"). Reject negatives.
    const match = raw.match(/(\d+(?:\.\d+)?)/);
    if (match) {
      const n = parseFloat(match[1]);
      if (Number.isFinite(n) && n > 0 && n < 1000) {
        scrubbedWeight = n;
      }
    }
  }
  setField("weight_kg", scrubbedWeight, { confidence: 0.7, source: "image", reasoning: "Weight inferred from visible packaging" });
  setField("main_material",   description.main_material,   { confidence: 0.8,  source: "inferred" });
  setField("material_family", description.material_family, { confidence: 0.8,  source: "inferred" });

  // ── AI-defaulted fields (May 2026) — were seller-required before, now
  // AI fills with stable defaults. The seller's "What do you want in
  // the listing" text overrides these via userContext on the prompt.
  setField("model",              description.model,              { confidence: 0.8,  source: "image",    reasoning: "Model number/name visible on product or packaging." });
  setField("warranty_duration",  description.warranty_duration,  { confidence: 0.6,  source: "inferred", reasoning: "Default — override in the AI-chat field to set a real warranty." });
  setField("warranty_text",      description.warranty_text,      { confidence: 0.6,  source: "inferred", reasoning: "Default — override in the AI-chat field to set warranty terms." });
  setField("warranty_address",   description.warranty_address,   { confidence: 0.6,  source: "inferred", reasoning: "Default — override in the AI-chat field to set a warranty address." });
  setField("production_country", description.production_country, { confidence: 0.7,  source: "inferred", reasoning: "AI inference based on brand / category. Override via AI-chat if known." });

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

  // ── Post-hoc default-fill on dynamic_attributes ─────────────────────────
  // Pass C is told about AI_DYNAMIC_ATTR_DEFAULTS in its prompt, but the
  // model doesn't reliably echo back keys the category schema doesn't
  // explicitly list. The product_note (buyer review nudge) and
  // from_the_manufacturer defaults SHOULD appear on every listing — they
  // get silently stripped by Jumia on categories that don't accept them,
  // so it's safe to set them universally.
  //
  // Rules:
  //   - Don't overwrite a value the AI already filled (it may have
  //     legitimately customised the note based on userContext).
  //   - Don't overwrite a user-edited value (mergedSources[k] === "user").
  //   - Otherwise inject the canonical default from policy.ts.
  const finalDynamicAttrs: Record<string, string> = { ...filled.dynamic_attributes };
  for (const [k, v] of Object.entries(AI_DYNAMIC_ATTR_DEFAULTS)) {
    const existing = finalDynamicAttrs[k];
    if (existing && existing.trim().length > 0) continue; // AI already set
    if (mergedSources[k] === "user") continue;            // seller set explicitly
    finalDynamicAttrs[k] = v;
    if (!mergedSources[k]) mergedSources[k] = "ai";
    if (!mergedConfidence[k]) {
      mergedConfidence[k] = {
        confidence: 0.6,
        source:     "inferred",
        reasoning:  `Default '${k}' applied — override per-listing if needed.`,
      };
    }
  }

  await db.from("listings").update({
    ...updates,
    category_code:       String(chosen.code),
    category_path:       chosen.path,
    dynamic_attributes:  finalDynamicAttrs,
    field_sources:       mergedSources,
    field_confidence:    mergedConfidence,
    category_alternates: alternatesForUI,
    // Persist the seller's free-text prompt so re-runs honour it
    // automatically (without forcing them to retype on every re-analyze).
    // null = no prompt this run, but DON'T clobber a previously-stored
    // one — only persist when we have something fresh to store.
    ...(userContext ? { user_prompt: userContext } : {}),
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

  // Log the per-pass timing breakdown so we can pinpoint slowness from
  // Vercel logs without DevTools access. After the B+C collapse the
  // typical breakdown is `describe=Xms retrieval=Yms combined_bc=Zms`;
  // the rank/fill numbers only appear when the combined call failed
  // and we dropped to the separate-pass fallback.
  const total_ms = Date.now() - t0;
  console.info(
    `[auto-analyze] listing=${params.id} ` +
      `describe=${timings.describe_ms ?? "?"}ms ` +
      `retrieval=${timings.retrieval_ms ?? "?"}ms ` +
      `combined_bc=${timings.combined_bc_ms ?? "—"}ms ` +
      `rank=${timings.rank_ms ?? "—"}ms ` +
      `fill=${timings.fill_ms ?? "—"}ms ` +
      `total=${total_ms}ms ` +
      `images=${images.length} ` +
      `path=${timings.combined_bc_ms != null ? "combined" : "fallback"}`,
  );

  // ── 7. Return everything the UI needs to refresh in place ───────────────
  return NextResponse.json({
    success: true,
    timings: {
      ...timings,
      total_ms,
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
