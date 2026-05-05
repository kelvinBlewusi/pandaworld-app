import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getLeafCategories } from "@/lib/jumia/categories";

// ─── GET /api/jumia/categories ────────────────────────────────────────────────
//
// Returns all synced leaf categories from Supabase for the category picker.
// Falls back to [] if the category table is empty (not yet synced).

export async function GET() {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const categories = await getLeafCategories();
  return NextResponse.json({ categories });
}
