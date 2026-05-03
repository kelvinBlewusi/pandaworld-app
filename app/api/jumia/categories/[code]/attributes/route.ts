import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { getCategoryAttributes } from "@/lib/jumia/categories";

// ─── GET /api/jumia/categories/[code]/attributes ──────────────────────────────
//
// Returns the attribute schema for a Jumia category from Supabase cache.
// Used by the review form to render the correct dynamic fields.
//
// Response: { attributes: JumiaCategoryAttribute[] }

export async function GET(
  _req: NextRequest,
  { params }: { params: { code: string } }
) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const code = parseInt(params.code, 10);
  if (isNaN(code)) {
    return NextResponse.json({ error: "Invalid category code" }, { status: 400 });
  }

  const attributes = await getCategoryAttributes(code);
  return NextResponse.json({ attributes });
}
