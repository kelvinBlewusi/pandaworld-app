import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import { searchBrandsFromDB } from "@/lib/jumia/brands";
import { JUMIA_API_BASE } from "@/lib/jumia/oauth";

// ─── GET /api/jumia/brands?q={name} ──────────────────────────────────────────
//
// 1. Tries the local `jumia_brands` cache first (fast, no network).
// 2. Falls back to the live Jumia Catalog API if the DB has no results
//    (e.g. before the first sync, or for an unusual brand name).
//
// Returns up to 20 matching brands as { brands: Array<{ code, name }> }.
// Gracefully returns [] if Jumia is not connected.

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (!q) return NextResponse.json({ brands: [] });

  // ── 1. Local DB (fast path) ─────────────────────────────────────────────────
  try {
    const dbResults = await searchBrandsFromDB(q, 20);
    if (dbResults.length > 0) {
      return NextResponse.json({ brands: dbResults });
    }
  } catch {
    // DB not ready / table missing — fall through to live API
  }

  // ── 2. Live Jumia API fallback ──────────────────────────────────────────────
  let accessToken: string;
  try {
    ({ accessToken } = await getValidJumiaCredentials(userId));
  } catch {
    // Not connected — return empty so the brand field still works
    return NextResponse.json({ brands: [] });
  }

  try {
    const url = `${JUMIA_API_BASE}/catalog/brands?name=${encodeURIComponent(q)}&criteria=STARTS_WITH`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    });
    if (!res.ok) return NextResponse.json({ brands: [] });

    const data = await res.json() as Record<string, unknown>;
    const list = (
      Array.isArray(data)
        ? data
        : (data.brands ?? data.content ?? [])
    ) as Record<string, unknown>[];

    const brands = list
      .slice(0, 20)
      .map((b) => ({
        code: Number(b.code ?? b.id ?? 0),
        name: String(b.name ?? ""),
      }))
      .filter((b) => b.name);

    return NextResponse.json({ brands });
  } catch {
    return NextResponse.json({ brands: [] });
  }
}
