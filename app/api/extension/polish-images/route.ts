/**
 * POST /api/extension/polish-images — the extension panel's "Polish images"
 * button (admin-only prototype, 2026-10-02).
 *
 * Takes the rough photos the seller uploaded on Vendor Center's Add
 * Products form (harvested by content.js, up to 3 used) and returns four
 * generated e-commerce shots of the same product (lib/gemini-image.ts
 * PRODUCT_SHOTS: main image on white, angle, lifestyle, detail) as public
 * URLs; the panel puts them into the form's image slots.
 *
 * Auth: a PandaWorld API key, like /api/extension/fill. Admins only
 * (lib/auth/is-admin.ts) until it's priced: four image generations cost
 * far more than a text draft. No credits are charged.
 */

import { NextResponse } from "next/server";
import { authenticateExtensionKey } from "@/lib/security/extension-keys";
import { isAdmin } from "@/lib/auth/is-admin";
import { resolveOneImage } from "@/lib/extension/harvested-images";
import { generateProductShots, isGeminiImageEnabled } from "@/lib/gemini-image";

export const runtime = "nodejs";
export const maxDuration = 60;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/** Source photos sent to the model: enough angles to get the product right, few enough to stay quick. */
const MAX_SOURCES = 3;

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  const authResult = await authenticateExtensionKey(req.headers.get("authorization"));
  if (!authResult.ok) {
    return NextResponse.json({ error: authResult.error }, { status: 401, headers: CORS });
  }
  if (!isAdmin(authResult.userId)) {
    return NextResponse.json({ error: "Image polish isn't available on your account yet." }, { status: 403, headers: CORS });
  }
  if (!isGeminiImageEnabled()) {
    return NextResponse.json({ error: "Image generation isn't configured on the server." }, { status: 503, headers: CORS });
  }

  let body: { images?: { dataUrl?: string; httpUrl?: string }[]; notes?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: CORS });
  }

  const resolved = await Promise.all(
    (body.images ?? []).slice(0, MAX_SOURCES).map((i) => resolveOneImage({ image: i.dataUrl, imageUrl: i.httpUrl })),
  );
  const sources = resolved.filter((r): r is { base64: string; mimeType: string } => r !== null);
  if (sources.length === 0) {
    return NextResponse.json({ error: "No product photo found — upload one on Jumia first." }, { status: 400, headers: CORS });
  }

  const shots = await generateProductShots(
    sources.map((s) => ({ mimeType: s.mimeType, data: s.base64 })),
    authResult.userId,
    { productContext: body.notes?.trim().slice(0, 500) || undefined },
  );
  if (!shots.some((s) => s.url)) {
    return NextResponse.json(
      { error: `Couldn't generate the images: ${shots[0]?.error ?? "unknown error"}` },
      { status: 502, headers: CORS },
    );
  }
  return NextResponse.json({ images: shots }, { status: 200, headers: CORS });
}
