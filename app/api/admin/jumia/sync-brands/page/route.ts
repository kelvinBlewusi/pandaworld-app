import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import { fetchBrandsPage } from "@/lib/jumia/brands";
import { isAdmin } from "@/lib/auth/is-admin";

// ─── POST /api/admin/jumia/sync-brands/page ──────────────────────────────────
//
// Batched brand sync — fetches ONE Jumia page per call and upserts. The
// admin UI calls this in a client-side loop (page=0, then 1, …) until
// it sees two `hasMore: false` responses in a row (Jumia's brand
// pagination can return sparse empty pages mid-walk, so a single empty
// page is not end-of-list).
//
// Mirrors /api/admin/jumia/sync-categories/page — same admin gate,
// same shape, same per-call timing (~1-2s).
//
// Query:
//   ?page=N   — 0-indexed Jumia brands page
//
// Response:
//   { page, fetched, hasMore, totalSoFar }
//
// Admin-gated via ADMIN_USER_IDS env var.

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });
  if (!isAdmin(userId)) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const pageParam = req.nextUrl.searchParams.get("page");
  const page = pageParam !== null ? parseInt(pageParam, 10) : NaN;
  if (page === undefined || isNaN(page) || page < 0) {
    return NextResponse.json({ error: "page must be a non-negative integer" }, { status: 400 });
  }

  // Use the admin's Jumia token. Brands are global, so it doesn't
  // matter whose token we use — admins are the only ones who can hit
  // this route, so we use theirs.
  let accessToken: string;
  try {
    ({ accessToken } = await getValidJumiaCredentials(userId));
  } catch (e) {
    return NextResponse.json(
      { error: `Jumia not connected: ${(e as Error).message}` },
      { status: 403 },
    );
  }

  const t0 = Date.now();
  console.info(`[Sync brands page=${page}] ▶ POST /api/admin/jumia/sync-brands/page`);

  let result;
  try {
    result = await fetchBrandsPage(accessToken, page);
  } catch (e) {
    const msg = (e as Error).message ?? "Unknown error";
    console.error(`[Sync brands page=${page}] ✕ Failed: ${msg}`);
    return NextResponse.json({ error: msg, page }, { status: 502 });
  }

  const db = createServerClient();
  const { count: totalSoFar } = await db
    .from("jumia_brands")
    .select("*", { count: "exact", head: true });

  console.info(
    `[Sync brands page=${page}] ✓ ${result.rows.length} fetched, totalSoFar=${totalSoFar}, ${Date.now() - t0}ms`,
  );

  return NextResponse.json({
    page,
    fetched:    result.rows.length,
    hasMore:    result.hasMore,
    totalSoFar: totalSoFar ?? 0,
  });
}
