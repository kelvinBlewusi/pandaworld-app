/**
 * Fuzzy text search over the Jumia category cache.
 *
 * Used by the auto-analyze pipeline to narrow Jumia's ~27k listable
 * categories down to ~6 strong candidates that the vision model can
 * rank reliably. Pure local computation — no network call, no AI
 * tokens burned.
 *
 * Pool: callers pass the result of getListableCategories() — every row
 * with a non-null attribute_set_sid, leaves AND listable parents (e.g.
 * "Watches" can be selected directly even though "Watches > Smart
 * Watches" also exists). The caller's filter is the source of truth;
 * we don't re-filter by is_leaf here. (We used to, which silently
 * returned zero candidates when the sync's finalize-pass hadn't run
 * yet and every row still had is_leaf=false — that produced the
 * "No candidate categories found" error in the analyze panel.)
 *
 * Scoring strategy (Fuse.js with weighted keys):
 *   - category name        weight 0.55  ← strongest signal ("Headphones")
 *   - last path segment    weight 0.20  ← also "Headphones" if path ends there
 *   - full path            weight 0.15  ← catches "Audio > Headphones"
 *   - attribute set name   weight 0.10  ← weak but useful for disambiguation
 *
 * Threshold is tuned generous (0.5) — we'd rather return a few false
 * positives that the AI ranks out than miss the right category entirely.
 *
 * The query is searched TERM BY TERM, not as one string, and the per-term
 * relevances are averaged over the whole query (see searchCategoriesByText).
 * That is not a refinement — it's load-bearing. Fuse's bitap matcher caps a
 * pattern at 32 characters and silently splits anything longer into
 * arbitrary 32-char chunks (MAX_BITS in fuse.cjs), mid-word, each of which
 * then has to match. The caller's query is title + keywords + use case +
 * environment, so it is essentially always past that cap, and searching it
 * whole collapsed retrieval to noise or nothing at all. Measured against
 * the real catalog, for a canvas wall-art print:
 *   "canvas art"            (10 chars) → Pre-Stretched Canvas 0.41, Boards & Canvas 0.35, Wall Art 0.33
 *   "canvas art wall decor" (21 chars) → NO HITS AT ALL
 *   the real 80-char query             → NO HITS, then noise from the
 *                                        full-catalog retry, which is how a
 *                                        canvas print reached the vision
 *                                        model as "Icing & Decorating
 *                                        Spatulas" and got pushed at 0.95
 *                                        confidence.
 * Keeping every pattern short is therefore the whole point; don't
 * "simplify" this back into a single fuse.search(query).
 */

import Fuse from "fuse.js";
import type { JumiaCategoryRow } from "@/lib/jumia/categories";
import { createServerClient } from "@/lib/supabase/server";
import { embedText, toPgvectorLiteral } from "@/lib/ai/embeddings";

export interface CategoryCandidate {
  code:               number;
  name:               string;
  path:               string;
  attribute_set_sid:  string | null;
  /** 0–1 retrieval relevance — NOT vision confidence */
  retrievalScore:     number;
  /** Where this candidate came from — useful for debugging the pipeline */
  source:             "fuzzy" | "jumia" | "merged" | "embedding";
}

interface IndexedRow extends JumiaCategoryRow {
  /** Last segment of the breadcrumb, e.g. "Headphones" */
  lastSegment: string;
  /** Everything Fuse searches, lowercased — used only by the cheap
   *  substring prefilter in searchCategoriesByText. */
  haystack: string;
}

function prepareIndex(rows: JumiaCategoryRow[]): IndexedRow[] {
  return rows.map((r) => {
    const lastSegment = r.path.split(/\s*[>/]\s*/).filter(Boolean).pop() ?? r.name;
    return {
      ...r,
      lastSegment,
      haystack: `${r.name} ${lastSegment} ${r.path} ${r.attribute_set_name ?? ""}`.toLowerCase(),
    };
  });
}

/** Words that match half the catalog and only dilute the per-term average
 *  below. Deliberately short — anything product-meaningful ("home",
 *  "kitchen", "office") stays, because those genuinely narrow a category. */
const QUERY_STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "your", "our", "its",
  "new", "set", "pack", "item", "product", "quality", "unknown",
]);

/** Cap on terms per query — bounds the per-term searches below. Pass A
 *  emits a title plus up to 10 keywords, so this comfortably covers a real
 *  query while keeping the worst case bounded. */
const MAX_QUERY_TERMS = 12;

/** How many rows each single-term search may contribute. Generous: a term
 *  matching the right category weakly still needs to reach the accumulator,
 *  and the hit count doubles as the term's document frequency for the IDF
 *  weighting below — too small a cap would flatten common and rare terms
 *  into looking equally selective. */
const PER_TERM_LIMIT = 60;

/** How much of a term the substring prefilter matches on. Short enough to
 *  survive plurals and endings ("painting" → "pain", "spatulas" → "spat"),
 *  long enough to still exclude most of the catalog. */
const TERM_PREFIX_LENGTH = 4;

/** Splits a retrieval query into de-duplicated, searchable terms. Every
 *  term is a single word, so no pattern can reach Fuse's 32-char cap. */
function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of query.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || QUERY_STOPWORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= MAX_QUERY_TERMS) break;
  }
  return out;
}

/**
 * Fuzzy search the leaf list for the strongest matches against a free-text
 * query (typically an AI-generated product title plus keywords).
 *
 * Each term is searched separately and a category's score is the weighted
 * mean of its per-term relevances across the WHOLE query — terms it doesn't
 * match count as zero. So a category matching several of the query's words
 * ("canvas", "art", "painting") outranks one matching a single incidental
 * word ("decorating" → "Icing & Decorating Spatulas"), which searching the
 * query as one string got exactly backwards.
 *
 * Terms are IDF-weighted, which is what makes that hold in practice: a real
 * query carries a handful of discriminating words ("canvas") among a lot of
 * filler that matches half the department ("home", "decor", "supplies",
 * "kits"). Weighting every term equally just lets the filler outvote the
 * signal — measured on the real catalog, an unweighted mean put "Party
 * Decorations & Supplies" and "Fabric Decorating Kits" above
 * "Pre-Stretched Canvas" for a canvas art print.
 *
 * Returns top-N candidates with relevance scores in [0, 1].
 */
export function searchCategoriesByText(
  query: string,
  categories: JumiaCategoryRow[],
  limit: number = 6
): CategoryCandidate[] {
  if (!query.trim() || categories.length === 0) return [];

  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  const indexed = prepareIndex(categories);

  // Searching every term against every row is what costs: Fuse's bitap
  // matcher is char-level, so one term over the full 27k-row catalog runs
  // ~470ms, and a 12-term query ~5s of blocked event loop. Almost all of
  // that is spent proving that rows sharing nothing with the query don't
  // match. A substring prefilter on a short prefix of each term drops
  // those for free, leaving Fuse to do the graded scoring it's actually
  // needed for. The prefix (not the whole term) keeps plurals and small
  // variants — "spatular" still reaches "Spatulas" via "spat".
  const prefixes = terms.map((t) => t.slice(0, TERM_PREFIX_LENGTH));
  const pool = indexed.filter((r) => prefixes.some((p) => r.haystack.includes(p)));
  if (pool.length === 0) return [];

  const fuse = new Fuse(pool, {
    includeScore: true,
    threshold:    0.5,
    ignoreLocation: true,
    keys: [
      { name: "name",                weight: 0.55 },
      { name: "lastSegment",         weight: 0.20 },
      { name: "path",                weight: 0.15 },
      { name: "attribute_set_name",  weight: 0.10 },
    ],
  });

  // Fuse already returns one result per item (combined across keys), so each
  // term contributes at most once per category. A term's hit count is also
  // its document frequency — the more of the pool it matches, the less it
  // says about any one category.
  const perTerm = terms.map((term) => fuse.search(term, { limit: PER_TERM_LIMIT }));
  const weights = perTerm.map((hits) => Math.log(1 + categories.length / (1 + hits.length)));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  if (totalWeight === 0) return [];

  // code → running total of IDF-weighted per-term relevance.
  const totals = new Map<number, { row: IndexedRow; total: number }>();
  perTerm.forEach((hits, i) => {
    for (const h of hits) {
      // Fuse score: 0 = perfect, 1 = no match. Flip to a relevance.
      const weighted = (1 - (h.score ?? 0)) * weights[i];
      const entry = totals.get(h.item.code);
      if (entry) entry.total += weighted;
      else totals.set(h.item.code, { row: h.item, total: weighted });
    }
  });

  return Array.from(totals.values())
    .map(({ row, total }) => ({
      code:               row.code,
      name:               row.name,
      path:               row.path,
      attribute_set_sid:  row.attribute_set_sid,
      retrievalScore:     total / totalWeight,
      source:             "fuzzy" as const,
    }))
    .sort((a, b) => b.retrievalScore - a.retrievalScore)
    .slice(0, limit);
}

/**
 * Embedding-based semantic search over jumia_categories. Requires
 * the pgvector migration (supabase/migrations/2026-05-26_category-embeddings.sql)
 * AND for the embeddings to have been backfilled (POST
 * /api/admin/embed-categories).
 *
 * Flow:
 *   1. Embed the query text via Google text-embedding-004 (768 dim).
 *   2. Cosine-similarity query against jumia_categories.embedding
 *      using pgvector's <=> operator (smallest distance = nearest).
 *   3. Return the top-N as candidates, scored 0–1 (1 = perfect).
 *
 * Falls back to an empty array on any error (caller handles). This is
 * intentional — the auto-analyze pipeline composes embedding + fuzzy
 * + Jumia results, so an embedding failure should degrade gracefully,
 * not break listing creation.
 *
 * Cost: ~$0.0001 per call (the embedding) + ~5ms Supabase query time.
 * Negligible compared to a Pass A/B vision call.
 */
// The department-first auto-analyze pipeline (lib/actions/auto-analyze.ts)
// deliberately dropped every embedding call from its hot path — AI
// Studio's gemini-embedding-001 had 30-40s cold-start outliers that
// stacked toward the route's ANALYSIS_DEADLINE_MS. Re-adding embedding
// search as an optional quality boost on top of department-scoped fuzzy
// search (see AGENTS.md's "retrieval upgrade" note) can't reopen that
// risk, so this whole function races against a short local timeout —
// short enough that even a cold AI Studio start can never meaningfully
// eat into the caller's deadline. Vertex's text-embedding-005 (<1s,
// provisioned-warm) comfortably beats this; AI Studio's fallback chain
// mostly won't, and that's fine — a timeout degrades back to fuzzy-only
// results. It degrades LOUDLY, though: see the logging below.
const EMBEDDING_SEARCH_TIMEOUT_MS = 4_000;

/** Distinguishes "the race hit the timeout" from "the search ran and found
 *  nothing". Both used to return [], which is why a semantic layer that
 *  timed out on every single call was indistinguishable from a working one
 *  with no matches — and nothing anywhere said which was happening. */
const TIMED_OUT = Symbol("embedding-search-timeout");

export async function searchCategoriesByEmbedding(
  query: string,
  limit: number = 8,
  deptPath?: string,
): Promise<CategoryCandidate[]> {
  if (!query.trim()) return [];

  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), EMBEDDING_SEARCH_TIMEOUT_MS);
  });

  let result: CategoryCandidate[] | typeof TIMED_OUT;
  try {
    result = await Promise.race([
      searchCategoriesByEmbeddingUnbounded(query, limit, deptPath),
      timeout,
    ]);
  } finally {
    // Without this the losing timer keeps the event loop referenced for the
    // rest of its 4s, on every call.
    clearTimeout(timer);
  }

  const elapsed = Date.now() - started;

  if (result === TIMED_OUT) {
    console.warn(
      `[category-search] embedding search TIMED OUT after ${EMBEDDING_SEARCH_TIMEOUT_MS}ms — ` +
        `this query got fuzzy-only candidates. Seeing this on most analyses means the semantic ` +
        `layer is effectively switched off, and which fix applies depends on the backend: on AI ` +
        `Studio, gemini-embedding-001 runs 30-40s cold, so configure Vertex (GCP_PROJECT_ID + ` +
        `GOOGLE_APPLICATION_CREDENTIALS_JSON). On Vertex, text-embedding-005 itself answers in ` +
        `<1s, so a timeout points at the first call in a cold process paying for the OAuth ` +
        `token handshake (see getVertexAccessToken in lib/ai/embeddings.ts) rather than at the ` +
        `model — worth raising this budget rather than chasing the model.`,
    );
    return [];
  }

  // Logged on success too, including the zero-result case: the margin
  // against the timeout is the thing worth watching (3.8s means the next
  // slightly-slower call silently loses the semantic layer).
  console.info(
    `[category-search] embedding search ok in ${elapsed}ms → ${result.length} candidate(s)` +
      (deptPath ? ` scoped to "${deptPath}"` : " (unscoped)"),
  );
  return result;
}

async function searchCategoriesByEmbeddingUnbounded(
  query: string,
  limit: number,
  deptPath?: string,
): Promise<CategoryCandidate[]> {
  try {
    // 1. Embed the query
    const { vector } = await embedText(query);
    const literal = toPgvectorLiteral(vector);
    return await matchByVector(literal, limit, deptPath);
  } catch (e) {
    console.warn(
      `[category-search] searchCategoriesByEmbedding failed: ${(e as Error).message}. Falling back to fuzzy search only.`,
    );
    return [];
  }
}

/**
 * The pgvector half of the search, taking an already-embedded query.
 *
 * Separate from the embedding step so a multi-department search pays for
 * ONE embedding and runs N scoped matches against it, rather than
 * embedding the identical text once per department. That is not just
 * tidiness: embeddings share the project quota that the category
 * re-embed pushed into 1,269 HTTP 429s, so tripling the calls per
 * analysis to search three departments would be a real cost.
 */
async function matchByVector(
  literal: string,
  limit: number,
  deptPath?: string,
): Promise<CategoryCandidate[]> {
  try {
    // Cosine-similarity query.
    //
    // The <=> operator is pgvector's cosine DISTANCE (0=identical,
    // 1=orthogonal, 2=opposite). Convert to similarity by `1 - dist`
    // and clamp to [0, 1] so the score plays nicely with the
    // fuzzy-search scoring (which is also a [0, 1] relevance).
    //
    // WHERE embedding IS NOT NULL skips unembedded rows so the
    // ivfflat index can be used.
    //
    // attribute_set_sid IS NOT NULL ensures we only return listable
    // categories (matches the rest of the pipeline). deptPath, when
    // given, scopes the match to that department's subtree (see
    // supabase/migrations/2026-09-13_category-embedding-department-
    // scope.sql) — same scope the department-first pipeline's fuzzy
    // search already uses, so a semantic hit can never smuggle in a
    // wrong-department candidate the redesign was built to rule out.
    const db = createServerClient();
    const { data, error } = await db.rpc("search_categories_by_embedding", {
      query_embedding: literal,
      match_limit:     limit,
      dept_path:       deptPath ?? null,
    });

    if (error) {
      // RPC may not exist yet on databases that haven't run the
      // migration's accompanying function. Surface a one-line warning
      // and degrade silently.
      console.warn(
        `[category-search] searchCategoriesByEmbedding RPC error: ${error.message}. Falling back to fuzzy search only.`,
      );
      return [];
    }

    type RpcRow = {
      code:               number;
      name:               string;
      path:               string;
      attribute_set_sid:  string | null;
      similarity:         number;  // 0..1, higher = more similar
    };

    return (data as RpcRow[] ?? []).map((r) => ({
      code:              r.code,
      name:              r.name,
      path:              r.path,
      attribute_set_sid: r.attribute_set_sid,
      retrievalScore:    Math.max(0, Math.min(1, r.similarity)),
      source:            "embedding" as const,
    }));
  } catch (e) {
    console.warn(
      `[category-search] searchCategoriesByEmbedding failed: ${(e as Error).message}. Falling back to fuzzy search only.`,
    );
    return [];
  }
}

/**
 * One representative row per top-level department (the first breadcrumb
 * segment, e.g. "Electronics", "Fashion"). Feeds aiPassB0_pickDepartment
 * so the AI can pick a broad department before any category-tree
 * searching happens — see auto-analyze.ts's category-resolution section.
 *
 * The representative row's own `code`/`attribute_set_sid` are whatever
 * happened to be the first row seen for that department and are NOT
 * meaningful on their own — callers only read back the winning pick's
 * `path` (== the department name) to scope the next step; nothing is
 * ever pushed to Jumia using this row's code.
 */
export function getTopLevelDepartments(all: JumiaCategoryRow[]): { name: string; path: string }[] {
  const seen = new Set<string>();
  const out: { name: string; path: string }[] = [];
  for (const c of all) {
    const dept = c.path.split(/\s*[>/]\s*/)[0]?.trim();
    if (!dept || seen.has(dept)) continue;
    seen.add(dept);
    out.push({ name: dept, path: dept });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Every category under a top-level department — its own row (if directly
 * listable) plus every descendant. Scopes the fuzzy narrow step to a few
 * hundred/thousand relevant rows instead of the full ~27k catalog.
 */
export function getSubtreeCategories(all: JumiaCategoryRow[], departmentName: string): JumiaCategoryRow[] {
  const prefix = `${departmentName} > `;
  return all.filter((c) => c.path === departmentName || c.path.startsWith(prefix));
}

/** Reciprocal-rank-fusion constant. 60 is the value from the original RRF
 *  paper and the usual default; it flattens the gap between the top few
 *  ranks so a single source can't run away with the result. */
const RRF_K = 60;

/**
 * Merge two candidate lists by RANK, not by raw score.
 *
 * This is not a stylistic choice — merging on raw score was actively
 * breaking category detection. The two sources score on incomparable
 * scales: embedding cosine similarity lands around 0.9 for almost
 * anything in the same department, while fuzzy relevance tops out near
 * 0.3. Sorting the union by score therefore let EVERY embedding hit
 * outrank EVERY fuzzy hit, whatever their actual quality, so the fuzzy
 * side was effectively discarded whenever embeddings returned at all.
 *
 * Confirmed live 2026-09-13: a safety helmet was filed under "Power
 * Transmission Products > Bearings > Ball Transfers". Fuzzy alone ranked
 * the correct "Hard Hats" third — inside the top 3 that reach the vision
 * model — and never surfaced Ball Transfers at all. The bad candidate came
 * from the embedding side and won purely on scale. The same product
 * drafted half an hour earlier, while the embedding search was still
 * timing out, landed on fuzzy's own top hit instead.
 *
 * Reciprocal rank fusion fixes this at the root: each source contributes
 * 1/(k + rank), so only POSITION matters, and a candidate both sources
 * like beats one that only a single source ranked first.
 */
export function mergeCandidates(
  a: CategoryCandidate[],
  b: CategoryCandidate[],
  limit: number = 8
): CategoryCandidate[] {
  const fused = new Map<number, { candidate: CategoryCandidate; score: number; sources: number }>();

  for (const list of [a, b]) {
    list.forEach((candidate, index) => {
      const contribution = 1 / (RRF_K + index + 1);
      const existing = fused.get(candidate.code);
      if (existing) {
        existing.score   += contribution;
        existing.sources += 1;
      } else {
        fused.set(candidate.code, { candidate, score: contribution, sources: 1 });
      }
    });
  }

  return Array.from(fused.values())
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map(({ candidate, score, sources }) => ({
      ...candidate,
      // Renormalised onto the 0–1 scale callers expect. The best possible
      // score is both sources ranking it first.
      retrievalScore: score / (2 / (RRF_K + 1)),
      source:         sources > 1 ? ("merged" as const) : candidate.source,
    }));
}

/**
 * Semantic search across SEVERAL department subtrees at once, embedding
 * the query only once.
 *
 * Returns one result list per department, in the order given, so the
 * caller can keep track of which department produced what. A department
 * whose match fails or returns nothing yields an empty list rather than
 * taking the others down with it.
 *
 * The whole fan-out races the same single timeout the one-department
 * search uses: the matches run in parallel against an already-computed
 * vector, so three departments cost barely more wall-clock than one, and
 * the budget that protects the caller's deadline shouldn't multiply just
 * because the search got wider.
 */
export async function searchCategoriesByEmbeddingMulti(
  query: string,
  limit: number,
  deptPaths: string[],
): Promise<CategoryCandidate[][]> {
  if (!query.trim() || deptPaths.length === 0) return deptPaths.map(() => []);

  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), EMBEDDING_SEARCH_TIMEOUT_MS);
  });

  const run = async (): Promise<CategoryCandidate[][]> => {
    const { vector } = await embedText(query);
    const literal = toPgvectorLiteral(vector);
    return Promise.all(deptPaths.map((path) => matchByVector(literal, limit, path)));
  };

  let result: CategoryCandidate[][] | typeof TIMED_OUT;
  try {
    result = await Promise.race([
      run().catch((e) => {
        console.warn(`[category-search] multi-department embedding search failed: ${(e as Error).message}`);
        return deptPaths.map(() => [] as CategoryCandidate[]);
      }),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }

  const elapsed = Date.now() - started;

  if (result === TIMED_OUT) {
    console.warn(
      `[category-search] multi-department embedding search TIMED OUT after ${EMBEDDING_SEARCH_TIMEOUT_MS}ms ` +
        `across ${deptPaths.length} department(s) — these queries got fuzzy-only candidates.`,
    );
    return deptPaths.map(() => []);
  }

  console.info(
    `[category-search] embedding search ok in ${elapsed}ms → ` +
      deptPaths.map((p, i) => `${result[i].length} in "${p}"`).join(", "),
  );
  return result;
}

/**
 * Pool candidate lists from several departments, round-robin by rank.
 *
 * Every department contributes its best candidate before any department
 * contributes its second, so one department cannot crowd the others out
 * of the shortlist handed to the vision model. Order within a department
 * is preserved, and the first list (the primary department) leads each
 * round, so a confident primary still sits at the top.
 *
 * Why not merge by score: the fuzzy scorer computes IDF over whichever
 * subtree it was given, so a 0.4 in a 200-row department and a 0.4 in a
 * 4,000-row one do not mean the same thing. Ranks are comparable across
 * pools; raw scores are not. Same reasoning as mergeCandidates above,
 * one level up.
 */
export function poolByRank(
  lists: CategoryCandidate[][],
  limit = 8,
): CategoryCandidate[] {
  const out: CategoryCandidate[] = [];
  const seen = new Set<number>();
  const depth = Math.max(0, ...lists.map((l) => l.length));

  for (let rank = 0; rank < depth && out.length < limit; rank++) {
    for (const list of lists) {
      if (out.length >= limit) break;
      const candidate = list[rank];
      if (!candidate || seen.has(candidate.code)) continue;
      seen.add(candidate.code);
      out.push(candidate);
    }
  }
  return out;
}
