import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import {
  fetchBrandsPageFromJumia,
  upsertBrands,
} from "@/lib/jumia/brands";

// ─── POST /api/admin/jumia/sync-brands ───────────────────────────────────────
//
// Fetches the full Jumia brand catalog (paginated) and caches it in the
// `jumia_brands` Supabase table.
//
// Pagination: 0-indexed pages. Stops after 2 consecutive empty pages to handle
// sparse pagination quirks from the Jumia API.
// Rate limit: same 260 ms delay as sync-categories (≈ 4 req/sec).

export async function POST(req: NextRequest) {
  void req; // no body needed

  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  // Require a valid Jumia connection
  let accessToken: string;
  try {
    ({ accessToken } = await getValidJumiaCredentials(userId));
  } catch (e) {
    return NextResponse.json(
      { error: `Jumia not connected: ${(e as Error).message}` },
      { status: 403 }
    );
  }

  let page             = 0;
  let totalBrands      = 0;
  let consecutiveEmpty = 0;

  console.info("[sync-brands] Starting brand sync…");

  while (true) {
    const brands = await fetchBrandsPageFromJumia(accessToken, page);

    if (brands.length === 0) {
      consecutiveEmpty++;
      if (consecutiveEmpty >= 2) {
        // Two empty pages in a row → we've reached the end
        break;
      }
    } else {
      consecutiveEmpty = 0;
      await upsertBrands(brands);
      totalBrands += brands.length;
      console.info(`[sync-brands] Page ${page} → ${brands.length} brands (total: ${totalBrands})`);
    }

    page++;

    // Stay within Jumia's ~4 req/sec rate limit
    await new Promise((r) => setTimeout(r, 260));
  }

  console.info(`[sync-brands] Done. ${totalBrands} brands synced across ${page} pages.`);

  return NextResponse.json({
    success: true,
    brands:  totalBrands,
    pages:   page,
    message: `Synced ${totalBrands} brands from Jumia (${page} pages checked)`,
  });
}
