import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  recomputeIsLeafForAllCategories,
  getCategoriesLastSyncedAt,
} from "@/lib/jumia/categories";
import { createServerClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/is-admin";

// ─── POST /api/admin/jumia/sync-categories/finalize ──────────────────────────
//
// Called once after the last per-page batch finishes. Recomputes is_leaf
// for every row (a category is a leaf iff no other category's path starts
// with this one's path + " > "). is_leaf can't be computed page-by-page
// because a row in page 1 might gain children only added in page 5.
//
// Single DB read + a few batch updates. Typically <1s.
//
// Response:
//   { done: true, total, listable, updated, lastSyncedAt }
//
// Admin-gated via ADMIN_USER_IDS env var.

export const maxDuration = 30;

export async function POST(_req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });
  if (!isAdmin(userId)) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const t0 = Date.now();
  console.info("[Sync finalize] ▶ Recomputing is_leaf for all categories…");

  let result;
  try {
    result = await recomputeIsLeafForAllCategories();
  } catch (e) {
    console.error("[Sync finalize] ✕ Failed:", (e as Error).message);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  // Final stats for the admin UI.
  const db = createServerClient();
  const { count: total }    = await db
    .from("jumia_categories")
    .select("*", { count: "exact", head: true });
  const { count: listable } = await db
    .from("jumia_categories")
    .select("*", { count: "exact", head: true })
    .not("attribute_set_sid", "is", null);
  const lastSyncedAt = await getCategoriesLastSyncedAt();

  console.info(
    `[Sync finalize] ✓ Done in ${Date.now() - t0}ms — total=${total}, listable=${listable}, is_leaf updated for ${result.updated} rows`,
  );

  return NextResponse.json({
    done:         true,
    total:        total    ?? 0,
    listable:     listable ?? 0,
    updated:      result.updated,
    lastSyncedAt,
  });
}
