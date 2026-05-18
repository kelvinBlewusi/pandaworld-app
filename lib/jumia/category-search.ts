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
 */

import Fuse from "fuse.js";
import type { JumiaCategoryRow } from "@/lib/jumia/categories";

export interface CategoryCandidate {
  code:               number;
  name:               string;
  path:               string;
  attribute_set_sid:  string | null;
  /** 0–1 retrieval relevance — NOT vision confidence */
  retrievalScore:     number;
  /** Where this candidate came from — useful for debugging the pipeline */
  source:             "fuzzy" | "jumia" | "merged";
}

interface IndexedRow extends JumiaCategoryRow {
  /** Last segment of the breadcrumb, e.g. "Headphones" */
  lastSegment: string;
}

function prepareIndex(rows: JumiaCategoryRow[]): IndexedRow[] {
  return rows.map((r) => ({
    ...r,
    lastSegment: r.path.split(/\s*[>/]\s*/).filter(Boolean).pop() ?? r.name,
  }));
}

/**
 * Fuzzy search the leaf list for the strongest matches against a free-text
 * query (typically an AI-generated product title or description).
 *
 * Returns top-N candidates with relevance scores in [0, 1].
 */
export function searchCategoriesByText(
  query: string,
  categories: JumiaCategoryRow[],
  limit: number = 6
): CategoryCandidate[] {
  if (!query.trim() || categories.length === 0) return [];

  const indexed = prepareIndex(categories);

  const fuse = new Fuse(indexed, {
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

  const hits = fuse.search(query, { limit: limit * 2 });   // over-fetch then dedupe

  // Dedupe by code (Fuse can repeat when multiple keys match)
  const seen = new Set<number>();
  const out: CategoryCandidate[] = [];
  for (const h of hits) {
    const r = h.item;
    if (seen.has(r.code)) continue;
    seen.add(r.code);
    // Fuse score: 0 = perfect, 1 = no match. Flip to a relevance.
    const retrievalScore = 1 - (h.score ?? 0);
    out.push({
      code:               r.code,
      name:               r.name,
      path:               r.path,
      attribute_set_sid:  r.attribute_set_sid,
      retrievalScore,
      source:             "fuzzy",
    });
    if (out.length >= limit) break;
  }

  return out;
}

/**
 * Merge two candidate lists (typically: fuzzy local + Jumia catalog lookup),
 * deduplicating by code and combining their relevance scores so candidates
 * that appear in BOTH float to the top.
 */
export function mergeCandidates(
  a: CategoryCandidate[],
  b: CategoryCandidate[],
  limit: number = 8
): CategoryCandidate[] {
  const byCode = new Map<number, CategoryCandidate>();

  for (const c of [...a, ...b]) {
    const existing = byCode.get(c.code);
    if (!existing) {
      byCode.set(c.code, { ...c });
    } else {
      // Hit by both sources — average the scores, mark as merged
      byCode.set(c.code, {
        ...existing,
        retrievalScore: Math.max(existing.retrievalScore, c.retrievalScore) * 1.1,
        source:         "merged",
      });
    }
  }

  return Array.from(byCode.values())
    .sort((x, y) => y.retrievalScore - x.retrievalScore)
    .slice(0, limit);
}
