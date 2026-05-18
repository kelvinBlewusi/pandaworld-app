import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getBrandCount, getBrandsLastSyncedAt } from "@/lib/jumia/brands";

// ─── GET /api/jumia/brands/status ────────────────────────────────────────────
//
// Returns `{count, lastSynced}` for the cached Jumia brand catalog. Used by
// the seller's Settings → Integrations page to show a read-only health
// summary — sync itself is admin-only (see /admin/brands), but every
// seller can see the catalog stats.

export async function GET() {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const [count, lastSynced] = await Promise.all([
    getBrandCount(),
    getBrandsLastSyncedAt(),
  ]);

  return NextResponse.json({ count, lastSynced });
}
