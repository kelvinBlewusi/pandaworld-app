import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { pushListingToJumia, type PushListingVariantInput } from "@/lib/jumia/push-listing";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

// ─── POST /api/jumia/push ─────────────────────────────────────────────────────
//
// Thin HTTP wrapper around lib/jumia/push-listing.ts's pushListingToJumia()
// — see that module for the actual validation/push/persist orchestration.
// This route's only jobs: authenticate via Clerk, rate-limit, parse the
// body, call the shared function, map its result to an HTTP response.
//
// Body: {
//   listingId: string,
//   variants?: Array<{                ← preferred path: UI sends current state
//     variation:       string,         (non-empty required)
//     sellerSku:       string,
//     gtin?:           string | null,
//     quantity?:       number,
//     globalPrice?:    number | null,
//     salePrice?:      number | null,
//     saleStartDate?:  string | null,
//     saleEndDate?:    string | null,
//   }>,
// }
//
// When variants are provided in the body, push uses THOSE directly. When
// they aren't (legacy callers), pushListingToJumia falls back to the
// variants table.

const CODE_TO_STATUS: Record<string, number> = {
  not_found:                404,
  validation:                422,
  jumia_not_connected:       403,
  jumia_oauth_required:      401,
  jumia_token_expired:       401,
  jumia_reconnect_required:  401,
  jumia_no_shop_id:          403,
  credentials_error:         500,
  push_failed:               502,
};

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  // Rate limit — writes to Jumia VC. Tight cap because retries here
  // burn the seller's QC reputation + create duplicate-SKU noise.
  const blocked = checkRateLimit(`jumia-push:${userId}`, RATE_LIMITS.jumiaPush);
  if (blocked) return blocked;

  let listingId: string;
  let bodyVariants: PushListingVariantInput[] | null = null;
  try {
    const body = await req.json();
    listingId = body.listingId;
    if (!listingId) throw new Error("missing listingId");
    if (Array.isArray(body.variants)) {
      bodyVariants = body.variants as PushListingVariantInput[];
    }
  } catch {
    return NextResponse.json({ error: "listingId is required" }, { status: 400 });
  }

  const result = await pushListingToJumia(userId, listingId, bodyVariants);

  if (result.ok) {
    return NextResponse.json({
      success:     true,
      jumia_ref:   result.jumiaRef,
      sku:         result.sku,
      sku_changed: result.skuChanged,
      message:     "Listing submitted to Jumia. It will appear as Pending Approval.",
    });
  }

  return NextResponse.json(
    {
      success: false,
      error: result.message,
      ...(result.needsReconnect ? { needsReconnect: true } : {}),
      ...(result.raw !== undefined ? { raw: result.raw } : {}),
    },
    { status: CODE_TO_STATUS[result.code] ?? 500 },
  );
}
