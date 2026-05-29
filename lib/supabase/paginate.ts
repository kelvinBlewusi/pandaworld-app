// ─── Paginated SELECT helper ──────────────────────────────────────────────────
//
// Supabase has TWO row caps that bite us:
//
//   1. The implicit per-request limit (default 1000) — silently truncates
//      responses unless you call `.range()`.
//   2. A hard server-side `max_rows` configured in API Settings (also 1000
//      by default in Supabase Cloud projects). This caps each request
//      EVEN IF you ask for `.range(0, 99_999)` — you get at most 1000
//      rows per call, full stop. `.range()` cannot override it.
//
// We can't reliably change (2) — it's a project-level setting we don't
// always control. So instead we page through in 1000-row chunks until a
// short page tells us we've hit the end. This works regardless of the
// `max_rows` setting on the project.
//
// Used wherever we need to read the WHOLE jumia_categories table (drawer
// data source, admin diagnostics, exports, leaf recompute, etc.) — these
// tables can run to ~30k rows for sellers with the full GH catalogue.
//
// Usage:
//
//   const rows = await selectAllPaginated((from, to) =>
//     db.from("jumia_categories")
//       .select("code, name, path, …")
//       .order("path")
//       .range(from, to),
//   );

import type { PostgrestSingleResponse } from "@supabase/supabase-js";

const PAGE_SIZE = 1000;

type RangedQuery<T> = (from: number, to: number) => PromiseLike<PostgrestSingleResponse<T[]>>;

export async function selectAllPaginated<T>(
  buildQuery: RangedQuery<T>,
  pageSize: number = PAGE_SIZE,
): Promise<T[]> {
  const out: T[] = [];
  let from = 0;

  // Safety bound. 200 pages × 1000 rows = 200k rows — more than enough for
  // any Jumia tree. Prevents an infinite loop if a query never returns a
  // short page for some reason.
  for (let page = 0; page < 200; page++) {
    const to = from + pageSize - 1;
    const { data, error } = await buildQuery(from, to);
    if (error) {
      throw new Error(
        `selectAllPaginated: page ${page} failed (${error.message ?? "unknown error"})`,
      );
    }
    if (!data || data.length === 0) break;
    out.push(...data);
    if (data.length < pageSize) break;
    from = to + 1;
  }

  return out;
}

/**
 * Like `selectAllPaginated` but fires the pages in parallel batches.
 * Reduces wall-clock time for big tables (jumia_categories at ~30k rows)
 * from ~14s (28 sequential pages × ~500ms) to ~1-2s (one parallel batch).
 *
 * Trade-off: we don't know how many pages we need up front, so we
 * speculatively fetch a batch of N pages at a time. When ALL pages in
 * the batch come back full, we fire another batch; when any page comes
 * back short, we know we're done.
 *
 * For the jumia_categories table at ~28 pages, a batch size of 32
 * means one round-trip total instead of 28 sequential.
 */
export async function selectAllPaginatedParallel<T>(
  buildQuery: RangedQuery<T>,
  pageSize: number = PAGE_SIZE,
  batchSize: number = 32,
): Promise<T[]> {
  const out: T[] = [];
  let batchStart = 0;

  for (let batch = 0; batch < 10; batch++) {
    // Fire `batchSize` pages in parallel.
    const promises = Array.from({ length: batchSize }, (_, i) => {
      const from = (batchStart + i) * pageSize;
      const to   = from + pageSize - 1;
      return buildQuery(from, to);
    });
    const responses = await Promise.all(promises);

    // Stitch results in page order, watch for the first short page.
    let hitShortPage = false;
    for (const response of responses) {
      const { data, error } = response;
      if (error) {
        throw new Error(
          `selectAllPaginatedParallel: page failed (${error.message ?? "unknown error"})`,
        );
      }
      if (!data || data.length === 0) {
        hitShortPage = true;
        continue;
      }
      out.push(...data);
      if (data.length < pageSize) {
        hitShortPage = true;
      }
    }
    if (hitShortPage) break;
    batchStart += batchSize;
  }

  return out;
}
