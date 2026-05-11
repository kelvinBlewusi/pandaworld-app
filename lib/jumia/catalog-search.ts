/**
 * Search Jumia's existing product catalog by name.
 *
 * Per the official Postman collection:
 *   GET /catalog/products?name=<query>&page=1
 *
 * Strategy: when our AI generates a tentative product title (e.g. "Sony
 * WH-1000XM5"), we ask Jumia "do you already have products matching this?"
 * If yes, we harvest those products' category codes as strong signals —
 * Jumia has already (correctly) categorised them in their catalog. We
 * upgrade the merged candidate list with that signal.
 *
 * Failure mode: returns [] silently. This is a best-effort enrichment;
 * the pipeline must work even when Jumia's catalog search is down or
 * returns nothing useful (long-tail / new products).
 */

import { JUMIA_API_BASE } from "@/lib/jumia/oauth";
import type { JumiaCategoryRow } from "@/lib/jumia/categories";
import { getCategoryByCode } from "@/lib/jumia/categories";
import type { CategoryCandidate } from "@/lib/jumia/category-search";

const SEARCH_TIMEOUT_MS = 8000;
const MAX_RESULTS       = 5;

interface JumiaProductSearchResult {
  id?:        string;
  name?:      string;
  category?:  { code?: number; name?: string };
}

/**
 * Calls GET /catalog/products?name=… and harvests the category codes of the
 * top results. Returns at most `limit` distinct candidates. Each candidate's
 * retrievalScore reflects how often / how prominently a code appeared in the
 * Jumia product search results (i.e. how many products in Jumia's catalog
 * already use that category for the seller's query).
 */
export async function searchJumiaProductsByTitle(
  accessToken: string,
  title:       string,
  limit:       number = 3
): Promise<CategoryCandidate[]> {
  if (!title.trim() || !accessToken) return [];

  // Truncate long titles — the search endpoint matches on prefix-ish patterns
  const q = title.slice(0, 60).trim();

  let json: { products?: JumiaProductSearchResult[]; content?: JumiaProductSearchResult[] };
  try {
    const url = `${JUMIA_API_BASE}/catalog/products?name=${encodeURIComponent(q)}&page=1`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal:  AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.warn(`[jumia catalog-search] HTTP ${res.status} for query "${q.slice(0, 40)}"`);
      return [];
    }
    json = await res.json();
  } catch (e) {
    console.warn(`[jumia catalog-search] error: ${(e as Error).message}`);
    return [];
  }

  const products = (json.products ?? json.content ?? []) as JumiaProductSearchResult[];
  if (products.length === 0) return [];

  // Count category code occurrences — frequency = strength of signal
  const codeCounts = new Map<number, number>();
  for (const p of products.slice(0, 20)) {
    const code = Number(p.category?.code);
    if (!code || isNaN(code)) continue;
    codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
  }

  if (codeCounts.size === 0) return [];

  const maxCount = Math.max(...Array.from(codeCounts.values()));

  // Resolve each code to a full category row (path, name, attribute_set_sid)
  const rows: Array<{ row: JumiaCategoryRow; score: number }> = [];
  for (const [code, count] of Array.from(codeCounts.entries())) {
    const row = await getCategoryByCode(code);
    if (row && row.is_leaf) {
      rows.push({ row, score: count / maxCount });
    }
  }

  return rows
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row, score }) => ({
      code:              row.code,
      name:              row.name,
      path:              row.path,
      attribute_set_sid: row.attribute_set_sid,
      retrievalScore:    score,
      source:            "jumia" as const,
    }));
}
