import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { refillAttributesForCategory } from "@/lib/jumia/refill-attributes";

// ─── POST /api/listings/[id]/refill-attributes ────────────────────────────────
//
// Triggered when the seller picks (or switches) a category in the review form
// or the WhatsApp focused editor. Thin wrapper — the actual pipeline lives in
// lib/jumia/refill-attributes.ts, shared with the WhatsApp chat's category-
// correction flow (lib/whatsapp/intake.ts), which has no Clerk session to
// read userId from.
//
// `?mode=schema-only` short-circuits the Gemini fill step — kept for any
// caller that deliberately wants to defer the AI call; the review page and
// focused editor both now default to the full AI-fill path on every
// category pick instead of requiring a separate "Fill with AI" click.

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  let body: { categoryCode?: number; categoryPath?: string; userPrompt?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const categoryCode = Number(body.categoryCode);
  if (!categoryCode || isNaN(categoryCode)) {
    return NextResponse.json({ error: "categoryCode is required" }, { status: 400 });
  }

  const schemaOnly = req.nextUrl.searchParams.get("mode") === "schema-only";
  const userContext: string | null =
    typeof body.userPrompt === "string" && body.userPrompt.trim()
      ? body.userPrompt.trim().slice(0, 1000)
      : null;

  const result = await refillAttributesForCategory(userId, params.id, categoryCode, {
    categoryPath: body.categoryPath,
    userContext,
    schemaOnly,
  });

  if (!result.ok) {
    const status = result.code === "not_found" ? 404 : result.code === "category_not_found" ? 404 : 422;
    return NextResponse.json({ error: result.message }, { status });
  }

  return NextResponse.json({
    success:            true,
    category:           result.category,
    attributesSchema:   result.attributesSchema,
    aiFilled:            result.aiFilled,
    dynamic_attributes:  result.dynamic_attributes,
    field_sources:       result.field_sources,
    field_confidence:    result.field_confidence,
  });
}
