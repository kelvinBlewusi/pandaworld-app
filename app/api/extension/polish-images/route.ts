/**
 * POST /api/extension/polish-images — the extension panel's "Polish images"
 * button.
 *
 * Takes the rough photos the seller uploaded on Vendor Center's Add
 * Products form (harvested by content.js, up to 3 used) and returns four
 * generated e-commerce shots of the same product (lib/gemini-image.ts
 * PRODUCT_SHOTS: main image on white, angle, lifestyle, detail) as public
 * URLs; the panel puts them into the form's image slots.
 *
 * Auth: a PandaWorld API key, like /api/extension/fill. Comes with the Pro
 * and Business packs (PACK_FEATURES image_polish_extension, from
 * 2026-10-02; admins only before), and costs IMAGE_CREDIT_COST per image
 * that comes back, like the review page's photo tools: checked for all
 * four up front, charged after for those that came back. Admins and
 * everyone while billing is off pay nothing (lib/billing/mode.ts), nor does
 * a seller the owner gave it free (lib/billing/feature-grants.ts).
 *
 * The panel shows the button to everyone since 2026-10-06 and tells a
 * seller without the pack to upgrade; this route is still the real check.
 */

import { NextResponse } from "next/server";
import { authenticateExtensionKey } from "@/lib/security/extension-keys";
import { resolveOneImage } from "@/lib/extension/harvested-images";
import { generateProductShots, isGeminiImageEnabled, PRODUCT_SHOTS } from "@/lib/gemini-image";
import { featureAccess, featureMinPackName } from "@/lib/billing/features";
import { activeFeatureGrant, recordGrantUse } from "@/lib/billing/feature-grants";
import { deductCredits, getOrCreateCreditBalance } from "@/lib/billing/extension-credits";
import { IMAGE_CREDIT_COST, serializeCredits } from "@/lib/billing/credit-packs";

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
  const userId = authResult.userId;
  const access = await featureAccess(userId, "image_polish_extension");
  if (!access.ok && access.blockedBy === "credits") {
    // In the pack, but at 0 credits: pack features pause until they top up
    // (lib/billing/features.ts). A 402 like any other credit refusal, so the
    // panel offers Buy credits rather than an upgrade.
    return NextResponse.json(
      { error: "You're out of credits. Buy credits from your dashboard to keep using Polish.", buyCredits: true },
      { status: 402, headers: CORS },
    );
  }
  if (!access.ok) {
    return NextResponse.json(
      {
        error:   `Upgrade to use this feature. Image polish comes with the ${featureMinPackName("image_polish_extension")} and Business credit packs.`,
        upgrade: true,
      },
      { status: 403, headers: CORS },
    );
  }
  const grant = await activeFeatureGrant(userId, "image_polish_extension");
  const free = grant?.freeUse === true;
  if (!isGeminiImageEnabled()) {
    return NextResponse.json({ error: "Image generation isn't configured on the server." }, { status: 503, headers: CORS });
  }

  const needed = PRODUCT_SHOTS.length * IMAGE_CREDIT_COST;
  const balance = await getOrCreateCreditBalance(userId);
  if (!free && balance < needed) {
    return NextResponse.json(
      { error: `Polishing makes ${PRODUCT_SHOTS.length} images at ${IMAGE_CREDIT_COST} credits each (${needed}), and you have ${balance}. Buy credits from your dashboard to continue.`, needed, balance },
      { status: 402, headers: CORS },
    );
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
    userId,
    { productContext: body.notes?.trim().slice(0, 500) || undefined },
  );
  const made = shots.filter((s) => s.url).length;
  if (made === 0) {
    return NextResponse.json(
      { error: `Couldn't generate the images: ${shots[0]?.error ?? "unknown error"}` },
      { status: 502, headers: CORS },
    );
  }

  // Images that didn't come back are free.
  let after = balance;
  if (free) {
    await recordGrantUse(grant!.id).catch(() => {});
  } else {
    const charged = await deductCredits(userId, made * IMAGE_CREDIT_COST, `Polished ${made} product image${made === 1 ? "" : "s"} in the extension`);
    if (!charged.ok) console.error(`[polish-images] credit deduction failed for ${userId}: ${charged.error}`);
    after = charged.balance;
  }
  const credits = serializeCredits(after);

  return NextResponse.json(
    { images: shots, creditsRemaining: credits.value, unlimitedCredits: credits.unlimited },
    { status: 200, headers: CORS },
  );
}
