/**
 * lib/jumia/brands.ts
 *
 * Local Jumia brand catalog helpers — modelled on lib/jumia/categories.ts.
 *
 * Brands are synced from GET /catalog/brands (paginated) into the
 * `jumia_brands` Supabase table and read back for:
 *   1. Brand autocomplete in the review form  (via /api/jumia/brands?q=)
 *   2. Push-time brand resolution             (via resolveBrand() in api.ts)
 */

import { createServerClient } from "@/lib/supabase/server";
import { JUMIA_API_BASE }     from "@/lib/jumia/oauth";

export interface JumiaBrand {
  code: number;
  name: string;
}

// ─── DB reads ─────────────────────────────────────────────────────────────────

/**
 * Prefix-search the local brand cache.
 * Returns up to `limit` brands whose name starts with `query` (case-insensitive).
 */
export async function searchBrandsFromDB(
  query: string,
  limit = 20
): Promise<JumiaBrand[]> {
  if (!query.trim()) return [];

  const db = createServerClient();
  const { data, error } = await db
    .from("jumia_brands")
    .select("code, name")
    .ilike("name", `${query.trim()}%`)
    .order("name")
    .limit(limit);

  if (error) throw new Error(`searchBrandsFromDB: ${error.message}`);
  return (data ?? []) as JumiaBrand[];
}

/**
 * Exact-match lookup — used by resolveBrand() at push time.
 * Returns the brand if it exists locally, or null.
 */
export async function findBrandExact(
  name: string
): Promise<JumiaBrand | null> {
  if (!name.trim()) return null;

  const db = createServerClient();
  const { data } = await db
    .from("jumia_brands")
    .select("code, name")
    .ilike("name", name.trim())   // ilike = case-insensitive equality when no wildcards
    .limit(1)
    .maybeSingle();

  return data as JumiaBrand | null;
}

/**
 * Total count of brands in the local cache.
 */
export async function getBrandCount(): Promise<number> {
  const db = createServerClient();
  const { count } = await db
    .from("jumia_brands")
    .select("*", { count: "exact", head: true });
  return count ?? 0;
}

// ─── Live Jumia API fetch ─────────────────────────────────────────────────────

/**
 * Fetch one page of brands from the Jumia Catalog API.
 * Returns an empty array on any error (non-fatal — caller decides whether to abort).
 */
export async function fetchBrandsPageFromJumia(
  accessToken: string,
  page: number
): Promise<JumiaBrand[]> {
  try {
    const url = `${JUMIA_API_BASE}/catalog/brands?page=${page}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept:        "application/json",
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      console.warn(`[brands] page ${page} → HTTP ${res.status}`);
      return [];
    }

    const data = await res.json() as unknown;
    const list: Record<string, unknown>[] = Array.isArray(data)
      ? (data as Record<string, unknown>[])
      : ((data as Record<string, unknown>).brands   as Record<string, unknown>[] | undefined) ??
        ((data as Record<string, unknown>).content  as Record<string, unknown>[] | undefined) ??
        [];

    return list
      .map((b) => ({
        code: Number(b.code ?? b.id   ?? 0),
        name: String(b.name           ?? "").trim(),
      }))
      .filter((b) => b.code > 0 && b.name.length > 0);
  } catch (e) {
    console.warn(`[brands] page ${page} error: ${(e as Error).message}`);
    return [];
  }
}

// ─── DB upsert ────────────────────────────────────────────────────────────────

const UPSERT_CHUNK = 500;

/**
 * Upsert a batch of brands into `jumia_brands`.
 * Uses ON CONFLICT (code) DO UPDATE so re-syncing is safe.
 */
export async function upsertBrands(brands: JumiaBrand[]): Promise<void> {
  if (brands.length === 0) return;

  const db  = createServerClient();
  const now = new Date().toISOString();

  // Process in chunks to stay within Supabase request size limits
  for (let i = 0; i < brands.length; i += UPSERT_CHUNK) {
    const chunk = brands.slice(i, i + UPSERT_CHUNK).map((b) => ({
      code:      b.code,
      name:      b.name,
      synced_at: now,
    }));

    const { error } = await db
      .from("jumia_brands")
      .upsert(chunk, { onConflict: "code" });

    if (error) {
      throw new Error(`upsertBrands chunk ${i}–${i + chunk.length}: ${error.message}`);
    }
  }
}
