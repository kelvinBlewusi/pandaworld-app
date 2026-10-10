import { NextRequest, NextResponse } from "next/server";
import { getAllCategoriesForTree } from "@/lib/jumia/categories";
import { createServerClient } from "@/lib/supabase/server";
import { jumiaCountryByCode } from "@/lib/marketing/countries";

// ─── GET /api/categories?country=GH — Jumia's categories, public ─────────────
//
// For the public category picker (/categories, owner 2026-10-10: "the page
// should not be gated to a login") and the web chat's embedded deck. The
// same rows the editor's drawer reads (/api/jumia/categories?all=1), which
// are Jumia's own public category tree. With a country, also what we know of
// it there: `blocked`, categories Jumia refused for that country
// (jumia_unlistable_categories), and `proven`, categories products went live
// in there (jumia_live_listings). Cached at the edge for an hour.

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const country = jumiaCountryByCode((req.nextUrl.searchParams.get("country") ?? "").toUpperCase().slice(0, 2))?.code ?? null;
  const categories = (await getAllCategoriesForTree()).map((c) => ({
    code: c.code, name: c.name, path: c.path, parent_code: c.parent_code, level: c.level, is_leaf: c.is_leaf, attribute_set_sid: c.attribute_set_sid,
  }));
  let blocked: number[] = [];
  let proven: number[] = [];
  if (country) {
    const db = createServerClient();
    const [b, p] = await Promise.all([
      db.from("jumia_unlistable_categories").select("category_code").eq("country", country).limit(5000),
      db.from("jumia_live_listings").select("category_code").eq("country", country).limit(5000),
    ]);
    blocked = Array.from(new Set(((b.data ?? []) as { category_code: number }[]).map((r) => Number(r.category_code))));
    proven = Array.from(new Set(((p.data ?? []) as { category_code: number | string }[]).map((r) => Number(r.category_code)).filter(Number.isFinite)));
  }
  return NextResponse.json({ categories, country, blocked, proven }, {
    headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" },
  });
}
