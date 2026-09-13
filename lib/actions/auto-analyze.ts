/**
 * Auto-analyze orchestration — the core behind POST
 * /api/listings/[id]/auto-analyze, extracted so a caller with no Clerk
 * session (the WhatsApp webhook) can run the exact same pipeline by
 * passing userId directly instead of it being read from request cookies.
 *
 * Runs Pass A (describe) → department-first category retrieval (fuzzy text
 * search + a timeout-bounded embedding search, both scoped to the AI's
 * picked department — see the category-resolution section below) →
 * combined Pass B+C (rank + fill), with the old separate Pass B / Pass C
 * as a fallback, then the full field-merge / dynamic-attribute
 * default-fill / gap-fill / description-expand pipeline, and persists
 * everything back to the listing + variants tables. The route is now a
 * thin wrapper: authenticate, rate-limit, parse the body, call this, map
 * the result to JSON.
 */

import { createServerClient } from "@/lib/supabase/server";
import {
  aiPassA_describeProduct,
  aiPassB0_pickDepartment,
  aiPassB_rankCategory,
  extractAttributesForCategory,
  aiPassBC_pickAndFill,
  aiFillGaps,
  aiExpandDescription,
  type CandidateWithSchema,
  type RankedCategory,
} from "@/lib/actions/ai";
import {
  getListableCategories,
  getAllCategoriesForTree,
  getCategoryAttributes,
  fetchAttributesFromJumia,
  upsertAttributes,
} from "@/lib/jumia/categories";
import {
  searchCategoriesByText,
  searchCategoriesByEmbedding,
  getTopLevelDepartments,
  getSubtreeCategories,
  mergeCandidates,
  type CategoryCandidate,
} from "@/lib/jumia/category-search";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import { AI_DYNAMIC_ATTR_DEFAULTS, resolvePatternDefault } from "@/lib/ai/policy";
import { webSearch, formatSearchSnippetsForPrompt, isWebSearchEnabled } from "@/lib/ai/web-search";

export type AutoAnalyzeResult =
  | {
      ok: true;
      timings: Record<string, number>;
      description: Awaited<ReturnType<typeof aiPassA_describeProduct>>;
      category: { code: number; name: string; path: string; confidence: number };
      alternates: RankedCategory[];
      needsUserConfirmation: boolean;
      candidates_considered: number;
      attributes_in_schema: number;
      attributes_filled: number;
      variations_detected: number;
      title: string;
      brand: string | null;
    }
  | {
      ok: false;
      code:
        | "not_found"
        | "no_images"
        | "describe_failed"
        | "no_categories_synced"
        | "catalog_not_synced"
        | "rank_failed"
        | "no_category_picked";
      message: string;
      description?: unknown;
      candidates?: unknown;
    };

/**
 * Run the full analyze pipeline for `listingId` (owned by `userId`).
 *
 * `userPromptOverride`, when given, is the "SELLER CONTEXT" free-text hint
 * for this run (equivalent to the HTTP route's request-body `userPrompt`).
 * Falls back to the listing's persisted `user_prompt` when omitted, then to
 * no hint at all — same resolution order the route used.
 */
export async function runAutoAnalyze(
  userId: string,
  listingId: string,
  userPromptOverride?: string | null,
): Promise<AutoAnalyzeResult> {
  let userContext: string | null = userPromptOverride?.trim() ? userPromptOverride.trim().slice(0, 1000) : null;

  const db = createServerClient();

  // ── Load listing + verify ownership ───────────────────────────────────────
  const { data: listing } = await db
    .from("listings")
    .select("id, user_id, sku, images, title, brand, description, highlights, selling_price, quantity, dynamic_attributes, field_sources, field_confidence, user_prompt")
    .eq("id", listingId)
    .eq("user_id", userId)
    .maybeSingle();

  if (!listing) return { ok: false, code: "not_found", message: "Listing not found" };

  // If no prompt came in this request, fall back to the one we persisted
  // from a previous analyze. Means the seller can re-run without
  // re-typing — their original "this is a pack of 6" still applies.
  if (!userContext && listing.user_prompt) {
    userContext = listing.user_prompt as string;
  }

  const images = (listing.images ?? []) as string[];
  if (images.length === 0) {
    return { ok: false, code: "no_images", message: "Upload at least one image before running Analyze with AI." };
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
    return { ok: false, code: "describe_failed", message: `Step 1 (describe) failed: ${(e as Error).message}` };
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

  // Every "no category" exit below hands the category choice back to the
  // seller. Pass A's work is done by then — and on WhatsApp it has already
  // been charged for — so persist it on the way out rather than returning a
  // listing that still holds nothing but its images: the category becomes
  // the one thing left to pick, not a blank draft to rewrite from scratch.
  // Deliberately narrow (the three narrative fields Pass A is authoritative
  // for) and it honours the same rule the main updates payload does further
  // down: never clobber a field the seller edited themselves.
  const bailToManualCategory = async (): Promise<AutoAnalyzeResult> => {
    const sources = (listing.field_sources ?? {}) as Record<string, "ai" | "user">;
    const patch: Record<string, unknown> = {};

    const keep = (col: "title" | "description" | "highlights", value: string | null) => {
      if (!value) return;
      if (sources[col] === "user") return;
      const existing = listing[col] as string | null;
      // Non-empty and not AI-written = legacy or seller data; leave it be.
      if (existing && existing.trim() !== "" && sources[col] !== "ai") return;
      patch[col] = value;
    };

    keep("title",       description.title);
    keep("description", description.description);
    keep("highlights",  description.highlights);

    if (Object.keys(patch).length > 0) {
      const mergedSources = { ...sources };
      for (const col of Object.keys(patch)) mergedSources[col] = "ai";
      await db.from("listings").update({
        ...patch,
        field_sources: mergedSources,
        ...(userContext ? { user_prompt: userContext } : {}),
        updated_at: new Date().toISOString(),
      }).eq("id", listingId);
    }

    return {
      ok: false,
      code: "no_category_picked",
      message: "Couldn't find a confident category match — pick one manually.",
      description,
    };
  };

  // ── 2. CATEGORY RESOLUTION: department-first, then narrow within it ──────
  //
  // Previously: fuzzy + embedding + Jumia-catalog search against the FULL
  // ~27k-row catalog, merged, with a "grab the first 200 categories
  // alphabetically" fallback whenever all three came up empty. Confirmed
  // live 2026-09-12: that fallback is how a safety helmet and a canvas
  // easel both got filed under "Laptops" — a blind alphabetical slice of
  // a huge catalog has nothing to do with the actual product, and the
  // rank pass below can only ever be as good as the candidates it's
  // given. The two external retrieval sources (Google's embedding
  // endpoint, Jumia's own catalog search) were also the confirmed source
  // of the 4s/6s timeouts stacking up toward this route's hard ceiling.
  //
  // New approach: ask the AI which top-level DEPARTMENT (e.g. "Home &
  // Office", "Fashion") the product belongs in first — a small, cheap,
  // fast decision among ~20-40 broad options, no retrieval involved at
  // all. Then search ONLY within that department's own subtree (a few
  // hundred to low thousands of rows, not the full ~27k) for the actual
  // candidate pool below. Even a middling match within the RIGHT
  // department beats a strong match in the wrong one.
  //
  // The subtree search itself is two sources, merged: fuzzy text (fast,
  // catches vocabulary that overlaps the category name) plus a
  // timeout-bounded embedding search (catches vocabulary mismatches
  // fuzzy search can't, e.g. "wireless earbuds" vs. a category literally
  // named "In-Ear Headphones") — see searchCategoriesByEmbedding's own
  // 4s internal timeout in lib/jumia/category-search.ts, which caps its
  // worst case far below this route's timeout risk, so re-adding it here
  // can't reopen the stacking-timeout problem that got it dropped in the
  // first place. Both sources are scoped to the SAME department subtree
  // (see the new migration's dept_path filter), so a semantic hit can
  // never smuggle in a wrong-department candidate — it can only add or
  // reinforce candidates the department-first design already trusts.
  // If a department pick is wrong, its next-best alternate gets a second
  // try before giving up — and giving up now means "no category yet,
  // pick one manually" (routes to the category picker), never a
  // confidently-wrong guess.
  const tRet = Date.now();
  const [listableCategories, allCategories] = await Promise.all([
    getListableCategories(),
    getAllCategoriesForTree(),
  ]);

  if (listableCategories.length === 0 || allCategories.length === 0) {
    return {
      ok: false,
      code: "no_categories_synced",
      message: "No categories synced yet. Open Settings → Integrations → Sync categories first.",
    };
  }

  const departments = getTopLevelDepartments(allCategories);
  let candidates: CategoryCandidate[] = [];

  try {
    const deptPick = await aiPassB0_pickDepartment(
      images,
      departments,
      userContext,
      description.intended_use_case,
      description.environment,
      { forceBestModel: true },
    );

    const tried = new Set<string>();
    for (const dept of [deptPick.primary, ...deptPick.alternates]) {
      if (!dept || candidates.length > 0 || tried.has(dept.path)) continue;
      tried.add(dept.path);
      const subtree = getSubtreeCategories(listableCategories, dept.path);
      if (subtree.length === 0) continue;
      const fuzzyHits = searchCategoriesByText(retrievalQuery, subtree, 8);
      const semanticHits = await searchCategoriesByEmbedding(retrievalQuery, 8, dept.path);
      const hits = semanticHits.length > 0 ? mergeCandidates(fuzzyHits, semanticHits, 8) : fuzzyHits;
      if (hits.length > 0) candidates = hits;
    }
  } catch (e) {
    console.warn(`[auto-analyze] department pick failed, falling back to full-catalog fuzzy search: ${(e as Error).message}`);
  }

  // Last resort: full-catalog fuzzy search (still real retrieval, never a
  // blind slice) — only reached if department picking itself threw, or
  // every department subtree it tried came up empty.
  if (candidates.length === 0) {
    candidates = searchCategoriesByText(retrievalQuery, listableCategories, 8);
  }

  console.info(
    `[auto-analyze] category resolution for query="${retrievalQuery.slice(0, 100)}" → ${candidates.length} candidate(s)`,
  );

  timings.retrieval_ms = Date.now() - tRet;

  if (candidates.length === 0) {
    // Genuinely nothing matched anywhere. Hand back to the seller rather
    // than guess — the listing keeps whatever category it had (usually
    // none), and the focused/full editor's category picker is the way
    // forward from here.
    return bailToManualCategory();
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

  // The model looked at every candidate and said none of them is where this
  // product belongs. Falling through to the separate passes below would just
  // force a pick from the same bad candidates — exactly how a canvas wall-art
  // print got filed under "Icing & Decorating Spatulas" at 0.95 confidence
  // and rejected by Jumia. Hand the choice to the seller instead.
  if (combined.noCandidateFits) {
    console.info(
      `[auto-analyze] no candidate category fit — routing to manual pick for query="${retrievalQuery.slice(0, 100)}"`,
    );
    return bailToManualCategory();
  }

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
      return {
        ok: false,
        code: "rank_failed",
        message: `Step 3 (rank) failed: ${(e as Error).message}`,
        description,
        candidates,
      };
    }

    if (!ranked.primary) {
      return {
        ok: false,
        code: "no_category_picked",
        message: "The AI couldn't pick a category from the candidates. Pick manually.",
        description,
        candidates,
      };
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

  // ── Post-hoc default-fill on dynamic_attributes (schema-aware) ──────────
  //
  // Two passes here:
  //
  // A) DEFAULT KEY RESOLUTION
  //    AI_DYNAMIC_ATTR_DEFAULTS keys are intent names ("product_note",
  //    "what_is_in_the_box") but Jumia uses different actual attribute
  //    names per category — one category calls it `product_note`, another
  //    calls it `note`, another calls it `seller_note`. If we write our
  //    intent name and the schema doesn't have that exact key, the
  //    review-page SchemaForm renders the field as empty (it reads by
  //    schema-attribute-name, not by intent). To fix: for each intent,
  //    search the category schema for an attribute whose name or label
  //    matches the intent's keyword patterns, and write the default to
  //    that resolved key. Falls back to the literal intent key if no
  //    schema match is found (Jumia drops unknown keys silently anyway).
  //
  // B) NUMERIC ATTRIBUTE SCRUB
  //    The AI sometimes returns a boolean ("true") or a string with text
  //    ("0.5 (estimated)") for an attribute the schema declares as
  //    number-type. That causes Jumia QC rejection like
  //    "Attribute [capacity_liter] with the value [true] should be a number".
  //    For every attribute whose schema type is `number`, parse the value
  //    and either replace with a clean numeric string or drop it.

  // Intent → keyword patterns that match the schema-attribute name OR label.
  // First match wins. Order from most-specific to most-general.
  const DEFAULT_INTENT_PATTERNS: Record<string, RegExp[]> = {
    product_note:          [/^product[_\s-]?note$/i, /^seller[_\s-]?note$/i, /^note$/i, /thank.*review/i],
    what_is_in_the_box:    [
      /what.*in.*box/i,
      /^in.*the.*box$/i,
      /^in[_\s-]?the[_\s-]?box$/i,
      /package[_\s-]?contents?/i,
      /package[_\s-]?includes?/i,
      /^contents?$/i,
      /what.*included/i,
    ],
    from_the_manufacturer: [/from.*manufacturer/i, /^manufacturer[_\s-]?note$/i, /^manufacturer[_\s-]?message$/i],
  };

  function resolveSchemaKey(intent: string): string {
    // Exact-name match wins (the schema literally has the intent key).
    const exact = attrs.find((a) => a.name === intent);
    if (exact) return exact.name;
    // Pattern-based match against attribute name + label.
    const patterns = DEFAULT_INTENT_PATTERNS[intent] ?? [];
    for (const pattern of patterns) {
      const match = attrs.find((a) => pattern.test(a.name) || pattern.test(a.label));
      if (match) return match.name;
    }
    // No schema match — use the literal intent name. Jumia will drop it
    // silently on push if the category doesn't recognise it; the local
    // review UI may also drop it but at least the data is preserved.
    return intent;
  }

  const finalDynamicAttrs: Record<string, string> = { ...filled.dynamic_attributes };

  // Product-aware defaults: prefer a product-specific value over the generic
  // canned default. For "what_is_in_the_box" we write a clean multi-line
  // "1x Item" list (Jumia's preferred format), substituting the listing
  // title for the main product so it reads:
  //     1x Volcano Humidifier
  //     1x User manual (if applicable)
  //     1x Original packaging
  // — much more buyer-trust-worthy than a generic prose note.
  function getProductAwareDefault(intent: string, fallback: string): string {
    const title = (updates.title as string | undefined) ?? (listing?.title ?? "") as string;
    if (intent === "what_is_in_the_box" && title && title.length > 0) {
      // Take the first 6 words from the title for a tidy product name.
      const productName = title.split(/\s+/).slice(0, 6).join(" ");
      return `1x ${productName}\n1x User manual (if applicable)\n1x Original packaging`;
    }
    return fallback;
  }

  // A) Inject defaults under the schema-resolved key.
  for (const [intent, defaultValue] of Object.entries(AI_DYNAMIC_ATTR_DEFAULTS)) {
    const resolvedKey = resolveSchemaKey(intent);
    const existing = finalDynamicAttrs[resolvedKey];
    // For what_is_in_the_box, also overwrite degenerate values — the
    // legacy numeric-scrub stripped full item lists down to a single
    // digit, and re-runs need to repair those. Anything that:
    //   * is shorter than 15 chars (a real list is at least one
    //     "1x Product Name" line)
    //   * is just digits / whitespace
    //   * contains no "1x" / "1×" / "•" / newline markers
    // counts as junk and gets the multi-line default.
    const looksJunk = intent === "what_is_in_the_box" && existing && (
      existing.trim().length < 15 ||
      /^[\s\d.,]+$/.test(existing.trim()) ||
      !/(\d+\s*[x×]|[•\n])/i.test(existing)
    );
    const looksEmpty =
      !existing || existing.trim().length === 0 || Boolean(looksJunk);
    if (!looksEmpty) continue;                            // AI already set
    if (mergedSources[resolvedKey] === "user") continue;  // seller set explicitly
    finalDynamicAttrs[resolvedKey] = getProductAwareDefault(intent, defaultValue);
    if (!mergedSources[resolvedKey]) mergedSources[resolvedKey] = "ai";
    if (!mergedConfidence[resolvedKey]) {
      mergedConfidence[resolvedKey] = {
        confidence: 0.6,
        source:     "inferred",
        reasoning:  `Default '${intent}' applied to '${resolvedKey}' — override per-listing if needed.`,
      };
    }
  }

  // B) Numeric attribute scrub. Any value the AI put into a number-type
  //    attribute must parse cleanly to a number — otherwise drop it so
  //    Jumia's "should be a number" QC error doesn't fire.
  //
  //    EXCEPTIONS — schema's `type` field is unreliable for these:
  //
  //    a) Explicit text-attribute allowlist: Jumia's schema sometimes
  //       types prose attributes (description / what_is_in_the_box /
  //       manufacturer_txt) as "number". Scrub would mangle them.
  //
  //    b) Heuristic — name suggests prose: any attribute whose name
  //       includes "desc", "note", "text", "title", "label", "name",
  //       or whose value contains alphabetic characters AND spaces.
  //       This catches future schema oddities we haven't allowlisted.
  const SKIP_NUMERIC_SCRUB = new Set([
    "what_is_in_the_box", "in_the_box", "package_contents", "package_includes",
    "product_note", "note", "seller_note",
    "from_the_manufacturer", "manufacturer_note", "manufacturer_txt", "manufacturer",
    "description", "product_description", "long_description", "short_description",
    "title", "product_title", "name", "product_name", "label",
  ]);
  const TEXTY_NAME_RE = /(desc|note|text|title|label|name|comment|message|copy|tagline)/i;

  const numericAttrNames = new Set(
    attrs
      .filter((a) => a.type === "number")
      .map((a) => a.name.toLowerCase())
      .filter((n) => !SKIP_NUMERIC_SCRUB.has(n) && !TEXTY_NAME_RE.test(n)),
  );
  for (const key of Object.keys(finalDynamicAttrs)) {
    if (!numericAttrNames.has(key.toLowerCase())) continue;
    const raw   = String(finalDynamicAttrs[key]);

    // Last-resort heuristic: if the value contains spaces AND letters,
    // it's prose — leave it alone regardless of schema type.
    if (/[a-zA-Z]/.test(raw) && /\s/.test(raw)) {
      console.warn(
        `[auto-analyze] skipping numeric-scrub for '${key}' — value contains prose: '${raw.slice(0, 40)}'`,
      );
      continue;
    }

    const match = raw.match(/-?\d+(?:\.\d+)?/);
    if (match) {
      const n = parseFloat(match[0]);
      if (Number.isFinite(n)) {
        finalDynamicAttrs[key] = String(n); // canonical numeric string
        continue;
      }
    }
    // Couldn't extract a real number ("true", "yes", "unknown") — drop it.
    // Leaving the field empty is better than failing Jumia QC.
    console.warn(
      `[auto-analyze] dropping non-numeric value for numeric attr '${key}': '${raw.slice(0, 40)}'`,
    );
    delete finalDynamicAttrs[key];
    // Also clear any field_sources / field_confidence tracking for it.
    if (mergedSources[key] !== "user") delete mergedSources[key];
    delete mergedConfidence[key];
  }

  // ── C) PATTERN DEFAULTS for still-empty required attributes ─────────────
  //
  // Phase 1 of the "user enters price → submits" plan. For attributes
  // whose name or label matches a common pattern (Skin Type / Season /
  // Gender / Size / Style / ...), inject a sensible default — from the
  // schema's allowed_values when present, otherwise a generic string.
  // Cheap: pure pattern match, no AI call.
  for (const a of attrs) {
    if (!a.required) continue;
    const existing = finalDynamicAttrs[a.name];
    if (existing && existing.trim().length > 0) continue;
    if (mergedSources[a.name] === "user") continue;
    const patternValue = resolvePatternDefault({
      name:           a.name,
      label:          a.label,
      allowed_values: a.allowed_values,
    });
    if (patternValue) {
      finalDynamicAttrs[a.name] = patternValue;
      if (!mergedSources[a.name]) mergedSources[a.name] = "ai";
      mergedConfidence[a.name] = {
        confidence: 0.55,
        source:     "inferred",
        reasoning:  `Pattern default applied — change if you have a specific value.`,
      };
    }
  }

  // ── D) GAP-FILL AI PASS for remaining empty required attributes ─────────
  //
  // Phase 1+3: after pattern defaults, anything still empty + required
  // gets sent to a focused Gemini call that fills with confident
  // inferences from general knowledge + the image. Skips cleanly if
  // there are no gaps (no extra AI cost on the happy path).
  const stillEmptyRequired = attrs.filter(
    (a) =>
      a.required &&
      (!finalDynamicAttrs[a.name] || String(finalDynamicAttrs[a.name]).trim().length === 0) &&
      mergedSources[a.name] !== "user",
  );

  if (stillEmptyRequired.length > 0) {
    const tGap = Date.now();
    try {
      const titleForGap   = String(updates.title       ?? listing.title       ?? "");
      const brandForGap   = String(updates.brand       ?? listing.brand       ?? "");
      const descForGap    = String(updates.description ?? listing.description ?? "");

      // ── Web search boost (Google Custom Search) ────────────────────────
      // Before asking the AI to fill the gaps, search Google for
      // "{brand} {title}" and feed the top snippets in as ground truth.
      // The model now has real product-page data (specs, capacities,
      // dimensions) instead of guessing from the image alone.
      //
      // Skipped entirely when:
      //   - GOOGLE_CSE_ID isn't set (free fallback behaviour)
      //   - we don't have at least a title to build a query from
      //
      // Hard 6s ceiling inside webSearch() — never stalls the analyze.
      let webSearchContext = "";
      if (isWebSearchEnabled() && titleForGap.trim().length > 0) {
        const query = [brandForGap, titleForGap].filter(Boolean).join(" ").slice(0, 200);
        const results = await webSearch(query);
        webSearchContext = formatSearchSnippetsForPrompt(results, 3);
      }

      const gap = await aiFillGaps(
        {
          title:        titleForGap,
          brand:        brandForGap || null,
          description:  descForGap,
          categoryPath: chosen.path,
          images,
          webSearchContext,
        },
        stillEmptyRequired.map((a) => ({
          name:           a.name,
          label:          a.label,
          type:           String(a.type),
          allowed_values: a.allowed_values,
        })),
        { forceBestModel: true },
      );
      for (const [k, v] of Object.entries(gap.filled)) {
        if (mergedSources[k] === "user") continue;
        finalDynamicAttrs[k] = v;
        if (!mergedSources[k]) mergedSources[k] = "ai";
        mergedConfidence[k] = {
          confidence: webSearchContext ? 0.75 : 0.65,
          source:     "inferred",
          reasoning:  webSearchContext
            ? "AI gap-fill backed by web-search ground truth."
            : "AI gap-fill — confident default based on product class.",
        };
      }
      console.info(
        `[auto-analyze] gap-fill: requested=${stillEmptyRequired.length} filled=${Object.keys(gap.filled).length} web_search=${webSearchContext ? "yes" : "no"} ms=${Date.now() - tGap}`,
      );
    } catch (e) {
      console.warn(`[auto-analyze] gap-fill failed (non-fatal): ${(e as Error).message}`);
    }
  }

  // ── E) DESCRIPTION AUTO-EXPAND ──────────────────────────────────────────
  //
  // Phase 2: Jumia rejects descriptions under 50 chars. If Pass A
  // returned something short, run a focused expand call that grows
  // it to 150-400 words using the title / brand / highlights as
  // context. Doesn't expand if the seller has already edited the
  // description (source === "user") or if it's already long enough.
  const currentDescription = String(updates.description ?? listing.description ?? "");
  const descSource = mergedSources["description"];
  if (
    currentDescription.length > 0 &&
    currentDescription.length < 150 &&
    descSource !== "user"
  ) {
    const tExpand = Date.now();
    try {
      const expanded = await aiExpandDescription(
        currentDescription,
        {
          title:      String(updates.title ?? listing.title ?? ""),
          brand:      (updates.brand as string | null) ?? listing.brand ?? null,
          keywords:   description.keywords ?? [],
          highlights: String(updates.highlights ?? listing.highlights ?? ""),
        },
        { forceBestModel: true },
      );
      if (expanded && expanded.length > currentDescription.length) {
        updates.description = expanded;
        mergedSources["description"] = "ai";
        mergedConfidence["description"] = {
          confidence: 0.8,
          source:     "inferred",
          reasoning:  "Expanded from a short AI-generated description.",
        };
      }
      console.info(`[auto-analyze] description-expand ms=${Date.now() - tExpand}`);
    } catch (e) {
      console.warn(`[auto-analyze] description-expand failed (non-fatal): ${(e as Error).message}`);
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
  }).eq("id", listingId);

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
      const baseSku    = (listing.sku as string | undefined) ?? listingId.slice(0, 8).toUpperCase();
      const basePrice  = (listing.selling_price as number | undefined) ?? null;
      const baseStock  = (listing.quantity as number | undefined) ?? 1;
      const rows = description.variations.map((v) => ({
        listing_id:      listingId,
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
      await db.from("variants").delete().eq("listing_id", listingId);
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
    `[auto-analyze] listing=${listingId} ` +
      `describe=${timings.describe_ms ?? "?"}ms ` +
      `retrieval=${timings.retrieval_ms ?? "?"}ms ` +
      `combined_bc=${timings.combined_bc_ms ?? "—"}ms ` +
      `rank=${timings.rank_ms ?? "—"}ms ` +
      `fill=${timings.fill_ms ?? "—"}ms ` +
      `total=${total_ms}ms ` +
      `images=${images.length} ` +
      `path=${timings.combined_bc_ms != null ? "combined" : "fallback"}`,
  );

  return {
    ok: true,
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
  };
}
