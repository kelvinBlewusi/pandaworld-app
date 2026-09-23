import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { previewListingPayload, type PushListingVariantInput } from "@/lib/jumia/push-listing";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

// ─── POST /api/jumia/preview ──────────────────────────────────────────────────
//
// What a push WOULD send, without sending it.
//
// Everything else in this codebase tells the seller about a difference
// AFTER it happened — a rejection, an adjustment note, a value that turned
// out not to have arrived. This is the one place they can look BEFORE
// committing, which is the only point at which the answer is still useful.
//
// It runs the same builder the real push runs (buildJumiaPayload, which
// pushProductsToJumia calls before its POST), so what this renders and
// what Jumia receives are the same object rather than two descriptions of
// it that could drift.
//
// Read-only: no feed is created, nothing is persisted, and the listing's
// status is untouched. It does call Jumia's brand catalogue, which is why
// it is rate-limited like the push rather than left open.
//
// Body: { listingId: string, variants?: [...] } — same shape as
// /api/jumia/push, so the editor can preview exactly the state it would
// submit, including unsaved variant edits held in the form.

const CODE_TO_STATUS: Record<string, number> = {
  not_found:     404,
  not_connected: 403,
  build_failed:  422,
};

export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Same budget as the push itself: a preview costs a Jumia brand lookup,
  // and its own key so previewing never eats into the seller's ability to
  // actually submit.
  const blocked = checkRateLimit(`jumia-preview:${userId}`, RATE_LIMITS.jumiaPush);
  if (blocked) return blocked;

  let body: { listingId?: string; variants?: PushListingVariantInput[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.listingId) {
    return NextResponse.json({ error: "listingId is required" }, { status: 400 });
  }

  const result = await previewListingPayload(userId, body.listingId, body.variants ?? null);

  if (!result.ok) {
    return NextResponse.json(
      { error: result.message, code: result.code },
      { status: CODE_TO_STATUS[result.code] ?? 500 },
    );
  }

  return NextResponse.json({
    products:         result.products,
    adjustments:      result.adjustments,
    missing_required: result.missingRequired,
    blockers:         result.blockers,
    // Raw, reason-tagged notes (see JumiaPayloadBuild.preflightNotes) —
    // adjustments above has already lost the .reason tag to seller-facing
    // prose, which is exactly what a canary run diffing "what got built"
    // against "what should have been built" needs back.
    preflight_notes:  result.preflightNotes,
  });
}
