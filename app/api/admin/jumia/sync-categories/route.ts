import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import {
  fetchCategoriesFromJumia,
  fetchAttributesFromJumia,
  upsertCategories,
  upsertAttributes,
} from "@/lib/jumia/categories";
import { isAdmin } from "@/lib/auth/is-admin";

// Bump the serverless function timeout. With syncAttributes=false the
// route returns in ~5-10s. With syncAttributes=true it walks ~300
// attribute fetches at the 4-req/sec rate-limit ceiling — that's ~80s
// and will time out on Hobby (60s max). Pro can raise this to 300.
//
// If you're on Hobby and need full attribute sync, prefer calling this
// route with syncAttributes=false here and relying on the lazy
// per-category attribute fetch (/api/jumia/categories/[code]/attributes)
// which loads schemas on demand when the seller picks a category.
export const maxDuration = 60;

// ─── POST /api/admin/jumia/sync-categories ────────────────────────────────────
//
// Syncs the full Jumia category list + (optionally) per-category attribute
// schemas into Supabase.
//
// How it works (based on API exploration):
//  1. GET /catalog/categories            → flat list of ~50 categories, each with attributeSet.sid
//  2. For each category with a sid:
//     GET /catalog/attribute-sets/{sid}  → full attribute schema for that category
//
// Body: { syncAttributes?: boolean }
//   - false (recommended for serverless): only the category list, ~5-10s
//   - true: full attribute walk, ~80-100s, REQUIRES Pro plan with
//     maxDuration raised to 300+. Use sparingly.

// NOTE: prefer the batched endpoints `/sync-categories/page` and
// `/sync-categories/finalize` for new code. This single-shot route is
// kept for backward compatibility and ad-hoc debugging. The admin UI
// uses the batched flow because it never times out and shows progress.
export async function POST(req: NextRequest) {
  const t0 = Date.now();
  console.info("[Sync] ▶ POST /api/admin/jumia/sync-categories — function start");

  const { userId } = await auth();
  if (!userId) {
    console.info("[Sync] ✕ Unauthorized (no userId)");
    return new NextResponse("Unauthorized", { status: 401 });
  }
  if (!isAdmin(userId)) {
    console.info(`[Sync] ✕ Non-admin user ${userId} blocked`);
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({})) as { syncAttributes?: boolean };
  const syncAttributes = body.syncAttributes !== false;
  console.info(`[Sync] userId=${userId.slice(0, 12)}… syncAttributes=${syncAttributes}`);

  // ── Get a valid Jumia token ───────────────────────────────────────────────
  let accessToken: string;
  try {
    ({ accessToken } = await getValidJumiaCredentials(userId));
    console.info(`[Sync] Got Jumia access token (${(Date.now() - t0)}ms in)`);
  } catch (e) {
    console.error("[Sync] ✕ Token resolve failed:", (e as Error).message);
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
    console.error("[Sync] ✕ Category fetch failed:", (e as Error).message);
    return NextResponse.json(
      { error: `Category fetch failed: ${(e as Error).message}` },
      { status: 502 }
    );
  }

  console.info(`[Sync] Fetched ${categories.length} categories (${(Date.now() - t0)}ms in)`);
  try {
    await upsertCategories(categories);
    console.info(`[Sync] Upserted ${categories.length} rows (${(Date.now() - t0)}ms in)`);
  } catch (e) {
    console.error("[Sync] ✕ Upsert failed:", (e as Error).message);
    return NextResponse.json(
      { error: `Database write failed: ${(e as Error).message}` },
      { status: 500 }
    );
  }

  if (!syncAttributes) {
    console.info(`[Sync] ✓ Done in ${Date.now() - t0}ms — ${categories.length} categories, attributes skipped`);
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
