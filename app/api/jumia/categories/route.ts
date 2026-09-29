import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  getAllCategoriesForTree,
  getListableCategories,
  getLeafCategories,
  getCategoriesLastSyncedAt,
} from "@/lib/jumia/categories";

type DrawerCategoryRow = {
  code:               number;
  name:               string;
  path:               string;
  parent_code:        number | null;
  level:              number;
  is_leaf:            boolean | null;
  attribute_set_sid:  string | null;
};

// ─── GET /api/jumia/categories ────────────────────────────────────────────────
//
// Returns synced categories from Supabase for the category drawer.
//
// Query params:
//   ?all=1       — every category (leaves + parents) with is_leaf flag, for
//                  drill-down rendering.
//   ?leafOnly=1  — only categories where is_leaf=true (path-heuristic). Kept
//                  for legacy callers that need a tighter list.
//   (no param)   — every LISTABLE category (attribute_set_sid IS NOT NULL).
//                  This matches Vendor Center's picker: Jumia tags a category
//                  as listable iff it returned an attributeSet for it, and
//                  some intermediate parents are listable alongside their
//                  children.
//
// The response always includes an `X-Last-Synced-At` header (ISO timestamp
// or empty if the table is empty). The category drawer reads this to decide
// whether to fire a background refresh — >24h old triggers a fresh sync,
// non-blocking, so the next picker open sees up-to-date data.

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const wantAll      = req.nextUrl.searchParams.get("all") === "1";
  const wantLeafOnly = req.nextUrl.searchParams.get("leafOnly") === "1";

  let categoriesPayload: unknown;
  if (wantAll) {
    // From the server's cached catalog (lib/jumia/categories.ts) rather
    // than paging all ~28k rows out of Supabase on every drawer open.
    // Same fields and path order as the paged read it replaces.
    const rows: DrawerCategoryRow[] = (await getAllCategoriesForTree()).map((c) => ({
      code:              c.code,
      name:              c.name,
      path:              c.path,
      parent_code:       c.parent_code,
      level:             c.level,
      is_leaf:           c.is_leaf,
      attribute_set_sid: c.attribute_set_sid,
    }));
    categoriesPayload = rows.sort((a, b) => a.path.localeCompare(b.path));
  } else if (wantLeafOnly) {
    categoriesPayload = await getLeafCategories();
  } else {
    categoriesPayload = await getListableCategories();
  }

  const lastSyncedAt = await getCategoriesLastSyncedAt();

  return NextResponse.json(
    { categories: categoriesPayload },
    {
      headers: {
        "X-Last-Synced-At": lastSyncedAt ?? "",
      },
    },
  );
}
