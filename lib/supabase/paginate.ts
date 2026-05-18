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
