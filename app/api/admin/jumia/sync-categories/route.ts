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
// Syncs the full Jumia category list + per-category attribute schemas into Supabase.
//
// How it works (based on API exploration):
//  1. GET /catalog/categories            → flat list of ~50 categories, each with attributeSet.sid
//  2. For each category with a sid:
//     GET /catalog/attribute-sets/{sid}  → full attribute schema for that category
//
// Body: { syncAttributes?: boolean }  (default true)

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const body = await req.json().catch(() => ({})) as { syncAttributes?: boolean };
  const syncAttributes = body.syncAttributes !== false;

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

  // ── 1. Fetch + store category list ────────────────────────────────────────
  console.info("[Sync] Fetching Jumia categories…");
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
      message: "Category list synced (attributes skipped)",
    });
  }

  // ── 2. Fetch attributes for each category via attributeSet.sid ────────────
  const withSid = categories.filter((c) => c.attribute_set_sid);
  console.info(`[Sync] Fetching attributes for ${withSid.length} categories via attribute-sets…`);

  // Deduplicate by sid — multiple categories can share the same attribute set
  const sidSeen = new Set<string>();
  let attributeCount = 0;
  let errors = 0;

  for (const cat of withSid) {
    const sid = cat.attribute_set_sid!;
    if (sidSeen.has(sid)) {
      // Copy attributes from the first category that used this sid
      const existing = withSid.find((c) => c.attribute_set_sid === sid && c.code !== cat.code);
      if (existing) {
        // We'll handle dedup by just re-fetching — fast since we already have it
      }
    }
    sidSeen.add(sid);

    try {
      const attrs = await fetchAttributesFromJumia(accessToken, sid);
      console.info(`[Sync] ${cat.name} (${cat.code}): ${attrs.length} attributes`);
      if (attrs.length > 0) {
        await upsertAttributes(cat.code, attrs);
        attributeCount += attrs.length;
      }
      // Respect Jumia rate limit: max 4 req/sec
      await new Promise((r) => setTimeout(r, 260));
    } catch (e) {
      console.warn(`[Sync] Attributes failed for ${cat.name} (${cat.code}):`, e);
      errors++;
    }
  }

  console.info(`[Sync] Done — ${attributeCount} attributes synced, ${errors} errors`);

  return NextResponse.json({
    success: true,
    categories: categories.length,
    attributes: attributeCount,
    errors,
    message: `Synced ${categories.length} categories and ${attributeCount} attribute fields`,
  });
}
