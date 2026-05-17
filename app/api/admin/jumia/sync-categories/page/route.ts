import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import { fetchCategoriesPage } from "@/lib/jumia/categories";
import { isAdmin } from "@/lib/auth/is-admin";

// ─── POST /api/admin/jumia/sync-categories/page ──────────────────────────────
//
// Batched category sync — fetches ONE Jumia page per call and upserts. Admin
// UI calls this in a client-side loop (page=1, then 2, etc.) until the
// response returns `hasMore: false`. Each call returns in ~1-2s; the
// orchestration is the client's responsibility, which is what gives us:
//   - progress bar (client knows how many pages it's completed)
//   - resume (client persists last completed page in localStorage)
//   - no function timeout risk (each call far under the 60s ceiling)
//
// Body / Query:
//   ?page=N  — 1-indexed Jumia page to fetch
//
// Response:
//   { page, fetched, hasMore, totalSoFar, listableSoFar }
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
  const page = pageParam ? parseInt(pageParam, 10) : NaN;
  if (!page || isNaN(page) || page < 1) {
    return NextResponse.json({ error: "page must be a positive integer" }, { status: 400 });
  }

  // Get the admin's Jumia token to authorise the upstream call. Categories
  // are global, so it doesn't matter whose token we use — but admins
  // are the only ones who can hit this route, so we use theirs.
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
  console.info(`[Sync page=${page}] ▶ POST /api/admin/jumia/sync-categories/page`);

  let result;
  try {
    result = await fetchCategoriesPage(accessToken, page);
  } catch (e) {
    const msg = (e as Error).message ?? "Unknown error";
    console.error(`[Sync page=${page}] ✕ Failed: ${msg}`);
    return NextResponse.json({ error: msg, page }, { status: 502 });
  }

  // Stats: query current total + listable counts so the UI can display them.
  const db = createServerClient();
  const { count: totalSoFar } = await db
    .from("jumia_categories")
    .select("*", { count: "exact", head: true });
  const { count: listableSoFar } = await db
    .from("jumia_categories")
    .select("*", { count: "exact", head: true })
    .not("attribute_set_sid", "is", null);

  console.info(
    `[Sync page=${page}] ✓ ${result.rows.length} fetched, totalSoFar=${totalSoFar}, listable=${listableSoFar}, ${Date.now() - t0}ms`,
  );

  return NextResponse.json({
    page,
    fetched:       result.rows.length,
    hasMore:       result.hasMore,
    totalSoFar:    totalSoFar    ?? 0,
    listableSoFar: listableSoFar ?? 0,
  });
}
