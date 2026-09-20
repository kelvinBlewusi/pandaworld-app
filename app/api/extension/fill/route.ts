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

async function resolveOneImage(item: { image?: string; imageUrl?: string }): Promise<{ base64: string; mimeType: string } | null> {
  const fromData = parseDataUrl(item.image);
  if (fromData) return fromData;
  if (item.imageUrl && /^https?:\/\//.test(item.imageUrl)) {
    try {
      return await fetchToBase64(item.imageUrl);
    } catch (e) {
      console.warn(`[ext/fill] could not fetch/validate imageUrl: ${(e as Error).message}`);
      return null;
    }
  }
  return null;
}

// Server-side mirror of content.js's own MAX_IMAGES cap — enforced again
// here since the request body is untrusted input, not just a courtesy from
// a well-behaved extension build.
const MAX_IMAGES = 4;

/**
 * Resolves every harvested photo to base64, preferring the new `images`
 * array and falling back to the legacy singular `image`/`imageUrl` fields
 * (see FillRequest's own comment on why that fallback has to stay). A photo
 * that fails to resolve (bad URL, unrecognised format) is dropped rather
 * than failing the whole request — the AI still gets whatever DID resolve.
 */
async function resolveImages(body: FillRequest): Promise<{ base64: string; mimeType: string }[]> {
  const items: Array<{ image?: string; imageUrl?: string }> = body.images?.length
    ? body.images.map((i) => ({ image: i.dataUrl, imageUrl: i.httpUrl }))
    : body.image || body.imageUrl
      ? [{ image: body.image, imageUrl: body.imageUrl }]
      : [];
  const resolved = await Promise.all(items.slice(0, MAX_IMAGES).map(resolveOneImage));
  return resolved.filter((r): r is { base64: string; mimeType: string } => r !== null);
}

/**
 * Ensure a Brand field is filled — default to "Generic" like the API push
 * does, or "Fashion" when this category's own Brand dropdown offers it
 * (Jumia rejects "Generic" outright on Fashion-labelled categories:
 * "Product category doesn't allow Generic brand" — see BRAND_GENERIC_FASHION
 * in lib/jumia/api.ts, the same fashion-aware fallback the API push path
 * already uses). The AI never fills a real brand from the photo any more
 * (see hintFor() in lib/ai/extension-fill.ts) — only from the seller's own
 * notes — so this default is what every other listing gets.
 *
 * Previously gated the "Generic" attempt on `brand.options` actually
 * listing it first, to avoid writing a value the combobox can't select.
 * That backfired live: the harvested option snapshot (content.js's
 * enrichComboboxOptions, taken once during harvest) can miss a real option
 * that IS selectable at apply time — confirmed by re-testing a category
 * where "Generic" was genuinely there but got refused anyway, because
 * content.js's scrape of that specific dropdown hadn't captured it. That
 * snapshot was never meant to be authoritative for "does this option
 * exist" — it's a hint for the PROMPT. The real answer lives in the live
 * DOM at apply time, which is exactly what content.js's writeCombobox
 * already searches/scrolls through when it tries to select a value — so
 * it's the one true arbiter here, via the per-field ok/fail the panel's
 * results list already shows.
 *
 * Choosing BETWEEN "Generic" and "Fashion" is a different question from
 * "does my one candidate exist" — a snapshot that's missing "Fashion"
 * just means we fall back to "Generic" exactly as before this existed, so
 * there's no regression risk in using presence-in-snapshot as a
 * preference signal here, only upside when it IS captured.
 *
 * Phrase the warning honestly as a prediction rather than a claimed
 * outcome — neither "filled" nor "isn't an option" is something this
 * function actually knows at the time it runs, since the write itself
 * hasn't happened yet.
 */
function applyBrandDefault(
  values: Record<string, string>,
  fields: FillRequest["fields"],
  warnings: string[],
) {
  const brand = fields.find((f) => /brand/i.test(f.label) && !/store/i.test(f.label));
  if (!brand || values[brand.label]) return;
  const fallback = brand.options?.some((o) => o.trim().toLowerCase() === "fashion") ? "Fashion" : "Generic";
  values[brand.label] = fallback;
  warnings.push(
    `Brand not detected — trying "${fallback}". Check the results list below: if it didn't take, pick the real brand yourself.`,
  );
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

/**
 * Seller SKU: the prompt tells the AI to always generate a plausible code
 * when the seller doesn't give one (see hintFor() in extension-fill.ts) —
 * this is the same hard-default backstop Quantity/Brand/Warranty Address
 * already get for when that soft instruction still gets missed. A random
 * code is fine here (unlike GTIN, this isn't a real-world identifier that
 * has to correspond to anything) — the seller reviews before submitting.
 */
function applySellerSkuDefault(values: Record<string, string>, fields: FillRequest["fields"]) {
  for (const sku of fields.filter((f) => /sku/i.test(f.label) && !/gtin/i.test(f.label))) {
    if (!values[sku.label]) {
      const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
      values[sku.label] = `PW-${rand}`;
    }
  }
}

/**
 * Production country / Country of origin: the prompt tells the AI to always
 * pick its single best guess from the real options rather than omit (see
 * hintFor() in extension-fill.ts, requested explicitly since a blank one
 * was showing up more than other fields) — this is the hard-default
 * backstop for when that soft instruction still gets missed. Preferring
 * "China" when it's a real option matches the most common real-world case
 * for unbranded/generic goods on this marketplace (same reasoning as
 * Brand's "Generic" fallback); otherwise fall back to the first real option
 * on the list rather than leave a required-feeling field empty.
 */
function applyProductionCountryDefault(values: Record<string, string>, fields: FillRequest["fields"]) {
  const country = fields.find(
    (f) => /country/i.test(f.label) && (/production/i.test(f.label) || /origin/i.test(f.label)),
  );
  if (!country || values[country.label] || !country.options?.length) return;
  const china = country.options.find((o) => o.trim().toLowerCase() === "china");
  values[country.label] = china ?? country.options[0];
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
        error: `You have ${balance} listing credit${balance === 1 ? "" : "s"} left — Purchase on your Dashboard.`,
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

  const images = await resolveImages(body);
  if (!images.length) {
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
      images: images.map((i) => ({ base64: i.base64, mimeType: i.mimeType })),
      fields: fillable,
      notes,
      market,
    });
    const finalized = finalizeAiValues(raw, body.fields, notes);
    values = finalized.values;
    warnings.push(...finalized.warnings);
    applyBrandDefault(values, body.fields, warnings);
    applyQuantityDefault(values, body.fields);
    applySellerSkuDefault(values, body.fields);
    applyWarrantyAddressDefault(values, body.fields);
    applyProductionCountryDefault(values, body.fields);
    noteExistingContentChanges(values, body.fields, warnings);
  } catch (e) {
    console.error(`[ext/fill] AI call failed for user=${userId}:`, e);
    return NextResponse.json(
      { error: "Agent couldn't process this photo right now. Please try again." },
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
    `[ext/fill] user=${userId} key=${keyId} market=${market} images=${images.length} fields=${body.fields.length} ` +
      `filled=${Object.keys(values).length} warnings=${warnings.length}`,
  );

  return NextResponse.json(response, { status: 200, headers: CORS });
}
