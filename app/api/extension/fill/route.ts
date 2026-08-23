/**
 * POST /api/extension/fill  — Jumia Vendor Center autofill endpoint
 *
 * Phase 0 (POC). Takes the fields the extension harvested from Jumia's
 * Add-Products form + optional seller notes, and returns a value per field.
 *
 * Auth is STUBBED in this phase (see `authenticateStub`). Phase 1 replaces it
 * with the PandaWorld API-key check (docs/chrome-extension-plan.md §9) and
 * wires real quota metering.
 *
 * AI is MOCK by default so the extension loop runs with zero external deps.
 * Set EXTENSION_POC_REAL_AI=true (and supply an http(s) imageUrl) to route
 * through the real `aiPassA_describeProduct()` pipeline; any failure falls
 * back to the mock so the POC never hard-fails.
 */

import { NextResponse } from "next/server";
import {
  buildMockProduct,
  mapProductToFields,
  parseNotes,
  type FillRequest,
  type FillResponse,
  type ProductLike,
} from "@/lib/extension/fill";

export const runtime = "nodejs";
export const maxDuration = 60;

// Permissive CORS for the POC. The endpoint carries no cookies (auth is a
// Bearer key in Phase 1), so "*" is safe here. Tighten to the extension's
// origin once the extension ID is stable.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * Phase-0 auth stub. Accepts anything. Phase 1: hash the Bearer key, look it
 * up in extension_api_keys, resolve the Clerk userId, enforce quota.
 */
function authenticateStub(_req: Request): { userId: string | null } {
  return { userId: null };
}

export async function POST(req: Request) {
  let body: FillRequest;
  try {
    body = (await req.json()) as FillRequest;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400, headers: CORS });
  }

  if (!Array.isArray(body.fields) || body.fields.length === 0) {
    return NextResponse.json(
      { error: "No fields provided — harvest the form first." },
      { status: 400, headers: CORS },
    );
  }

  authenticateStub(req); // Phase 1: real key check + quota gate

  const market = body.market || "GH";
  const notes = body.notes || "";

  let product: ProductLike;
  let mock = true;
  const warnings: string[] = [];

  const realAI = process.env.EXTENSION_POC_REAL_AI === "true";
  const canRunRealAI = realAI && !!body.imageUrl && /^https?:\/\//.test(body.imageUrl);

  if (canRunRealAI) {
    try {
      // Dynamic import keeps Clerk/Supabase/Gemini out of the mock path.
      const { aiPassA_describeProduct } = await import("@/lib/actions/ai");
      const desc = await aiPassA_describeProduct([body.imageUrl!], notes, { forceBestModel: true });
      product = {
        title:            desc.title,
        brand:            desc.brand,
        description:      desc.description,
        highlights:       desc.highlights,
        color:            desc.color,
        color_family:     desc.color_family,
        weight_kg:        desc.weight_kg,
        warranty_text:    desc.warranty_text,
        warranty_address: desc.warranty_address,
        summary:          desc.summary,
        // Phase 1: derive a real "what's in the box" from the category schema.
        whats_in_box:     undefined,
      };
      mock = false;
    } catch (e) {
      warnings.push(`Real AI pass failed (${(e as Error).message}) — used a mock fill instead.`);
      product = buildMockProduct(notes, guessCategory(body));
    }
  } else {
    if (realAI && !canRunRealAI) {
      warnings.push("Real AI enabled but no usable image URL was supplied — used a mock fill.");
    }
    product = buildMockProduct(notes, guessCategory(body));
  }

  const mapped = mapProductToFields(product, body.fields, notes);

  const response: FillResponse = {
    values:           mapped.values,
    warnings:         [...warnings, ...mapped.warnings],
    creditsRemaining: null, // Phase 1: from quota after incrementUsage()
    mock,
  };

  // Log a compact summary so the founder can trace it in Vercel logs.
  console.info(
    `[ext/fill] market=${market} mock=${mock} fields=${body.fields.length} ` +
      `filled=${Object.keys(mapped.values).length} warnings=${response.warnings.length} ` +
      `price=${parseNotes(notes).price ?? "-"}`,
  );

  return NextResponse.json(response, { status: 200, headers: CORS });
}

/** Best-effort category name from a harvested "Category" field, else Watches. */
function guessCategory(body: FillRequest): string {
  const cat = body.fields.find((f) => /category/i.test(f.label));
  // The Category field value isn't harvested as a value in Phase 0; default to
  // the POC target category.
  return (cat && (cat as { value?: string }).value) || "Watches";
}
