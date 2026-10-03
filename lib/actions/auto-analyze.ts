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

import { snapToAllowedWithSynonyms, checkNumericConstraint } from "@/lib/jumia/preflight";
import { createServerClient } from "@/lib/supabase/server";
import {
  aiPassA_describeProduct,
  aiPassB0_pickDepartment,
  aiPassB_rankCategory,
  extractAttributesForCategory,
  aiPassBC_pickAndFill,
  aiFillGaps,
  aiExpandDescription,
  aiMatchAllowedValue,
  type CandidateWithSchema,
  type RankedCategory,
} from "@/lib/actions/ai";
import { warmEmbeddingBackend } from "@/lib/ai/embeddings";
import {
  detectPhotoNarration,
  proseLength,
  CONTENT_LENGTH_FLOORS,
} from "@/lib/ai/content-style-rules";
import { canonicalKey, columnFor } from "@/lib/jumia/attribute-mapping";
import { resolveStatedCategory } from "@/lib/jumia/stated-category";
import { isFashionCategory } from "@/lib/jumia/fashion-category";
import { aiReadNoteIntent } from "@/lib/actions/ai";
import { verifyNoteIntent, type NoteIntent } from "@/lib/whatsapp/note-intent";
import {
  extractVariantClaim,
  notesNameVariants,
  reconcileVariants,
} from "@/lib/whatsapp/variant-claims";
import {
  extractNoteAssertions,
  checkAssertions,
  correctionsFrom,
} from "@/lib/whatsapp/note-assertions";
import {
  getListableCategories,
  getAllCategoriesForTree,
  getCategoryAttributes,
  fetchAttributesFromJumia,
  upsertAttributes,
  type JumiaCategoryRow,
} from "@/lib/jumia/categories";
import {
  searchCategoriesByText,
  getTopLevelDepartments,
  getSubtreeCategories,
  searchCategoriesByEmbeddingMulti,
  poolByRank,
  mergeCandidates,
  diverseTop,
  type CategoryCandidate,
} from "@/lib/jumia/category-search";
import { getValidJumiaCredentials, reconcileDraftVariation } from "@/lib/jumia/api";
import { blockedCategoryCodes, sellerCountry, withoutBlocked } from "@/lib/jumia/unlistable-categories";
import { provenCategoriesFor } from "@/lib/jumia/live-listings";
import { withAiUsageContext } from "@/lib/ai/usage";
import { AI_DYNAMIC_ATTR_DEFAULTS, resolvePatternDefault } from "@/lib/ai/policy";
import { webSearch, formatSearchSnippetsForPrompt, isWebSearchEnabled } from "@/lib/ai/web-search";
import { loadLearnedRestrictedWords } from "@/lib/jumia/learned-restricted-words";

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
 * If `nonLeaf` isn't actually listable on Jumia, resolve to one of its
 * leaf descendants instead of letting the pick through as-is — see
 * ensureLeafCategory's doc comment (its only caller) for the real-batch
 * failure this closes. Extracted to its own function so that decision is
 * testable without mocking the whole analyze pipeline: every dependency
 * here is a named import already designed to be mocked independently
 * (aiPassB_rankCategory, the category-schema helpers).
 *
 * Returns null when there's nothing to resolve to — no leaf descendant
 * exists under `nonLeaf`, or the model couldn't pick one from what does.
 * ensureLeafCategory decides what to do with that; this function makes
 * no assumption about it.
 */
export async function resolveNonLeafCategory(
  nonLeaf: JumiaCategoryRow,
  listableCategories: JumiaCategoryRow[],
  images: Parameters<typeof aiPassB_rankCategory>[0],
  userContext: Parameters<typeof aiPassB_rankCategory>[2],
  useCase: Parameters<typeof aiPassB_rankCategory>[3],
  environment: Parameters<typeof aiPassB_rankCategory>[4],
  accessToken: string | null,
): Promise<{
  ranked: Awaited<ReturnType<typeof aiPassB_rankCategory>>;
  filled: Awaited<ReturnType<typeof extractAttributesForCategory>>;
} | null> {
  const leafChildren = listableCategories.filter(
    (c) => c.is_leaf && c.path.startsWith(`${nonLeaf.path} > `),
  );
  if (leafChildren.length === 0) return null;

  const leafRanked = await aiPassB_rankCategory(
    images, leafChildren, userContext, useCase, environment, { forceBestModel: true },
  );
  if (!leafRanked.primary) return null;

  const leafCode = leafRanked.primary.code;
  // Cold-cache prefetch — a leaf reached only through this re-rank was
  // never part of the caller's own prefetched top-N schemas.
  const existingAttrs = await getCategoryAttributes(leafCode);
  if (existingAttrs.length === 0) {
    const leafRow = leafChildren.find((c) => c.code === leafCode);
    if (leafRow?.attribute_set_sid && accessToken) {
      try {
        const fresh = await fetchAttributesFromJumia(accessToken, leafRow.attribute_set_sid);
        if (fresh.length > 0) await upsertAttributes(leafCode, fresh);
      } catch (e) {
        console.warn(`[auto-analyze] leaf schema fetch failed for code=${leafCode}: ${(e as Error).message}`);
      }
    }
  }

  let filled: Awaited<ReturnType<typeof extractAttributesForCategory>> =
    { dynamic_attributes: {}, field_sources: {}, field_confidence: {} };
  try {
    filled = await extractAttributesForCategory(images, leafCode, userContext, { forceBestModel: true });
  } catch (e) {
    console.warn(`[auto-analyze] leaf re-rank attribute fill failed: ${(e as Error).message}`);
  }

  return { ranked: leafRanked, filled };
}

/**
 * Given a chosen category (`ranked`/`filled`), make sure it's genuinely
 * listable before runAutoAnalyze persists or pushes it — and NEVER signal
 * "ask the seller to pick manually" while doing so.
 *
 * Real batch, 2026-09-23: 5 of 7 failures in one 10-listing batch were
 * Jumia's "You can't list products in this category. Please choose a
 * different (more specific) category and try again." — every one of them
 * a category our OWN listableCategories rows already flagged is_leaf=false
 * (Refrigerators & Freezers, Mixers & Blenders, Chargers & Power Adapters,
 * Tabletop Lighting, T-shirts). is_leaf was already surfaced to the
 * ranking/pick prompts as a soft "prefer a leaf when one fits" signal (see
 * CategoryCandidate's doc comment in category-search.ts), but nothing
 * acted on it — if the top-N shortlist handed to the model didn't happen
 * to contain the right leaf, or it just ignored the hint, a non-leaf pick
 * sailed straight through to a real Jumia push and was rejected every
 * single time, guaranteed.
 *
 * The actual root cause behind that same-day incident turned out to be
 * upstream of this function entirely: is_leaf itself was wrong for 22,473
 * of 27,862 cached categories (recomputeIsLeafForAllCategories' finalize
 * step had gone stale — see its own doc comment for the earlier version of
 * this exact class of bug) and was corrected directly in the database.
 * With good data, resolveNonLeafCategory's re-rank among the non-leaf's
 * real leaf descendants resolves cleanly almost every time.
 *
 * When it still can't (no leaf descendant exists, or the model won't pick
 * one), this must NEVER surface as "pick a category manually" — a
 * follow-up real-world hit of this exact branch did exactly that
 * (2026-09-23 seller direction: every category here is meant to be
 * auto-picked, full stop). So on failure this keeps the ORIGINAL non-leaf
 * `ranked`/`filled` and returns them unchanged, exactly as if this
 * function were never called. A push that then fails surfaces as an
 * ordinary Jumia rejection, which the existing "Fix & resubmit" auto-
 * remedy (classifyJumiaRejection's "rerun" bucket, lib/jumia/
 * rejection-remedy.ts) already retries on its own — never a dead end.
 */
export async function ensureLeafCategory(
  ranked: Awaited<ReturnType<typeof aiPassB_rankCategory>>,
  filled: Awaited<ReturnType<typeof extractAttributesForCategory>>,
  listableCategories: JumiaCategoryRow[],
  images: Parameters<typeof aiPassB_rankCategory>[0],
  userContext: Parameters<typeof aiPassB_rankCategory>[2],
  useCase: Parameters<typeof aiPassB_rankCategory>[3],
  environment: Parameters<typeof aiPassB_rankCategory>[4],
  accessToken: string | null,
): Promise<{
  ranked: Awaited<ReturnType<typeof aiPassB_rankCategory>>;
  filled: Awaited<ReturnType<typeof extractAttributesForCategory>>;
}> {
  const listableByCode = new Map(listableCategories.map((c) => [c.code, c]));
  const primaryRow = listableByCode.get(ranked.primary!.code);
  if (!primaryRow || primaryRow.is_leaf) return { ranked, filled };

  console.warn(
    `[auto-analyze] chosen category ${primaryRow.code} "${primaryRow.name}" is not a leaf — re-ranking before persisting.`,
  );
  const resolved = await resolveNonLeafCategory(
    primaryRow, listableCategories, images, userContext, useCase, environment, accessToken,
  );
  if (resolved) return resolved;

  console.warn(
    `[auto-analyze] no leaf resolution for ${primaryRow.code} "${primaryRow.name}" — ` +
    `keeping the original pick rather than asking the seller to choose manually.`,
  );
  return { ranked, filled };
}

/**
 * Never let more than one variant row collapse to the identical "..."
 * placeholder (reconcileDraftVariation in lib/jumia/api.ts) — Jumia's own
 * duplicate-variation validation rejects two rows carrying the same
 * variation value under one parentSku, the exact shape of "Duplicate
 * Variation on Product with parentSKU [...] and variation [...]" the
 * 2026-09-23 sandal incident closed in mapListingToJumiaProducts.
 *
 * Real live case, same day: a Backpacks listing whose note said "black and
 * grey" — the category's own variant axis is SIZE-only (18", ..., S/M/L/
 * XL, "One Size Fits All"), so neither colour matched it and BOTH rows
 * fell back to "..." independently, producing two variants with the exact
 * same value. Keeping only the first is correct here specifically because
 * every row collapsing to "..." already means NONE of them named a real,
 * distinguishable option on this category's own axis — there is genuinely
 * only one listable variant, however many colours/labels the seller or
 * the photos named.
 */
export function collapseDuplicateEllipsisVariants<T extends { variation: string }>(rows: T[]): T[] {
  const ellipsisRows = rows.filter((r) => r.variation === "...");
  if (ellipsisRows.length <= 1) return rows;
  return [...rows.filter((r) => r.variation !== "..."), ellipsisRows[0]];
}

/**
 * The category the seller chose for this listing themselves — marked
 * field_sources.category_code = "user" by refillAttributesForCategory
 * whenever a seller switches category (the editor's picker, WhatsApp's
 * category buttons and category question). Null when the AI picked it.
 */
export function sellerChosenCategoryCode(listing: { category_code?: unknown; field_sources?: unknown }): number | null {
  const sources = (listing.field_sources ?? {}) as Record<string, string>;
  const code = String(listing.category_code ?? "");
  return sources.category_code === "user" && /^\d+$/.test(code) ? Number(code) : null;
}

/**
 * The category-resolution result for a seller-chosen category: that
 * category as the pick, its fields filled from the photos. Null when it's
 * no longer listable, so the caller falls back to the AI's own pick.
 */
export async function keepSellerCategory(
  userId:      string,
  code:        number,
  images:      string[],
  userContext: string | null,
): Promise<{
  ranked:                Awaited<ReturnType<typeof aiPassB_rankCategory>>;
  filled:                Awaited<ReturnType<typeof extractAttributesForCategory>>;
  candidatesWithSchemas: CandidateWithSchema[];
} | null> {
  const cat = (await getListableCategories()).find((c) => Number(c.code) === code);
  if (!cat) return null;

  let attrs = await getCategoryAttributes(code);
  if (attrs.length === 0 && cat.attribute_set_sid) {
    try {
      const { accessToken } = await getValidJumiaCredentials(userId);
      const fresh = await fetchAttributesFromJumia(accessToken, cat.attribute_set_sid);
      if (fresh.length > 0) {
        await upsertAttributes(code, fresh);
        attrs = fresh;
      }
    } catch (e) {
      console.warn(`[auto-analyze] schema fetch failed for seller's category ${code}: ${(e as Error).message}`);
    }
  }

  let filled: Awaited<ReturnType<typeof extractAttributesForCategory>> = { dynamic_attributes: {}, field_sources: {}, field_confidence: {} };
  try {
    filled = await extractAttributesForCategory(images, code, userContext, { forceBestModel: true });
  } catch (e) {
    console.warn(`[auto-analyze] attribute fill failed for seller's category ${code}: ${(e as Error).message}`);
  }

  return {
    ranked: {
      primary:               { code, name: cat.name, path: cat.path, confidence: 1 },
      alternates:            [],
      needsUserConfirmation: false,
    },
    filled,
    candidatesWithSchemas: [{ code, name: cat.name, path: cat.path, attrs, is_leaf: cat.is_leaf }],
  };
}

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
  await loadLearnedRestrictedWords();
  // Every AI call in one draft (first draft or a Fix & resubmit redraft)
  // is costed as one run — see lib/ai/usage.ts.
  return withAiUsageContext({ feature: "listing_draft", userId, listingId }, () =>
    runAutoAnalyzeUnmetered(userId, listingId, userPromptOverride),
  );
}

async function runAutoAnalyzeUnmetered(
  userId: string,
  listingId: string,
  userPromptOverride?: string | null,
): Promise<AutoAnalyzeResult> {
  let userContext: string | null = userPromptOverride?.trim() ? userPromptOverride.trim().slice(0, 1000) : null;

  const db = createServerClient();

  // ── Load listing + verify ownership ───────────────────────────────────────
  const { data: listing } = await db
    .from("listings")
    .select("id, user_id, sku, images, title, brand, description, highlights, selling_price, sale_price, quantity, dynamic_attributes, field_sources, field_confidence, user_prompt, category_code, category_alternates")
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

  // Deliberately NOT awaited. The Vertex embed path pays a one-off cost per
  // process (module import + JWT sign + OAuth token fetch) that otherwise
  // lands inside searchCategoriesByEmbedding's 4s race further down and
  // blows it — measured live, a cold process logged "embedding search TIMED
  // OUT after 4000ms" with Vertex correctly configured and the RPC healthy,
  // so retrieval silently fell back to fuzzy-only on the very requests that
  // were already slowest. Starting it here overlaps that cost with Pass A's
  // ~5s vision call, so by the time retrieval runs the token is cached and
  // only the sub-second predict call has to fit the budget.
  void warmEmbeddingBackend();

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
  //
  // A category the seller chose themselves is kept: the redraft rewrites
  // the title, description and fields within it, but doesn't re-pick it.
  // Without this, a Fix & resubmit for an unrelated rejection (a title, a
  // missing attribute) could quietly move a product the seller had put in
  // the right category somewhere else.
  let candidates: CategoryCandidate[] = [];
  let candidatesWithSchemas: CandidateWithSchema[] = [];
  // Candidates put in front of retrieval's (close to a category the seller
  // named, then live-listing ones), which don't count against its top N.
  let frontCount = 0;
  let ranked: Awaited<ReturnType<typeof aiPassB_rankCategory>>;
  let filled: Awaited<ReturnType<typeof extractAttributesForCategory>>;

  // A category the seller named in their notes ("Category is wigs", see
  // lib/jumia/stated-category.ts) counts the same: one match is kept like
  // a picked one, and several (Jumia has Wigs under hair care, costumes and
  // toys) become the whole shortlist, for the model to choose from the
  // photos.
  const sellerCode = sellerChosenCategoryCode(listing);
  const stated = sellerCode == null
    ? await resolveStatedCategory(userId, userContext, description.title).catch((e) => {
        console.warn(`[auto-analyze] stated category lookup failed: ${(e as Error).message}`);
        return null;
      })
    : null;
  const keepCode = sellerCode ?? (stated?.kind === "match" ? stated.category.code : null);
  const kept = keepCode != null ? await keepSellerCategory(userId, keepCode, images, userContext) : null;
  if (stated) {
    console.info(
      `[auto-analyze] listing=${listingId} notes name a category: ` +
        (stated.kind === "match"
          ? `${stated.category.code} ${stated.category.path}`
          : `${stated.kind === "near" ? "close to " : ""}${stated.options.map((o) => o.code).join(", ")}`),
    );
  }
  if (kept) {
    ({ ranked, filled, candidatesWithSchemas } = kept);
  } else {
    const tRet = Date.now();
    const countryLookup = sellerCountry(userId);
    const [allListableCategories, allCategories, blocked, country] = await Promise.all([
      getListableCategories(),
      getAllCategoriesForTree(),
      countryLookup.then(blockedCategoryCodes),
      countryLookup,
    ]);
    // Categories Jumia has already refused in this seller's country (see
    // lib/jumia/unlistable-categories.ts) never reach the AI — neither on a
    // first draft nor on a fix-and-resubmit redraft. Dropped from the base
    // set here (so fuzzy search fills its slots with live categories) and
    // from the embedding hits below, which come straight from the database
    // rather than from this list.
    const listableCategories = withoutBlocked(allListableCategories, blocked);

    if (listableCategories.length === 0 || allCategories.length === 0) {
      return {
        ok: false,
        code: "no_categories_synced",
        message: "No categories synced yet. Open Settings → Integrations → Sync categories first.",
      };
    }

    // The categories the seller's notes named, as the whole shortlist.
    const statedCandidates: CategoryCandidate[] = (stated?.kind === "options" ? stated.options : []).flatMap((o) => {
      const row = listableCategories.find((c) => Number(c.code) === o.code);
      return row
        ? [{ code: Number(row.code), name: row.name, path: row.path, attribute_set_sid: row.attribute_set_sid, retrievalScore: 1, source: "seller" as const }]
        : [];
    });

    if (statedCandidates.length > 0) {
      candidates = statedCandidates;
    } else {
      const departments = getTopLevelDepartments(allCategories);

      try {
        const deptPick = await aiPassB0_pickDepartment(
          images,
          departments,
          userContext,
          description.intended_use_case,
          description.environment,
          { forceBestModel: true },
        );

        // Search the primary department AND its alternates, then pool.
        //
        // This used to stop at the first department that returned ANYTHING
        // (`if (candidates.length > 0) continue`), which made the alternates
        // a fallback for an EMPTY department rather than a wrong one. A
        // confidently-wrong pick is never empty: it returns eight plausible
        // candidates from the wrong subtree, the loop stops, and the vision
        // model is handed a shortlist with no correct answer anywhere in it.
        // That is how a safety helmet was filed under "Automobile > Car Care
        // > Cleaning Kits" — the department pick was wrong, and nothing
        // downstream could recover from it, because the right department was
        // never searched.
        //
        // Pooling instead of short-circuiting means a wrong primary is
        // survivable: the correct department's candidates are in the
        // shortlist too, and picking between them is exactly what the vision
        // model is good at. It also fits the catalog, which lists the same
        // leaf under several departments (Hard Hats exists under both
        // Industrial & Scientific and Home & Office), so "the" right
        // department is often not even unique.
        const deptsToSearch = [deptPick.primary, ...deptPick.alternates]
          .filter((d): d is NonNullable<typeof d> => Boolean(d))
          .filter((d, i, all) => all.findIndex((o) => o.path === d.path) === i)
          .filter((d) => getSubtreeCategories(listableCategories, d.path).length > 0)
          .slice(0, 3);

        if (deptsToSearch.length > 0) {
          // One embedding, N scoped matches, all inside one timeout budget.
          const semanticPerDept = await searchCategoriesByEmbeddingMulti(
            retrievalQuery,
            8,
            deptsToSearch.map((d) => d.path),
          );

          const perDept = deptsToSearch.map((dept, i) => {
            const subtree = getSubtreeCategories(listableCategories, dept.path);
            const fuzzyHits = searchCategoriesByText(retrievalQuery, subtree, 8);
            const semanticHits = withoutBlocked(semanticPerDept[i] ?? [], blocked);
            return semanticHits.length > 0 ? mergeCandidates(fuzzyHits, semanticHits, 8) : fuzzyHits;
          });

          candidates = poolByRank(perDept, 8);

          console.info(
            `[auto-analyze] searched ${deptsToSearch.length} department(s): ` +
              deptsToSearch.map((d, i) => `"${d.name}"→${perDept[i].length}`).join(", "),
          );
        }
      } catch (e) {
        console.warn(`[auto-analyze] department pick failed, falling back to full-catalog fuzzy search: ${(e as Error).message}`);
      }
    }

    // Last resort: full-catalog fuzzy search (still real retrieval, never a
    // blind slice) — only reached if department picking itself threw, or
    // every department subtree it tried came up empty.
    if (candidates.length === 0) {
      candidates = searchCategoriesByText(retrievalQuery, listableCategories, 8);
    }

    // Categories similar products already went live in, in this seller's
    // country (lib/jumia/live-listings.ts), go first, marked for the model
    // as accepted by Jumia. They're offered, not applied: a live listing
    // can itself be in the wrong category, so the model still judges fit.
    // Drawn from `listableCategories`, so never one Jumia has refused here.
    const proven = statedCandidates.length > 0 ? [] : await provenCategoriesFor(
      country,
      { title: description.title, keywords: description.keywords },
      listableCategories,
    );
    if (proven.length > 0) {
      const provenCodes = new Set(proven.map((p) => p.code));
      const rowByCode = new Map(listableCategories.map((c) => [Number(c.code), c]));
      candidates = [
        ...proven.map((p): CategoryCandidate => {
          const row = rowByCode.get(p.code)!;
          return {
            code:              p.code,
            name:              row.name,
            path:              row.path,
            attribute_set_sid: row.attribute_set_sid,
            retrievalScore:    p.score,
            source:            "live",
            liveExample:       p.exampleTitle,
          };
        }),
        ...candidates.filter((c) => !provenCodes.has(c.code)),
      ];
      frontCount = proven.length;
      console.info(
        `[auto-analyze] ${proven.length} live-listing categor${proven.length === 1 ? "y" : "ies"} for "${description.title}": ` +
          proven.map((p) => `${p.code} (${p.score.toFixed(2)}, like "${p.exampleTitle}")`).join(", "),
      );
    }

    // Jumia's nearest matches to a category the seller named that isn't
    // its exact name ("Portable Power Banks" for "Portable Power Banks &
    // Battery Packs") go first, marked for the model. Offered beside the
    // usual candidates, not instead of them: a close name can still be the
    // wrong shelf (lib/jumia/stated-category.ts).
    if (stated?.kind === "near") {
      const near = stated.options.flatMap((o): CategoryCandidate[] => {
        const row = listableCategories.find((c) => Number(c.code) === o.code);
        return row
          ? [{ code: Number(row.code), name: row.name, path: row.path, attribute_set_sid: row.attribute_set_sid, retrievalScore: 1, source: "seller", sellerNamed: true }]
          : [];
      });
      const nearCodes = new Set(near.map((c) => c.code));
      const frontKept = candidates.slice(0, frontCount).filter((c) => !nearCodes.has(c.code)).length;
      candidates = [...near, ...candidates.filter((c) => !nearCodes.has(c.code))];
      frontCount = near.length + frontKept;
    }

    // Enrich with is_leaf from the SAME listableCategories rows the pool
    // came from — none of the retrieval functions in category-search.ts
    // carry it themselves (see CategoryCandidate's own doc comment). This
    // is what lets the ranking prompts below prefer a leaf over a listable
    // parent when both are plausible, rather than treating "has its own
    // attribute set" as the whole story on whether Jumia will actually
    // accept a listing filed there directly.
    const listableByCode = new Map(listableCategories.map((c) => [c.code, c]));
    candidates = candidates.map((c) => ({ ...c, is_leaf: listableByCode.get(c.code)?.is_leaf ?? false }));

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
    // Categories close to the seller's named one and live-listing ones sit
    // in front and don't count against the retrieval top N, so the model
    // still sees retrieval's best three, no more than two of them siblings
    // (diverseTop).
    // The categories the seller named are the shortlist as they are.
    const topNCandidates   = statedCandidates.length > 0 ? candidates : [
      ...candidates.slice(0, frontCount),
      ...diverseTop(candidates.slice(frontCount), TOP_N_FOR_COMBINED),
    ];

    // Parallel schema fetch for top-N candidates. We need them all in hand
    // before the combined Gemini call so the model can pick + fill from
    // any of them. Fetch-from-Jumia fallback for uncached categories.
    const accessTokenForBatch = await getValidJumiaCredentials(userId)
      .then((c) => c.accessToken)
      .catch(() => null);

    candidatesWithSchemas = await Promise.all(
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
          code:    c.code,
          name:    c.name,
          path:    c.path,
          attrs,
          is_leaf: c.is_leaf ?? false,
          liveExample: c.liveExample,
          sellerNamed: c.sellerNamed,
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

    // ── 5b. Leaf preference, never a dead end — see ensureLeafCategory's own
    // doc comment for the real-batch failure this closes and why it can
    // never bail to "pick a category manually".
    ({ ranked, filled } = await ensureLeafCategory(
      ranked,
      filled,
      listableCategories,
      images,
      userContext,
      description.intended_use_case,
      description.environment,
      accessTokenForBatch,
    ));
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
  // "user" as well as "ai": a fact the seller stated outright in their
  // notes is a seller edit, written in chat rather than a form, and
  // marking it so stops a later re-run overwriting it (isUserEdited).
  const newSources:    Record<string, "ai" | "user">                                                                   = {};
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

  // Brand — every listing defaults to Generic (or Fashion, for a
  // fashion-labelled category) so the required field is never empty.
  // Pass A no longer even attempts to read a brand off a photographed
  // logo (see its prompt) — a photo-detected brand is exactly what
  // surfaces on Jumia's restricted/forbidden-brand lists and trademark
  // rejections most often, for a product the seller may not be an
  // authorised reseller of. Real brand names only ever reach `updates`
  // via the note-intent/note-assertion handling further down, which
  // reads what the SELLER actually wrote and unconditionally overrides
  // this default — that's a seller's own words, which outrank a guess
  // no matter how it was reached.
  if (canFill("brand") || !listing.brand) {
    if (!isUserEdited("brand")) {
      const brandValue = isFashionCategory(chosen.path) ? "Fashion" : "Generic";
      updates.brand = brandValue;
      newSources["brand"] = "ai";
      newConfidence["brand"] = {
        confidence: 0.5,
        source:     "inferred",
        reasoning:  `Defaulted to "${brandValue}" — no brand stated in your notes. Mention the real brand in your listing notes if you're authorised to sell it, or edit this field.`,
      };
    }
  }

  // Other top-level fields
  // Measure whether the buyer-focus rule is landing. A live listing once
  // read "the KAISHENG YOUPIN logo indicates a focus on quality hardware
  // tools" — copy describing the blister pack rather than the lock inside
  // it. Logged rather than stripped: these phrases sit mid-sentence, and
  // cutting them leaves mangled prose, which is a worse listing than the
  // one that needed fixing.
  const narration = [
    ...detectPhotoNarration(description.description),
    ...detectPhotoNarration(description.highlights),
  ];
  if (narration.length > 0) {
    console.warn(
      `[auto-analyze] listing=${listingId} copy reads as photo description, not product writing: ${narration.join("; ")}`,
    );
  }

  // Measure what the model actually produced against the floors the style
  // rules ask for. This is here because the floors were being missed by
  // roughly half and nothing said so: the prompt asked for 1500 characters
  // of prose in one place and "80-3000 characters" twenty lines later, and
  // the model followed the second. Prose length excludes markup and table
  // content, exactly as the rules define it, so a big spec table cannot
  // mask a two-paragraph description.
  const descProse = proseLength(description.description);
  const hlProse   = proseLength(description.highlights);
  if (descProse < CONTENT_LENGTH_FLOORS.description || hlProse < CONTENT_LENGTH_FLOORS.highlights) {
    console.warn(
      `[auto-analyze] listing=${listingId} copy under the style floor: ` +
      `description=${descProse}/${CONTENT_LENGTH_FLOORS.description} ` +
      `highlights=${hlProse}/${CONTENT_LENGTH_FLOORS.highlights}`,
    );
  }

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

  // What the seller actually SAID wins over what the model inferred from
  // a photo.
  //
  // Price, stock and sale price already work this way — read from the
  // notes by regex and applied directly, because they are seller-owned
  // and this pipeline refuses to let an AI guess them. Everything else
  // the seller wrote ("comes in red, blue and green", "brand: Kaisheng")
  // was handed to the model as free-text context and then never checked.
  // If the seller wrote pink and the draft said red, nothing noticed —
  // not at draft time, not at push time, not ever. Prompting is a
  // request; this is the verification.
  //
  // Only explicit, marked statements are extracted (see
  // lib/whatsapp/note-assertions.ts), and a correction is applied only
  // where the draft actually contradicts one — a more specific value
  // ("Stainless Steel" for "steel") is left alone rather than replaced
  // with the seller's shorter word.
  // ── The seller's note, read by intent rather than by pattern ───────────
  //
  // The regex layer covers the phrasings someone thought of. Two live
  // notes minutes apart expressed nine intentions and it caught two:
  // "It costs 300Ghs" is not "price is", and a note with no full stops
  // let a colour capture run to the end of the message. A pattern per
  // phrasing does not converge.
  //
  // Safe because verifyNoteIntent makes inventing impossible — every
  // value carries a verbatim span of the note and that span has to be in
  // it. The model gets latitude over phrasing and none over facts. See
  // lib/whatsapp/note-intent.ts.
  //
  // Fills GAPS only. Anything the deterministic pass already set is left
  // exactly as it was: a labelled regex match is the strongest evidence
  // there is, and this must be able to add without ever regressing.
  let intent: NoteIntent = {};
  if (userContext && userContext.trim()) {
    const tIntent = Date.now();
    const verified = verifyNoteIntent(await aiReadNoteIntent(userContext), userContext);
    intent = verified.intent;
    const got = Object.keys(intent);
    if (got.length > 0 || verified.rejected.length > 0) {
      console.info(
        `[auto-analyze] listing=${listingId} note-intent ms=${Date.now() - tIntent} ` +
        `read=${got.join(",") || "none"}` +
        (verified.rejected.length > 0
          ? ` rejected=${verified.rejected.map((r) => `${r.field}(${r.reason})`).join("; ")}`
          : ""),
      );
    }
  }

  const assertions = extractNoteAssertions(userContext);
  if (assertions.length > 0) {
    const checks = checkAssertions(assertions, {
      brand:         (updates.brand as string | undefined) ?? description.brand ?? null,
      color:         (updates.color as string | undefined) ?? description.color ?? null,
      main_material: (updates.main_material as string | undefined) ?? description.main_material ?? null,
      model:         (updates.model as string | undefined) ?? description.model ?? null,
    });

    for (const [field, value] of Object.entries(correctionsFrom(checks))) {
      // Bypasses setField's canFill guard on purpose: this is the
      // seller's own instruction, which outranks both an AI value and the
      // "don't overwrite" rule that exists to protect seller edits — it
      // IS a seller edit, just written in chat instead of a form.
      updates[field] = value;
      newSources[field] = "user";
      newConfidence[field] = { confidence: 1, source: "seller-required" };
    }

    const broken = checks.filter((c) => !c.honoured);
    if (broken.length > 0) {
      console.info(
        `[auto-analyze] listing=${listingId} applied seller's own words over the draft: ` +
          broken.map((c) => `${c.assertion.field} "${c.actual ?? "(empty)"}" → "${c.assertion.value}" (from ${JSON.stringify(c.assertion.source)})`).join("; "),
      );
    }
  }
  // Apply the note intent. Gap-filling only — `??` throughout, so a value
  // the deterministic pass already wrote is never touched.
  //
  // Everything here landed with source "user": the seller stated it in
  // writing, which outranks an AI reading of a photo and is protected
  // from a later re-run by the existing isUserEdited guard. That is the
  // same rule the note-assertion corrections below follow — it IS a
  // seller edit, written in chat instead of a form.
  if (Object.keys(intent).length > 0) {
    const fromNote = (field: string, value: unknown) => {
      if (value == null || value === "") return;
      updates[field] = value;
      newSources[field] = "user";
      newConfidence[field] = { confidence: 1, source: "seller-required" };
    };

    // Price and stock stay seller-owned, exactly as before. The
    // difference is only HOW the seller's own figure is read, never
    // whether one may be inferred when they didn't give it.
    if (listing.selling_price == null && updates.selling_price == null) {
      fromNote("selling_price", intent.selling_price?.value);
    }
    if (listing.sale_price == null && updates.sale_price == null) {
      fromNote("sale_price", intent.sale_price?.value);
      fromNote("sale_start_date", intent.sale_start_date?.value);
      fromNote("sale_end_date", intent.sale_end_date?.value);
    }
    if (intent.quantity && listing.quantity == null) {
      fromNote("quantity", intent.quantity.value);
    }

    for (const field of ["brand", "color", "main_material", "model"] as const) {
      const v = intent[field]?.value;
      if (v && !isUserEdited(field)) fromNote(field, v);
    }
    if (intent.warranty?.value) fromNote("warranty_text", intent.warranty.value);

    // "What is in the box" has no column — it is a category attribute,
    // and only some categories declare it. Written under the canonical
    // key the SchemaForm already groups its aliases under, so it lands in
    // the right field wherever the category does declare one.
    if (intent.whats_in_the_box?.value) {
      // Write it under the name THIS category declares, not the canonical
      // one. Jumia spells the field differently per category
      // ("package_content" on 1000254), and the pre-flight drops anything
      // the category doesn't declare — so writing the canonical key threw
      // the seller's own box contents away and left the AI's guess, which
      // happened to use the real name, to be pushed instead. Confirmed
      // live: the seller wrote 'WHAT IS IN THE BOX IS "1x Gas Stove"' and
      // Jumia received a three-line list they never typed.
      const target = attrs.find((a) => canonicalKey(a.name) === "whats_in_the_box")?.name;
      if (target) {
        filled.dynamic_attributes[target] = intent.whats_in_the_box.value;
        newSources[target] = "user";
        newConfidence[target] = { confidence: 1, source: "seller-required" };
      } else {
        // No such field in this category. Saying so beats writing a key
        // that will be silently discarded downstream.
        console.info(
          `[auto-analyze] listing=${listingId} seller gave box contents but category ${chosen.code} has no such field`,
        );
      }
    }
  }

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
  // The AI picked the category this time (the seller's is no longer
  // listable), so it isn't the seller's any more.
  if (!kept) delete mergedSources.category_code;
  // One the seller named in their notes is theirs, as if they'd picked it.
  if (kept && stated?.kind === "match") mergedSources.category_code = "user";
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

  // ── Mirror column-mapped attributes into their empty columns ───────────
  //
  // Pass A and the category fill can disagree, and the seller only ever
  // sees one of them. Pass A is told to return null for a weight it can't
  // confidently infer; the category fill sees product_weight declared
  // REQUIRED and fills it anyway. So the weight_kg COLUMN stayed empty
  // while dynamic_attributes carried a number.
  //
  // Nothing noticed until the required-attribute fallback started sending
  // the dynamic copy to Jumia rather than losing the feed over a missing
  // column. Correct on its own, but it made the disagreement invisible in
  // the worst way: confirmed live, four listings showed a blank Weight
  // field in the editor while Jumia was sent 0.5, 0.2 and 50 kg. A value
  // the seller cannot see is one they cannot correct, and an
  // under-declared weight is shipping cost they pay.
  //
  // Writing it to the column is the fix rather than teaching the editor
  // to read the fallback too: the column is the canonical store for a
  // column-mapped attribute, so what the seller sees, what they edit, and
  // what is pushed all become the same value.
  const BACKFILLABLE_COLUMNS = new Set([
    "weight_kg", "size_l", "size_w", "size_h",
    "color", "color_family", "main_material", "material_family",
    "model", "product_line", "production_country",
    "warranty_duration", "warranty_type", "warranty_text", "warranty_address",
  ]);
  const NUMERIC_COLUMNS = new Set(["weight_kg", "size_l", "size_w", "size_h"]);
  // Deliberately absent: selling_price (seller-owned everywhere in this
  // codebase and never AI-filled), brand (asserting one the seller did
  // not confirm is a legal/commercial risk, and setField already gates
  // it), and certifications (an array column — a comma-joined string
  // would land as one nonsense element).

  for (const [attrName, rawValue] of Object.entries(filled.dynamic_attributes)) {
    const col = columnFor(attrName);
    if (!col || !BACKFILLABLE_COLUMNS.has(col)) continue;
    const value = String(rawValue ?? "").trim();
    if (!value) continue;

    // Only ever fills a hole. An existing column value — whether the
    // seller's or an earlier pass's — outranks the attribute copy, which
    // is the same precedence the push path applies.
    const pending  = updates[col];
    const existing = (listing as Record<string, unknown>)[col];
    const alreadySet = (pending ?? existing) != null && String(pending ?? existing).trim() !== "";
    if (alreadySet) continue;
    if (isUserEdited(col)) continue;

    if (NUMERIC_COLUMNS.has(col)) {
      const n = parseFloat(value.replace(/[^\d.]/g, ""));
      if (!Number.isFinite(n) || n <= 0) continue;
      updates[col] = n;
    } else {
      updates[col] = value;
    }
    newSources[col] = "ai";
    newConfidence[col] = {
      confidence: 0.7,
      source:     "inferred",
      reasoning:  `Filled from the category attribute "${attrName}", which the schema requires.`,
    };
    console.info(`[auto-analyze] listing=${listingId} mirrored ${attrName} -> ${col}=${updates[col]}`);
  }

  const finalDynamicAttrs: Record<string, string> = { ...filled.dynamic_attributes };

  // Product-aware defaults: prefer a product-specific value over the generic
  // canned default. For "what_is_in_the_box" we write a clean multi-line
  // "1x Item" list (Jumia's preferred format), substituting the listing
  // title for the main product so it reads:
  //     1x Volcano Humidifier
  // — just the product itself, not a manual/packaging guess (see
  // AI_DYNAMIC_ATTR_DEFAULTS's doc comment in lib/ai/policy.ts) — a seller
  // who wants real extras listed can say so in their own notes, which
  // always wins over this fallback (see the mergedSources check below).
  function getProductAwareDefault(intent: string, fallback: string): string {
    const title = (updates.title as string | undefined) ?? (listing?.title ?? "") as string;
    if (intent === "what_is_in_the_box" && title && title.length > 0) {
      // Take the first 6 words from the title for a tidy product name.
      const productName = title.split(/\s+/).slice(0, 6).join(" ");
      return `1x ${productName}`;
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

  const numericAttrFields = new Map(
    attrs
      .filter((a) => a.type === "number")
      .filter((a) => !SKIP_NUMERIC_SCRUB.has(a.name.toLowerCase()) && !TEXTY_NAME_RE.test(a.name))
      .map((a) => [a.name.toLowerCase(), a] as const),
  );
  const dropNumericAttr = (key: string) => {
    delete finalDynamicAttrs[key];
    // Also clear any field_sources / field_confidence tracking for it.
    if (mergedSources[key] !== "user") delete mergedSources[key];
    delete mergedConfidence[key];
  };
  for (const key of Object.keys(finalDynamicAttrs)) {
    const field = numericAttrFields.get(key.toLowerCase());
    if (!field) continue;
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
    const n = match ? parseFloat(match[0]) : NaN;
    if (!Number.isFinite(n)) {
      // Couldn't extract a real number ("true", "yes", "unknown") — drop
      // it. Leaving the field empty is better than failing Jumia QC.
      console.warn(
        `[auto-analyze] dropping non-numeric value for numeric attr '${key}': '${raw.slice(0, 40)}'`,
      );
      dropNumericAttr(key);
      continue;
    }

    // A clean number can STILL be one this category rejects — the exact
    // decimalPlaces / notZeroOrNegative rules preflightAttributes enforces
    // at push time, run here so the same "1.7 into a whole-number-only
    // capacity_liter" mistake is caught the moment the category is known
    // rather than after a push attempt. Real, repeated rejection this
    // closes: "Attribute [capacity_liter] with the value [1.7] should be
    // a number without decimals" — previously the numeric scrub above
    // accepted "1.7" as a perfectly clean number and moved on.
    const checked = checkNumericConstraint(String(n), field);
    if (checked.value === null) {
      console.info(
        `[auto-analyze] listing=${listingId} cleared ${key}="${n}" — ${checked.note?.detail}`,
      );
      dropNumericAttr(key);
      continue;
    }
    finalDynamicAttrs[key] = checked.value; // canonical numeric string, possibly rounded
    if (checked.value !== String(n)) {
      console.info(`[auto-analyze] listing=${listingId} rounded ${key}: "${n}" -> "${checked.value}"`);
    }
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

  // ── Drop AI enum values this category will never accept ─────────────────
  //
  // Observed live on 2026-09-15, twice in one batch:
  //
  //   [Jumia preflight] material_family: "Fabric" isn't a value this
  //   category accepts
  //   [Jumia preflight] age_group: "25-64 Years" isn't a value this
  //   category accepts
  //
  // Both were stored on the listing, shown to the seller as filled, and
  // then silently dropped at push time with a warning they had to read
  // past. A value the category cannot accept is worse than an empty
  // field, because an empty REQUIRED field is surfaced by
  // describeMissingFields and the seller gets asked for it — whereas a
  // wrong one looks done until Jumia disagrees.
  //
  // aiFillGaps already validates its own output this way; the earlier
  // passes (A and combined B+C) never did, which is where these came from.
  // Same snapping rules as the push path, reusing snapToAllowedWithSynonyms
  // so the two cannot drift: casing, singular/plural, and a British/
  // American spelling pair ("Grey" -> "Gray") are repaired, genuine
  // mismatches are dropped, and anything ambiguous is dropped rather than
  // guessed.
  //
  // Seller-typed values are left exactly as written. If someone insists on
  // a value Jumia rejects, that is their call to see through to the push,
  // where preflight names it — quietly rewriting what a human typed is a
  // different and worse failure.
  for (const [attrName, rawValue] of Object.entries(finalDynamicAttrs)) {
    if (isUserEdited(attrName)) continue;
    const field = attrs.find((a) => a.name.toLowerCase() === attrName.toLowerCase());
    if (!field || field.allowed_values.length === 0) continue;

    const value = String(rawValue ?? "").trim();
    if (!value) continue;

    const parts = field.type === "multi"
      ? value.split(",").map((v) => v.trim()).filter(Boolean)
      : [value];
    const kept = parts
      .map((part) => snapToAllowedWithSynonyms(part, field.allowed_values))
      .filter((v): v is string => v !== null);

    if (kept.length === 0) {
      delete finalDynamicAttrs[attrName];
      console.info(
        `[auto-analyze] listing=${listingId} dropped ${attrName}="${value}" — ` +
        `not a value this category accepts`,
      );
      continue;
    }
    const snapped = kept.join(",");
    if (snapped !== value) {
      finalDynamicAttrs[attrName] = snapped;
      console.info(`[auto-analyze] listing=${listingId} snapped ${attrName}: "${value}" -> "${snapped}"`);
    }
  }

  // ── The same guard, on the COLUMNS ──────────────────────────────────────
  //
  // The loop above cleans dynamic_attributes. That is not where the bad
  // value lives for a column-mapped attribute, and this is the miss that
  // let "Fabric" reach Jumia again the day after the dynamic-attribute
  // guard shipped:
  //
  //   material_family (column)             = "Fabric"     ← sent
  //   dynamic_attributes.material_family    = null
  //
  // Pass A writes these columns directly via setField (see
  // description.material_family above), never through dynamic_attributes,
  // and buildAttributes reads the COLUMN for anything column-mapped. So a
  // value cleaned out of the attribute copy still goes out from the column,
  // and preflight drops it at push with a warning the seller has to read
  // past — exactly what it did on 2026-09-15 at 13:16.
  //
  // Clearing rather than keeping, for the reason given above: an empty
  // required field is surfaced by describeMissingFields and the seller is
  // asked for it, while a wrong one looks finished until Jumia disagrees.
  for (const field of attrs) {
    if (field.allowed_values.length === 0) continue;
    const col = columnFor(field.name);
    if (!col || isUserEdited(col)) continue;

    const pending  = updates[col];
    const existing = (listing as Record<string, unknown>)[col];
    const raw = String((pending ?? existing) ?? "").trim();
    if (!raw) continue;

    const parts = field.type === "multi"
      ? raw.split(",").map((v) => v.trim()).filter(Boolean)
      : [raw];
    const kept = parts
      .map((part) => snapToAllowedWithSynonyms(part, field.allowed_values))
      .filter((v): v is string => v !== null);

    if (kept.length === 0) {
      updates[col] = null;
      console.info(
        `[auto-analyze] listing=${listingId} cleared ${col}="${raw}" — ` +
        `not a value category ${chosen.code} accepts`,
      );
      continue;
    }
    const snapped = kept.join(",");
    if (snapped !== raw) {
      updates[col] = snapped;
      console.info(`[auto-analyze] listing=${listingId} snapped ${col}: "${raw}" -> "${snapped}"`);
    }
  }

  await db.from("listings").update({
    ...updates,
    category_code:       String(chosen.code),
    category_path:       chosen.path,
    dynamic_attributes:  finalDynamicAttrs,
    field_sources:       mergedSources,
    field_confidence:    mergedConfidence,
    // A kept seller category has no alternates of its own; the last AI
    // pick's are still the best suggestions if Jumia ever refuses it.
    category_alternates: kept ? (listing.category_alternates ?? alternatesForUI) : alternatesForUI,
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
  // What the seller said about which options they actually stock beats
  // what the photo shows — see lib/whatsapp/variant-claims.ts. The prompt
  // already said so; a live note ("Only black is red is available") got
  // all five photographed colours anyway, leaving a seller committed to
  // four they don't have.
  //
  // Too few variants is the seller adding one back in the editor. Too
  // many is stock they must honour or cancel, on a marketplace that
  // penalises cancellations. So an unresolvable claim keeps NOTHING.
  const variantClaim = extractVariantClaim(userContext);
  const reconciled = reconcileVariants(
    variantClaim,
    description.variations.map((v) => v.label),
  );
  let variations = description.variations;
  if (reconciled.kind === "restrict") {
    variations = description.variations.filter((v) => reconciled.keep.includes(v.label));
    if (variations.length !== description.variations.length) {
      console.info(
        `[auto-analyze] listing=${listingId} seller named the stocked options ("${reconciled.source}") — ` +
        `kept ${variations.length} of ${description.variations.length}`,
      );
    }
  } else if (reconciled.kind === "unresolved") {
    variations = [];
    console.warn(
      `[auto-analyze] listing=${listingId} variant claim unresolved ("${reconciled.source}"): ` +
      `${reconciled.reason} — dropped all ${description.variations.length} proposed options`,
    );
  }

  // One variant unless the seller's notes name options (owner's request,
  // 2026-10-03). The Describe prompt says so too, and was not always
  // followed: a single product drafted as two variants, the second with no
  // label, and its submit stopped on "Variant 2 has no Variation label".
  variations = variations.filter((v) => v.label.trim());
  if (variations.length > 1 && !notesNameVariants(userContext)) {
    console.info(
      `[auto-analyze] listing=${listingId} kept 1 of ${variations.length} variants — the seller's notes name no options`,
    );
    variations = variations.slice(0, 1);
  }

  if (variations.length > 0) {
    try {
      const baseSku    = (listing.sku as string | undefined) ?? listingId.slice(0, 8).toUpperCase();
      const basePrice  = (listing.selling_price as number | undefined) ?? null;
      const baseStock  = (listing.quantity as number | undefined) ?? 1;
      // The Describe pass invents these labels before the category (and
      // its variant-axis schema) is even resolved — see
      // reconcileDraftVariation's doc comment. Reconciling here, now that
      // `chosen`/`attrs` are known, catches a category whose axis is a
      // closed list (screen sizes, shoe lengths) before the seller ever
      // sees a value Jumia would reject outright.
      const variantAxes         = attrs.filter((a) => a.is_variant);
      const allowedVariantValues = variantAxes.flatMap((a) => a.allowed_values ?? []);
      const rows = await Promise.all(variations.map(async (v) => {
        let variation = reconcileDraftVariation(v.label, variantAxes);

        // reconcileDraftVariation only ever falls back to "..." when the
        // axis DOES restrict to a closed list and the seller's label
        // didn't match it even after casing/plural/spelling-pair
        // snapping — i.e. the seller said SOMETHING, the category has a
        // fixed vocabulary, and neither literally lines up. That is
        // exactly the case a live listing hit: a Backpacks & Carriers
        // note named a size the category's own axis genuinely stocked,
        // just not spelled the seller's way, and it drafted as the
        // meaningless "..." placeholder instead of the size meant.
        // aiMatchAllowedValue asks a model to match BY MEANING against
        // the category's own exact, closed list — see its doc comment
        // for why an answer here can only ever be one of that list, or
        // nothing at all.
        if (variation === "..." && allowedVariantValues.length > 0 && v.label.trim() !== "...") {
          const matched = await aiMatchAllowedValue(v.label, allowedVariantValues, userContext);
          if (matched) {
            console.info(
              `[auto-analyze] listing=${listingId} matched variant label "${v.label}" → "${matched}" ` +
              `against category ${chosen.code}'s own options`,
            );
            variation = matched;
          }
        }

        return {
          listing_id:      listingId,
          variation,
          seller_sku:      `${baseSku}-${v.sku_suffix}`,
          gtin:            null,
          quantity:        baseStock,
          global_price:    basePrice,
          sale_price:      null,
          sale_start_date: null,
          sale_end_date:   null,
        };
      }));

      const finalRows = collapseDuplicateEllipsisVariants(rows);
      if (finalRows.length !== rows.length) {
        console.info(
          `[auto-analyze] listing=${listingId} collapsed ${rows.length - finalRows.length + 1} "..." variants down to 1 — ` +
          `none of them named an option on this category's own variant axis`,
        );
      }

      // Clear-then-insert. RLS still enforces ownership via the listings
      // ownership check above.
      await db.from("variants").delete().eq("listing_id", listingId);
      await db.from("variants").insert(finalRows);
    } catch (e) {
      console.warn(`[auto-analyze] variant persist failed: ${(e as Error).message}`);
    }
  } else if (reconciled.kind === "unresolved") {
    // Clear whatever a previous run left. Without this a re-analyze that
    // NOW recognises the claim would leave the old photo-derived variants
    // sitting there — the exact rows this is meant to withdraw.
    try {
      await db.from("variants").delete().eq("listing_id", listingId);
    } catch (e) {
      console.warn(`[auto-analyze] variant clear failed: ${(e as Error).message}`);
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
      `path=${kept ? "seller-category" : timings.combined_bc_ms != null ? "combined" : "fallback"}`,
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
    variations_detected:   variations.length,
    title:                 (updates.title as string | undefined) ?? listing.title,
    brand:                 (updates.brand as string | undefined) ?? listing.brand,
  };
}
