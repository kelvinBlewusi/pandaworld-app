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
import { selectAllPaginated } from "@/lib/supabase/paginate";
import { JUMIA_API_BASE }     from "@/lib/jumia/oauth";

export interface JumiaBrand {
  code: number;
  name: string;
}

export interface BrandPageResult {
  rows:     JumiaBrand[];
  hasMore:  boolean;
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

/**
 * Most-recent `synced_at` across the brands table. Feeds the admin
 * status card. Returns null when the table is empty.
 */
export async function getBrandsLastSyncedAt(): Promise<string | null> {
  const db = createServerClient();
  const { data } = await db
    .from("jumia_brands")
    .select("synced_at")
    .order("synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data?.synced_at as string | undefined) ?? null;
}

/**
 * Return every cached brand. Used by:
 *   - the AI prompt-building path, so Gemini sees the names Jumia
 *     actually recognises (and we don't have to fuzzy-match a free-text
 *     guess at push time)
 *   - the admin diagnostic on /admin/brands.
 *
 * Pages through in 1000-row chunks — Supabase enforces a hard server-
 * side max_rows cap (default 1000) that .range() can't override. See
 * lib/supabase/paginate.ts.
 *
 * Self-healing: if the table is empty (fresh deploy, dev env, wiped
 * DB) we lazily seed from the bundled JSON snapshot and retry once.
 */
export async function getAllBrands(): Promise<JumiaBrand[]> {
  const db = createServerClient();

  const query = () =>
    selectAllPaginated<JumiaBrand>((from, to) =>
      db
        .from("jumia_brands")
        .select("code, name")
        .order("name")
        .range(from, to),
    );

  let rows = await query();
  if (rows.length > 0) return rows;

  const { inserted } = await seedBrandsFromBundledSnapshot();
  if (inserted === 0) return [];

  rows = await query();
  return rows;
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

// ─── Batched (admin) sync helpers ─────────────────────────────────────────────
//
// Mirror of fetchCategoriesPage in lib/jumia/categories.ts. The admin
// /admin/brands UI calls this once per Jumia page (~1-2s per call) and
// loops on the client until hasMore = false. Resilient to a single
// empty page in the middle of the catalogue (we treat that as "more
// to come" so we don't end the walk prematurely on Jumia's sparse
// pagination), but two empties in a row signals end-of-list.

const BRAND_PER_PAGE_TIMEOUT_MS = 10_000;

export async function fetchBrandsPage(
  accessToken: string,
  page:        number,
): Promise<BrandPageResult> {
  const url   = `${JUMIA_API_BASE}/catalog/brands?page=${page}`;
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BRAND_PER_PAGE_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal:  ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const err = e as Error;
    if (err.name === "AbortError") {
      throw new Error(
        `JUMIA_TIMEOUT: brands page ${page} timed out after ${BRAND_PER_PAGE_TIMEOUT_MS}ms`,
      );
    }
    throw new Error(`Brands page ${page} fetch failed: ${err.message}`);
  }
  clearTimeout(timer);

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new Error(`JUMIA_AUTH_FAILED: brands page ${page} returned ${res.status}`);
    }
    throw new Error(`Brands page ${page} returned HTTP ${res.status}`);
  }

  const data = (await res.json()) as unknown;
  const list: Record<string, unknown>[] = Array.isArray(data)
    ? (data as Record<string, unknown>[])
    : ((data as Record<string, unknown>).brands  as Record<string, unknown>[] | undefined) ??
      ((data as Record<string, unknown>).content as Record<string, unknown>[] | undefined) ??
      [];

  const rows: JumiaBrand[] = list
    .map((b) => ({
      code: Number(b.code ?? b.id ?? 0),
      name: String(b.name ?? "").trim(),
    }))
    .filter((b) => b.code > 0 && b.name.length > 0);

  // hasMore is "this page had results". The admin client treats two
  // consecutive empty pages as end-of-walk, so a single sparse page
  // doesn't end the sync prematurely.
  const hasMore = rows.length > 0;

  if (rows.length > 0) {
    await upsertBrands(rows);
  }

  return { rows, hasMore };
}

/**
 * Bootstrap an empty `jumia_brands` table from the bundled JSON snapshot
 * at `supabase/seed/jumia-brands.json`. Lazy / on-demand — called only
 * when getAllBrands() returns zero rows.
 *
 * If the snapshot is itself empty (fresh project before the maintainer
 * has run `npm run snapshot-brands`), this is a no-op; the admin sync
 * still works to populate.
 */
export async function seedBrandsFromBundledSnapshot(): Promise<{ inserted: number }> {
  let snapshot: JumiaBrand[];
  try {
    const mod = await import("../../supabase/seed/jumia-brands.json");
    snapshot = ((mod as { default?: JumiaBrand[] }).default ?? mod) as JumiaBrand[];
  } catch (e) {
    console.warn("[seed brands] Snapshot JSON missing or unreadable:", (e as Error).message);
    return { inserted: 0 };
  }

  if (!Array.isArray(snapshot) || snapshot.length === 0) {
    console.info("[seed brands] Snapshot is empty — nothing to seed. Admin needs to run a sync.");
    return { inserted: 0 };
  }

  await upsertBrands(snapshot);
  console.info(`[seed brands] Seeded ${snapshot.length} brands from bundled snapshot.`);
  return { inserted: snapshot.length };
}
