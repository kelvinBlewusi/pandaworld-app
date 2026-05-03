import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import { JUMIA_API_BASE } from "@/lib/jumia/oauth";
import { createServerClient } from "@/lib/supabase/server";

// ─── GET /api/admin/jumia/diagnose-categories ─────────────────────────────────
// Diagnostic: shows what the Jumia API actually returns for:
//  1. GET /catalog/categories          (first 3 raw items)
//  2. GET /catalog/categories/{code}/attributes  (first synced category code)
//  3. GET /catalog/attributes?categoryCode={code} (alternative endpoint)
//  4. Lists first 10 synced category codes from DB

export async function GET() {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  let accessToken: string;
  try {
    ({ accessToken } = await getValidJumiaCredentials(userId));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
  const results: Record<string, unknown> = {};

  // ── 1. First 3 raw categories ─────────────────────────────────────────────
  try {
    const res = await fetch(`${JUMIA_API_BASE}/catalog/categories`, { headers });
    const text = await res.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    results.categories_status = res.status;
    results.categories_raw_sample = typeof parsed === "object"
      ? JSON.stringify(parsed).slice(0, 1000)
      : String(parsed).slice(0, 500);
  } catch (e) {
    results.categories_error = (e as Error).message;
  }

  // ── 2. Get first category code from DB ────────────────────────────────────
  const db = createServerClient();
  const { data: cats } = await db
    .from("jumia_categories")
    .select("code, name, path, is_leaf")
    .order("code")
    .limit(10);

  results.synced_categories = cats ?? [];

  // ── 3. Try /catalog/categories/{code}/attributes ──────────────────────────
  const firstCode = cats?.[0]?.code;
  if (firstCode) {
    try {
      const url = `${JUMIA_API_BASE}/catalog/categories/${firstCode}/attributes`;
      const res = await fetch(url, { headers });
      const text = await res.text();
      results.attributes_v1_url    = url;
      results.attributes_v1_status = res.status;
      results.attributes_v1_raw    = text.slice(0, 800);
    } catch (e) {
      results.attributes_v1_error = (e as Error).message;
    }

    // ── 4. Try /catalog/attributes?categoryCode={code} ────────────────────
    try {
      const url = `${JUMIA_API_BASE}/catalog/attributes?categoryCode=${firstCode}`;
      const res = await fetch(url, { headers });
      const text = await res.text();
      results.attributes_v2_url    = url;
      results.attributes_v2_status = res.status;
      results.attributes_v2_raw    = text.slice(0, 800);
    } catch (e) {
      results.attributes_v2_error = (e as Error).message;
    }

    // ── 5. Try /catalog/categories/{code} (single category detail) ────────
    try {
      const url = `${JUMIA_API_BASE}/catalog/categories/${firstCode}`;
      const res = await fetch(url, { headers });
      const text = await res.text();
      results.category_detail_url    = url;
      results.category_detail_status = res.status;
      results.category_detail_raw    = text.slice(0, 800);
    } catch (e) {
      results.category_detail_error = (e as Error).message;
    }
  }

  return NextResponse.json(results, { status: 200 });
}
