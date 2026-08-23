/**
 * POST /api/extension/fill  — Jumia Vendor Center autofill endpoint
 *
 * Takes the fields the extension harvested from Jumia's Add-Products form + the
 * product image + optional seller notes, and returns a value per field.
 *
 * Auth is STUBBED in this phase (see `authenticateStub`). Phase 1 replaces it
 * with the PandaWorld API-key check (docs/chrome-extension-plan.md §9) and
 * wires real quota metering.
 *
 * AI: when a Gemini backend is configured (Vertex or AI Studio key) AND an
 * image is supplied, the real vision pass (lib/ai/extension-fill) fills the
 * exact rendered fields — category-specific attributes included. If that's
 * unavailable or fails, we fall back to a deterministic mock so the extension
 * loop never hard-fails. Set EXTENSION_FORCE_MOCK=true to always use the mock.
 */

import { NextResponse } from "next/server";
import {
  buildMockProduct,
  mapProductToFields,
  finalizeAiValues,
  isSellerOwned,
  type FillRequest,
  type FillResponse,
} from "@/lib/extension/fill";
import { aiFillRenderedFields, aiConfigured } from "@/lib/ai/extension-fill";

export const runtime = "nodejs";
export const maxDuration = 60;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

/** Phase-0 auth stub. Phase 1: hash the Bearer key → userId → quota gate. */
function authenticateStub(_req: Request): { userId: string | null } {
  return { userId: null };
}

/** Parse a data: URL into { base64, mimeType }, or null if not a data URL. */
function parseDataUrl(s: string | undefined): { base64: string; mimeType: string } | null {
  if (!s) return null;
  const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(s);
  if (!m || !m[2]) return null; // require base64 encoding
  return { mimeType: m[1] || "image/jpeg", base64: m[3] };
}

/** Fetch an http(s) image to base64 (used when only a preview URL was harvested). */
async function fetchToBase64(url: string): Promise<{ base64: string; mimeType: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`image fetch HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { base64: buf.toString("base64"), mimeType: res.headers.get("content-type") || "image/jpeg" };
}

async function resolveImage(body: FillRequest): Promise<{ base64: string; mimeType: string } | null> {
  const fromData = parseDataUrl(body.image);
  if (fromData) return fromData;
  if (body.imageUrl && /^https?:\/\//.test(body.imageUrl)) {
    try {
      return await fetchToBase64(body.imageUrl);
    } catch {
      return null;
    }
  }
  return null;
}

/** Ensure a Brand field is filled — default to "Generic" like the API push does. */
function applyBrandDefault(
  values: Record<string, string>,
  fields: FillRequest["fields"],
  warnings: string[],
) {
  const brand = fields.find((f) => /brand/i.test(f.label) && !/store/i.test(f.label));
  if (brand && !values[brand.label]) {
    values[brand.label] = "Generic";
    warnings.push(`Brand not detected — filled "Generic". Change it if you know the brand.`);
  }
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
  const warnings: string[] = [];

  const forceMock = process.env.EXTENSION_FORCE_MOCK === "true";
  const image = forceMock ? null : await resolveImage(body);

  let values: Record<string, string> = {};
  let mock = true;

  if (!forceMock && aiConfigured() && image) {
    try {
      const fillable = body.fields.filter((f) => !isSellerOwned(f.label));
      const { raw } = await aiFillRenderedFields({
        imageBase64: image.base64,
        mimeType: image.mimeType,
        fields: fillable,
        notes,
        market,
      });
      const finalized = finalizeAiValues(raw, body.fields, notes);
      values = finalized.values;
      warnings.push(...finalized.warnings);
      applyBrandDefault(values, body.fields, warnings);
      mock = false;
    } catch (e) {
      warnings.push(`AI fill failed (${(e as Error).message}) — used a mock fill instead.`);
    }
  } else if (!forceMock && !image) {
    warnings.push("No product image detected — upload a photo on Jumia first for AI copy. Used a mock fill.");
  } else if (!forceMock && !aiConfigured()) {
    warnings.push("No Gemini backend configured on the server — used a mock fill.");
  }

  if (mock) {
    const product = buildMockProduct(notes, "Watches");
    const mapped = mapProductToFields(product, body.fields, notes);
    values = mapped.values;
    warnings.push(...mapped.warnings);
  }

  const response: FillResponse = {
    values,
    warnings,
    creditsRemaining: null, // Phase 1: from quota after incrementUsage()
    mock,
  };

  console.info(
    `[ext/fill] market=${market} mock=${mock} fields=${body.fields.length} ` +
      `filled=${Object.keys(values).length} warnings=${warnings.length}`,
  );

  return NextResponse.json(response, { status: 200, headers: CORS });
}
