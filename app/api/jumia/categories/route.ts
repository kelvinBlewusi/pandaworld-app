import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { getLeafCategories } from "@/lib/jumia/categories";

// ─── GET /api/jumia/categories ────────────────────────────────────────────────
//
// Returns synced categories from Supabase for the category drawer.
//
// Query params:
//   ?all=1 — return every category (leaves + parents) with is_leaf flag, so
//            the drill-down drawer can render the full tree.
//   (no param) — return only leaf categories (legacy behaviour used by the
//            old flat picker and by the AI's category-resolution pipeline).
//
// Falls back to [] if the category table is empty (not yet synced).

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const wantAll = req.nextUrl.searchParams.get("all") === "1";

  if (wantAll) {
    const db = createServerClient();
    const { data } = await db
      .from("jumia_categories")
      .select("code, name, path, parent_code, level, is_leaf, attribute_set_sid")
      .order("path");
    return NextResponse.json({ categories: data ?? [] });
  }

  const categories = await getLeafCategories();
  return NextResponse.json({ categories });
}
