/**
 * POST /api/extension/fill  — Jumia Vendor Center autofill endpoint
 *
 * Takes the fields the extension harvested from Jumia's Add-Products form + the
 * product image + optional seller notes, and returns a value per field.
 *
 * Auth: a PandaWorld API key (`Authorization: Bearer pw_live_...`) generated
 * on /extension/dashboard — see lib/security/extension-keys.ts. This is NOT a
 * Clerk session; the extension calls this endpoint from Jumia's origin, which
 * has no PandaWorld cookies. A missing/invalid key returns 401.
 *
 * Credits: the extension runs on its own credit ledger (lib/billing/
 * extension-credits.ts), separate from the web app's plan-based monthly
 * quota (lib/billing/quota.ts) — new sign-ups get 10 free credits, one real
 * autofill costs 2.5, purchased credits never expire. Balance checked
 * BEFORE the AI call, deducted AFTER success, same before/after shape as
 * the quota check it replaced.
 *
 * AI: when a Gemini backend is configured (Vertex or AI Studio key) AND an
 * image is supplied, the real vision pass (lib/ai/extension-fill) fills the
 * exact rendered fields — category-specific attributes included. For a real
 * seller we NEVER silently fall back to the deterministic mock generator
 * (built-Watches, generic copy) — writing placeholder text into someone's
 * actual Jumia listing is worse than just telling them what's missing and
 * filling nothing. Mock mode only exists behind EXTENSION_FORCE_MOCK=true,
 * for our own local/CI testing without needing Gemini creds or a real photo.
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
import {
  authenticateExtensionKey,
  logExtensionFillEvent,
} from "@/lib/security/extension-keys";
import { getOrCreateCreditBalance, deductCredits } from "@/lib/billing/extension-credits";
import { LISTING_CREDIT_COST, serializeCredits } from "@/lib/billing/credit-packs";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";

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

/** Parse a data: URL into { base64, mimeType }, or null if not a data URL. */
function parseDataUrl(s: string | undefined): { base64: string; mimeType: string } | null {
  if (!s) return null;
  const m = /^data:([^;,]+)(;base64)?,([\s\S]*)$/.exec(s);
  if (!m || !m[2]) return null; // require base64 encoding
  return { mimeType: m[1] || "image/jpeg", base64: m[3] };
}

/**
 * Sniff the real format from the file's magic bytes rather than trusting the
 * server's content-type header — production evidence (Vertex: "Provided
 * image is not valid") showed a CDN-fetched image failing 100% of the time
 * on an Edit-Product page, most likely because a missing/generic
 * content-type made us mislabel the bytes (e.g. real WEBP sent as the
 * "image/jpeg" fallback below). Returns null for anything that isn't a
 * recognised image format at all — including a 200-status HTML/error page,
 * which a naive content-type trust would otherwise forward straight to
 * Gemini as "image/jpeg".
 */
function sniffImageMimeType(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buf.length >= 6 && ["GIF87a", "GIF89a"].includes(buf.toString("ascii", 0, 6))) return "image/gif";
  return null;
}

/** Fetch an http(s) image to base64 (used when only a preview URL was harvested). */
async function fetchToBase64(url: string): Promise<{ base64: string; mimeType: string }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`image fetch HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mimeType = sniffImageMimeType(buf);
  if (!mimeType) throw new Error(`fetched URL is not a recognised image format (${buf.length} bytes)`);
  return { base64: buf.toString("base64"), mimeType };
}

async function resolveImage(body: FillRequest): Promise<{ base64: string; mimeType: string } | null> {
  const fromData = parseDataUrl(body.image);
  if (fromData) return fromData;
  if (body.imageUrl && /^https?:\/\//.test(body.imageUrl)) {
    try {
      return await fetchToBase64(body.imageUrl);
    } catch (e) {
      console.warn(`[ext/fill] could not fetch/validate imageUrl: ${(e as Error).message}`);
      return null;
    }
  }
  return null;
}

/**
 * Ensure a Brand field is filled — default to "Generic" like the API push
 * does. Confirmed live: on a Brand field constrained to a fixed option list
 * (a combobox), blindly writing "Generic" when it isn't actually one of
 * those options makes the client's write silently fail (no matching row to
 * click) — the panel still claimed "filled Generic" while the field stayed
 * empty. Check the option list first; when "Generic" isn't on it, leave the
 * field for the seller instead of writing a value that can't apply.
 */
function applyBrandDefault(
  values: Record<string, string>,
  fields: FillRequest["fields"],
  warnings: string[],
) {
  const brand = fields.find((f) => /brand/i.test(f.label) && !/store/i.test(f.label));
  if (!brand || values[brand.label]) return;
  if (brand.options?.length) {
    const generic = brand.options.find((o) => o.trim().toLowerCase() === "generic");
    if (!generic) {
      warnings.push(`Brand not detected, and "Generic" isn't an option for this category — please pick one.`);
      return;
    }
    values[brand.label] = generic;
  } else {
    values[brand.label] = "Generic";
  }
  warnings.push(`Brand not detected — filled "Generic". Change it if you know the brand.`);
}

/**
 * Warranty Address: the prompt already tells the AI to default to "N/A"
 * when the seller gives no address (in notes or the extension's Advanced
 * Options), but that's a soft instruction the AI doesn't reliably follow —
 * same class of problem Price and the Name guard needed a hard default
 * for, not just a prompt line. Enforce it here instead: N/A on a free-text
 * field, or whichever option actually reads "N/A"/"None" on a constrained
 * one (never force an option that doesn't exist).
 */
function applyWarrantyAddressDefault(values: Record<string, string>, fields: FillRequest["fields"]) {
  const addr = fields.find((f) => /warranty/i.test(f.label) && /address/i.test(f.label));
  if (!addr || values[addr.label]) return;
  if (addr.options?.length) {
    const na = addr.options.find((o) => /^(n\/a|none)$/i.test(o.trim()));
    if (na) values[addr.label] = na;
  } else {
    values[addr.label] = "N/A";
  }
}

/**
 * Quantity: the AI only fills this from explicit seller notes (see the
 * SELLER-CONTROLLED block in lib/ai/extension-fill.ts's prompt) — if it's
 * still missing after that, give it a plausible random stock count rather
 * than leaving the field empty for the seller to notice and fix.
 */
function applyQuantityDefault(values: Record<string, string>, fields: FillRequest["fields"]) {
  // Every Quantity field, not just the first — a multi-variant listing has
  // one per variant, and each gets its own independent stock count.
  for (const qty of fields.filter((f) => /quantity/i.test(f.label))) {
    if (!values[qty.label]) {
      values[qty.label] = String(1 + Math.floor(Math.random() * 100)); // 1-100
    }
  }
}

const stripTags = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Narrative fields (Name/Description/Highlights) can already carry real
 * seller content on an Edit-Product page — the AI was shown it
 * (HarvestedField.currentValue) and asked to keep, enhance, or replace it
 * (see the EXISTING CONTENT block in lib/ai/extension-fill.ts). Flag the
 * ones it actually changed so the seller knows to double-check them before
 * submitting, rather than silently rewriting a hand-tuned listing.
 */
function noteExistingContentChanges(
  values: Record<string, string>,
  fields: FillRequest["fields"],
  warnings: string[],
) {
  const changed = fields.filter(
    (f) => f.currentValue && values[f.label] !== undefined && stripTags(values[f.label]) !== stripTags(f.currentValue),
  );
  if (changed.length) {
    warnings.push(
      `Updated existing content in: ${changed.map((f) => f.label).join(", ")} — review before submitting.`,
    );
  }
}

export async function POST(req: Request) {
  const authResult = await authenticateExtensionKey(req.headers.get("authorization"));
  if (!authResult.ok) {
    return NextResponse.json({ error: authResult.error }, { status: 401, headers: CORS });
  }
  const { userId, keyId } = authResult;

  // This is the one route on the whole extension surface that spends real
  // money per call (a Gemini vision request, ~$0.02) and had no cap at
  // all — the credit balance check bounds the damage from any single
  // account, but not from one account hammering the endpoint within its
  // balance. checkRateLimit's response has no CORS headers of its own
  // (it's a generic 429 builder shared by non-extension routes too), and
  // this endpoint is called cross-origin from the Jumia page, so copy them
  // on before returning — otherwise the block reads as a CORS failure to
  // the extension instead of a real 429 it can show the seller.
  const limited = checkRateLimit(`extension-fill:${userId}`, RATE_LIMITS.extensionFill);
  if (limited) {
    for (const [k, v] of Object.entries(CORS)) limited.headers.set(k, v);
    return limited;
  }

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

  const balance = await getOrCreateCreditBalance(userId);
  if (balance < LISTING_CREDIT_COST) {
    return NextResponse.json(
      {
        error: `You have ${balance} credits left — an autofill costs ${LISTING_CREDIT_COST}. Buy more credits on your dashboard.`,
        creditsRemaining: balance,
      },
      { status: 402, headers: CORS },
    );
  }

  const market = body.market || "GH";
  const notes = body.notes || "";

  // Test-only path — never reachable in production (no one sets this env var
  // there). Lets us exercise the full extension loop without Gemini creds or
  // a real product photo.
  if (process.env.EXTENSION_FORCE_MOCK === "true") {
    const product = buildMockProduct(notes, "Watches");
    const mapped = mapProductToFields(product, body.fields, notes);
    logExtensionFillEvent({ userId, keyId, fieldsFilled: Object.keys(mapped.values).length, mock: true }).catch(() => {});
    const credits = serializeCredits(balance);
    const response: FillResponse = {
      values: mapped.values,
      warnings: [...mapped.warnings, "Test mode (EXTENSION_FORCE_MOCK) — not a real AI fill."],
      creditsRemaining: credits.value,
      unlimitedCredits: credits.unlimited,
      mock: true,
    };
    return NextResponse.json(response, { status: 200, headers: CORS });
  }

  const image = await resolveImage(body);
  if (!image) {
    return NextResponse.json(
      { error: "No product photo detected. Upload a photo on Jumia, then try Autofill again." },
      { status: 400, headers: CORS },
    );
  }
  if (!aiConfigured()) {
    // A server misconfiguration, not the seller's fault — logged loudly for
    // us, but they just see a plain "try again" rather than "no AI creds".
    console.error("[ext/fill] no Gemini backend configured — refusing rather than mock-filling a real listing.");
    return NextResponse.json(
      { error: "AI is temporarily unavailable. Please try again shortly." },
      { status: 503, headers: CORS },
    );
  }

  let values: Record<string, string>;
  const warnings: string[] = [];
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
    applyQuantityDefault(values, body.fields);
    applyWarrantyAddressDefault(values, body.fields);
    noteExistingContentChanges(values, body.fields, warnings);
  } catch (e) {
    console.error(`[ext/fill] AI call failed for user=${userId}:`, e);
    return NextResponse.json(
      { error: "AI couldn't process this photo right now. Please try again." },
      { status: 502, headers: CORS },
    );
  }

  const deducted = await deductCredits(userId, LISTING_CREDIT_COST, "Extension autofill");
  logExtensionFillEvent({ userId, keyId, fieldsFilled: Object.keys(values).length, mock: false }).catch(() => {});

  const credits = serializeCredits(deducted.balance);
  const response: FillResponse = {
    values,
    warnings,
    creditsRemaining: credits.value,
    unlimitedCredits: credits.unlimited,
    mock: false,
  };

  console.info(
    `[ext/fill] user=${userId} key=${keyId} market=${market} fields=${body.fields.length} ` +
      `filled=${Object.keys(values).length} warnings=${warnings.length}`,
  );

  return NextResponse.json(response, { status: 200, headers: CORS });
}
