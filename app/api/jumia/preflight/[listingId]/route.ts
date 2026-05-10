import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { preflightListing } from "@/lib/jumia/preflight";

// ─── GET /api/jumia/preflight/[listingId] ─────────────────────────────────────
//
// Runs every Jumia push validation rule against a listing WITHOUT calling
// Jumia. Returns a structured report:
//   { ready, checks: [{level, field, rule, message, ...}], payload, summary }
//
// Safe to call repeatedly. No side effects. No Jumia API quota burned.
// Used by the "Run pre-flight check" button in test mode.

export async function GET(
  _req: NextRequest,
  { params }: { params: { listingId: string } }
) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const result = await preflightListing(userId, params.listingId);

  if ("error" in result) {
    return NextResponse.json(result, { status: 404 });
  }

  return NextResponse.json(result);
}
