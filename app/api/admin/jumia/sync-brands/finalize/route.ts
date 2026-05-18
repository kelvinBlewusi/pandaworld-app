import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { getBrandsLastSyncedAt } from "@/lib/jumia/brands";
import { isAdmin } from "@/lib/auth/is-admin";

// ─── POST /api/admin/jumia/sync-brands/finalize ──────────────────────────────
//
// Called by the admin UI after the last `/sync-brands/page` returns
// hasMore: false. Brands don't need a leaf-recompute pass like
// categories do, so this is just a stats endpoint — returns the final
// numbers so the UI can show "Synced X brands in Ys." Admin-gated.

export const maxDuration = 30;

export async function POST(_req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });
  if (!isAdmin(userId)) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }

  const db = createServerClient();
  const { count: total } = await db
    .from("jumia_brands")
    .select("*", { count: "exact", head: true });
  const lastSyncedAt = await getBrandsLastSyncedAt();

  console.info(`[Sync brands finalize] ✓ total=${total ?? 0}`);

  return NextResponse.json({
    done:         true,
    total:        total ?? 0,
    lastSyncedAt,
  });
}
