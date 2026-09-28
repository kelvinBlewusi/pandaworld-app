import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { runAutoAnalyze } from "@/lib/actions/auto-analyze";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { availableCredits } from "@/lib/billing/extension-credits";
import { LIVE_LISTING_CREDIT_COST } from "@/lib/billing/credit-packs";

// ─── POST /api/listings/[id]/auto-analyze ────────────────────────────────────
//
// Thin HTTP wrapper around lib/actions/auto-analyze.ts's runAutoAnalyze()
// — see that module for the actual describe → retrieve → rank+fill →
// merge/default/gap-fill orchestration and the process-level embedding
// circuit breaker. This route's only jobs: authenticate via Clerk,
// rate-limit, check credits, parse the optional userPrompt override,
// call the shared function, map its result to an HTTP response.
//
// Credits: drafting is free. The listing is charged LIVE_LISTING_CREDIT_COST
// when it goes live on Jumia (lib/billing/extension-credits.ts), so a draft
// only needs the seller to have that much available — the same check a
// WhatsApp draft makes. Nothing is checked while billing is off.
//
// Body (optional): { userPrompt?: string }

// Vercel serverless function timeout. Each analyze runs 3 sequential
// Gemini calls; with the resized Supabase Storage images and the
// in-module image cache we typically finish well inside 30s, but the
// occasional Gemini cold-start can push past the 10s Hobby default.
// Explicit 60s here covers worst-case + leaves headroom for the
// concurrent-batch case (3 in-flight analyzes per Vercel function).
// This must stay in the route file — maxDuration is a Next.js route
// config export, not something a plain lib function can carry.
export const maxDuration = 60;

const CODE_TO_STATUS: Record<string, number> = {
  not_found:            404,
  no_images:            422,
  describe_failed:      500,
  no_categories_synced: 422,
  catalog_not_synced:   422,
  rank_failed:          500,
  no_category_picked:   422,
};

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  // Rate limit — 3 Gemini calls per analyse (~$0.02). Per-user.
  const blocked = checkRateLimit(`auto-analyze:${userId}`, RATE_LIMITS.autoAnalyze);
  if (blocked) return blocked;

  const available = await availableCredits(userId);
  if (available < LIVE_LISTING_CREDIT_COST) {
    return NextResponse.json(
      {
        error:     `Not enough credits: a listing costs ${LIVE_LISTING_CREDIT_COST} credits when it goes live on Jumia, and you have ${Math.max(0, available)} available. Buy credits from your dashboard to continue.`,
        needed:    LIVE_LISTING_CREDIT_COST,
        available,
      },
      { status: 402 },
    );
  }

  // Optional free-text hint from the seller — gets passed to Pass A as
  // "SELLER CONTEXT" so the AI honours things the images don't show
  // (e.g. "this is a pack of 6 not single unit", "the colour is teal").
  // runAutoAnalyze falls back to the listing's persisted user_prompt, then
  // to no hint, when this is omitted.
  let userPrompt: string | null = null;
  try {
    const body = await req.json();
    if (typeof body?.userPrompt === "string" && body.userPrompt.trim()) {
      userPrompt = body.userPrompt;
    }
  } catch { /* no body / non-JSON — fine */ }

  const result = await runAutoAnalyze(userId, params.id, userPrompt);

  if (result.ok) {
    // ── Return everything the UI needs to refresh in place ───────────────
    return NextResponse.json({
      success: true,
      timings: result.timings,
      description: result.description,
      category: result.category,
      alternates: result.alternates,
      needsUserConfirmation: result.needsUserConfirmation,
      candidates_considered: result.candidates_considered,
      attributes_in_schema: result.attributes_in_schema,
      attributes_filled: result.attributes_filled,
      variations_detected: result.variations_detected,
      title: result.title,
      brand: result.brand,
    });
  }

  return NextResponse.json(
    {
      error: result.message,
      ...(result.description !== undefined ? { description: result.description } : {}),
      ...(result.candidates !== undefined ? { candidates: result.candidates } : {}),
    },
    { status: CODE_TO_STATUS[result.code] ?? 500 },
  );
}
