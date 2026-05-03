import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import {
  fetchCategoriesFromJumia,
  fetchAttributesFromJumia,
  upsertCategories,
  upsertAttributes,
} from "@/lib/jumia/categories";

// ─── POST /api/admin/jumia/sync-categories ────────────────────────────────────
//
// Syncs the full Jumia category tree + per-category attributes into Supabase.
// Run this once (and re-run monthly — Jumia categories rarely change).
//
// Steps:
//  1. Fetch GET /catalog/categories → upsert into jumia_categories
//  2. For each leaf category → fetch GET /catalog/categories/{code}/attributes
//     → upsert into jumia_category_attributes
//
// Body: { syncAttributes?: boolean }  (default true — set false for a fast categories-only sync)

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const body = await req.json().catch(() => ({})) as { syncAttributes?: boolean };
  const syncAttributes = body.syncAttributes !== false; // default true

  // ── Get a valid Jumia token ───────────────────────────────────────────────
  let accessToken: string;
  try {
    ({ accessToken } = await getValidJumiaCredentials(userId));
  } catch (e) {
    return NextResponse.json(
      { error: `Jumia not connected: ${(e as Error).message}` },
      { status: 403 }
    );
  }

  // ── 1. Fetch + store category tree ────────────────────────────────────────
  console.info("[Sync] Fetching Jumia category tree…");
  let categories;
  try {
    categories = await fetchCategoriesFromJumia(accessToken);
  } catch (e) {
    return NextResponse.json(
      { error: `Category fetch failed: ${(e as Error).message}` },
      { status: 502 }
    );
  }

  console.info(`[Sync] Fetched ${categories.length} categories`);
  await upsertCategories(categories);

  if (!syncAttributes) {
    return NextResponse.json({
      success: true,
      categories: categories.length,
      attributes: 0,
      message: "Category tree synced (attributes skipped)",
    });
  }

  // ── 2. Fetch attributes for each leaf category ────────────────────────────
  const leafCategories = categories.filter((c) => c.is_leaf);
  console.info(`[Sync] Fetching attributes for ${leafCategories.length} leaf categories…`);

  let attributeCount = 0;
  let errors = 0;

  for (const cat of leafCategories) {
    try {
      const attrs = await fetchAttributesFromJumia(accessToken, cat.code);
      if (attrs.length > 0) {
        await upsertAttributes(cat.code, attrs);
        attributeCount += attrs.length;
      }
      // Rate limit: max 4 req/sec
      await new Promise((r) => setTimeout(r, 260));
    } catch (e) {
      console.warn(`[Sync] Attributes failed for category ${cat.code}:`, e);
      errors++;
    }
  }

  console.info(`[Sync] Done — ${attributeCount} attributes synced, ${errors} errors`);

  return NextResponse.json({
    success: true,
    categories: categories.length,
    leafCategories: leafCategories.length,
    attributes: attributeCount,
    errors,
    message: `Synced ${categories.length} categories and ${attributeCount} attribute fields`,
  });
}
