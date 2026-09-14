"use server";

import { auth } from "@clerk/nextjs/server";
// Gemini-client abstraction — picks Vertex AI or AI Studio based on env.
// Replaces the previous direct `new GoogleGenerativeAI(apiKey)` instantiation.
// See lib/ai/gemini-client.ts for backend-selection details + roll-back path.
import {
  callGeminiBackend,
  isVertexEnabled,
  logActiveBackendOnce,
  type GeminiPart,
} from "@/lib/ai/gemini-client";
import {
  getListableCategories,
  getCategoryAttributes,
  getCategoryByCode,
} from "@/lib/jumia/categories";
import { getAllBrands } from "@/lib/jumia/brands";
import type { JumiaBrand } from "@/lib/jumia/brands";
import { mockCategories } from "@/lib/mock/categories";
import type { JumiaCategoryRow, JumiaCategoryAttribute } from "@/lib/jumia/categories";
import {
  SELLER_REQUIRED_FIELDS,
  SELLER_REQUIRED_ATTR_KEYS,
  BRAND_CONFIDENCE_THRESHOLD,
  AI_FIELD_DEFAULTS,
  AI_DYNAMIC_ATTR_DEFAULTS,
} from "@/lib/ai/policy";
import {
  buildRestrictedWordsInstruction,
  stripRestrictedWords,
  findRestrictedWords,
} from "@/lib/ai/restricted-words";
import {
  buildContentPolicyInstructions,
  isRestrictedBrand,
  stripBrandFromTitle,
} from "@/lib/ai/jumia-content-policy";
import {
  buildDescriptionAndHighlightsStyleBlock,
  buildDescriptionStyleBlock,
} from "@/lib/ai/content-style-rules";
import { pickModelForPlan, pickModelForOwnImagesFlow, type ModelKind } from "@/lib/billing/ai-models";
import { getQuotaSummary } from "@/lib/billing/quota";
import { trackGeminiCall, isQuotaError } from "@/lib/ai/quota-telemetry";
import type { Plan } from "@/lib/billing/plans";

// ─── Tier-aware model selection helper ──────────────────────────────────────
//
// Resolves the user's effective plan via the quota engine (which knows
// about admins + expired-paid-plan-downgrades) and returns the right
// Gemini model for the requested kind of call. Falls back gracefully
// to undefined if there's no userId (callGemini will then use the
// global PREFERRED_MODELS array — same as before this commit).

async function resolveModel(
  userId: string | null | undefined,
  kind: ModelKind,
  opts: { forceBestModel?: boolean } = {},
): Promise<string | undefined> {
  // forceBestModel: bypass the tier ladder entirely and return the
  // model pinned for the "own images" analyze flow. Same model for
  // every seller — Free / Starter / Pro / Business — because the
  // auto-analyze pipeline is the only active listing-creation path
  // and we want consistent output quality across the user base.
  // The dedicated model is defined in lib/billing/ai-models.ts so a
  // future swap is a one-line edit.
  if (opts.forceBestModel) {
    return pickModelForOwnImagesFlow(kind);
  }
  if (!userId) return undefined;
  try {
    const summary = await getQuotaSummary(userId);
    return pickModelForPlan(summary.plan as Plan, kind, { isAdmin: summary.is_admin });
  } catch {
    // Quota lookup is non-critical for model selection — degrade
    // silently to the global default.
    return undefined;
  }
}

// ─── Output types ─────────────────────────────────────────────────────────────

export interface AIProductAnalysis {
  // Core fields (always present)
  title:           string;
  description:     string;
  highlights:      string;
  brand:           string | null;
  color:           string | null;
  color_family:    string | null;
  weight_kg:       number | null;
  selling_price:   number | null;
  model:           string | null;
  main_material:   string | null;
  material_family: string | null;

  // ── AI-defaulted fields (overridable by seller's AI-chat context) ──
  // These previously lived in SELLER_REQUIRED_FIELDS and the AI was
  // forbidden from filling them. As of May 2026 the AI fills them with
  // stable defaults (see lib/ai/policy.ts AI_FIELD_DEFAULTS) so sellers
  // don't have to type the same "warranty: none" 100 times. If the
  // seller's AI-chat context names a real warranty / country, the AI
  // uses that instead.
  warranty_duration:  string | null;
  warranty_text:      string | null;
  warranty_address:   string | null;
  production_country: string | null;

  // Category (resolved from Jumia real tree)
  category_id:      string;   // kept for backwards compat (= String(category_code))
  category_path:    string;   // e.g. "Phones & Tablets > Smartphones"
  category_code:    string;   // Jumia numeric code as string (e.g. "10000799")
  commission_rate:  number;

  // Top-3 classification alternates with confidence so the UI can offer a
  // chooser when the model is uncertain. Empty when AI failed or wasn't run.
  category_alternates?: Array<{
    code:       number;
    name:       string;
    path:       string;
    confidence: number;          // 0..1
  }>;
  category_confidence?: number;  // 0..1 confidence on the primary pick
  needs_user_confirmation?: boolean;   // true when primary confidence < 0.75
                                       // or top-2 confidence spread < 0.15

  // Category-specific attributes (varies by category)
  // Stored as a flat key→value map. Only keys where the AI is confident are set.
  // Unknown / undetectable values are OMITTED (not fabricated).
  dynamic_attributes: Record<string, string>;

  // Tracks which fields were set by AI (all fields in this object are "ai" at creation time)
  field_sources: Record<string, "ai">;

  // Per-field confidence + provenance (added so the UI can render coloured
  // confidence indicators per the PDF spec — yellow=inferred, green=high,
  // gray=seller-required). Keys mirror field_sources.
  field_confidence?: Record<string, {
    confidence: number;                                        // 0..1
    source:     "image" | "ocr" | "inferred" | "seller-required";
    reasoning?: string;
  }>;
}

// Conservative field exclusions live in lib/ai/policy.ts (regular module —
// can't export constants from a "use server" file).

// ─── Build AI prompt ──────────────────────────────────────────────────────────

function buildPrompt(
  categories: JumiaCategoryRow[],
  attributes: JumiaCategoryAttribute[],
  categoryContext: string,
  brands: JumiaBrand[] = [],
  // Optional category path so the policy block can specialise its image
  // rules (Fashion allows model / lifestyle shots; everything else demands
  // white background). Passed on the SECOND pass when we know the
  // category. First pass leaves it undefined — that's fine, the policy
  // gracefully omits the Fashion-specific note.
  categoryPath?: string | null,
  // Image rules don't apply to the description-only entry point.
  includeImageRules: boolean = true,
  // Seller's free-text "AI chat" content. Wired through every prompt
  // site so the AI ALWAYS sees the seller's overrides on every pass
  // (initial fill + every re-run). Overrides the AI defaults below
  // (warranty / production_country / product_note / from_the_manufacturer).
  userContext?: string | null,
): string {
  const categoryList = categories
    .map((c) => `${c.code}|${c.path}`)
    .join("\n");

  // Brand grounding. Jumia rejects any brand that isn't in their
  // catalogue, so passing the AI the exact set of valid names means it
  // either picks one that resolves cleanly or returns null. This avoids
  // the "AI guessed a brand that doesn't exist in Jumia" failure mode
  // we used to lean on resolveBrand() to repair.
  //
  // We pass NAMES ONLY (not codes) — code lookup happens server-side
  // after the call via lib/jumia/brands#findBrandExact. Token cost is
  // ~1 token per brand name; even 10k brands is well within Gemini's
  // 1M-token input budget.
  const brandList = brands.length > 0
    ? brands.map((b) => b.name).join("\n")
    : "";
  const brandSection = brands.length > 0
    ? `\nJUMIA BRAND LIST (exact names — pick one of these or return null):\n${brandList}\n`
    : "";

  const attributeSection = attributes.length > 0
    ? `\nFor the detected category, fill these EXACT attribute fields:\n${
        attributes.map((a) => {
          const valStr = a.allowed_values.length
            ? ` (allowed values: ${a.allowed_values.join(", ")})`
            : "";
          return `  - ${a.name}: ${a.label}${valStr}${a.required ? " [REQUIRED]" : ""}`;
        }).join("\n")
      }`
    : "";

  // Brand rule is stricter when we passed a catalogue — must match
  // verbatim, otherwise the push will fail at brand resolution time.
  const brandRule = brands.length > 0
    ? `8. Brand: pick the EXACT name from the JUMIA BRAND LIST above (copy/paste, character-perfect). Only fill this if a brand logo or wordmark is clearly visible AND confidence ≥ 0.9 AND the brand appears in the list. If none of those conditions hold, set brand to null. A brand outside the list will be rejected by Jumia.`
    : `8. Brand: leave NULL unless you can clearly see a brand logo or wordmark in the image AND your confidence is above 0.9. A guessed brand causes legal/commercial issues.`;

  // Inject the full Jumia content policy at the top of the prompt so the
  // AI internalises QC rules BEFORE it sees the category list. The
  // policy carries the verbatim banned-words instruction (so we don't
  // need to append restrictedInstr separately on this path) plus the
  // title/description/highlights/image/brand/category rules and the top
  // 10 rejection patterns.
  const contentPolicy = buildContentPolicyInstructions({
    categoryPath:      categoryPath ?? null,
    includeImageRules: includeImageRules,
  });

  // Seller's AI-chat content — ALWAYS injected when present. This is
  // the seller's free-text override and takes precedence over the AI's
  // generic defaults below (warranty / country / product_note / etc.).
  // Threaded through every prompt site (Pass A + Pass B + Pass C + every
  // re-run) so the override is never lost between rounds.
  const userContextSection = userContext && userContext.trim()
    ? `\n\nSELLER AI-CHAT CONTEXT — authoritative for anything the images don't show, and OVERRIDES any default values below. If the seller mentions a warranty, country, manufacturer info, or custom customer note here, use their version instead of the defaults:\n"""${userContext.trim()}"""\n`
    : "";

  return `You are an expert Jumia Ghana product listing assistant.
Analyse the product image(s) and/or description, then return a SINGLE valid JSON object.

${contentPolicy}

${categoryContext}

JUMIA CATEGORY LIST (code|path):
${categoryList}
${brandSection}${userContextSection}
STRICT RULES — violations will cause the submission to be rejected:
1. Pick the single most specific matching category from the list. Use the exact numeric code.
2. Provide the top 3 best-matching category codes from the list above, in descending confidence order.
3. NEVER fabricate values for specs you can't see. If a spec (weight, dimensions, screen size) isn't visible AND isn't in the AI-chat context, set the field to null.
4. For dynamic_attributes: include any field you can determine from the product OR that has a default below. Omit fields you genuinely can't determine — do NOT guess on category-specific specs.
5. Description: 80–3000 characters. May be plain prose, bullets, tables, HTML, or a mix — use whichever fits the product. Inline <img> tags are allowed for product diagrams / size charts / spec sheets. Promotional / marketing language is allowed.
6. Title MUST be 15–70 characters. Lead with the MODEL or identifier + product type + 1–2 key specs. DO NOT include the brand name in the title — Jumia stores brand separately and rejects titles that repeat it ("Product name contains Brand name [X]"). The brand goes in the brand field, not the title.
7. Highlights: free-form (plain prose, bullets, tables, HTML, or mixed). No word limit per line. When bullets are used, EVERY bullet MUST be on its own line — separate with "\\n" between bullets, never run them all into one paragraph. Prefer HTML lists for clean rendering: <ul><li>…</li><li>…</li></ul>. Inline images are permitted.
${brandRule}

9. FIELD-FILLING DEFAULTS — fill these even though sellers used to do them manually. Use the defaults below UNLESS the SELLER AI-CHAT CONTEXT above overrides them:
   - model: Fill with the product's model number/name if you are CONFIDENT (visible on packaging or product). Otherwise null.
   - warranty_duration: "${AI_FIELD_DEFAULTS.warranty_duration}" (unless seller specifies a real warranty)
   - warranty_text:     "${AI_FIELD_DEFAULTS.warranty_text}" (unless seller specifies real warranty terms)
   - warranty_address:  "${AI_FIELD_DEFAULTS.warranty_address}" (unless seller specifies a real warranty address)
   - production_country: Pick based on general knowledge — country of likely manufacture for this product/brand (e.g. "China" for unbranded electronics, "Ghana" for hand-made local, "Vietnam" for many sneakers). Use the country name in English. If seller specifies a country in their AI-chat context, use that instead.
   - dynamic_attributes.product_note: ALWAYS include the customer-feedback note below (sellers can override via AI-chat context). NEVER omit.
   - dynamic_attributes.what_is_in_the_box: ALWAYS include. A MULTI-LINE list — EACH item on its OWN line, separated by \\n, starting with a count like "1x" / "2x". NEVER all on one line, NEVER just a digit. Format Jumia expects:\n         1x Smartphone\\n1x USB-C Charger\\n1x USB Cable\\n1x User Manual\n       For a drone:\n         1x Drone\\n1x Remote Controller\\n2x Batteries\\n4x Spare Propellers\\n1x Carrying Case\n       If only the product is visible with no accessories, default to:\n         1x [Product Name]\\n1x User Manual (if applicable)\\n1x Original Packaging\n       NEVER omit this field. NEVER write just "1".
   - dynamic_attributes.from_the_manufacturer: "${AI_DYNAMIC_ATTR_DEFAULTS.from_the_manufacturer}" (unless seller provides manufacturer copy in AI-chat context).

10. NEVER fill (seller-required, legal/commercial risk): selling_price, warranty_type, certifications, GTIN, SKU, stock, quantity.${attributeSection}

Return ONLY valid JSON. No markdown fences, no explanation, no trailing text:
{
  "title": "Model + product type + key specs (15-70 chars). NO BRAND NAME in the title — it goes in the brand field. Jumia rejects titles that repeat the brand.",
  "description": "80-3000 chars. Plain prose, bullets, tables, HTML, inline images allowed. Marketing copy welcome.",
  "highlights": "Free-form. Bullets, prose, or mix.",
  "brand": "Brand name ONLY if logo is clearly visible AND confidence > 0.9, else null",
  "brand_confidence": 0.0,
  "color": "Specific color e.g. Midnight Black, or null",
  "color_family": "Base color e.g. Black, or null",
  "weight_kg": null,  // ⚠ NUMBER OR null ONLY — never strings like "0.5 (estimated)", never units, never parentheticals.
  "selling_price": null,
  "model": "Model number/name if confident from image, else null",
  "main_material": "e.g. Plastic, Metal, Fabric, or null",
  "material_family": "e.g. Metal, Fabric, Plastic, or null",
  "warranty_duration": "${AI_FIELD_DEFAULTS.warranty_duration}",
  "warranty_text": "${AI_FIELD_DEFAULTS.warranty_text}",
  "warranty_address": "${AI_FIELD_DEFAULTS.warranty_address}",
  "production_country": "Country of manufacture based on general knowledge — e.g. China, Ghana, Vietnam",
  "category_code": "EXACT numeric code from category list above — your top pick",
  "category_path": "Matching path from category list above for your top pick",
  "category_confidence": 0.0,
  "category_alternates": [
    { "code": "second-best numeric code", "confidence": 0.0 },
    { "code": "third-best numeric code",  "confidence": 0.0 }
  ],
  "dynamic_attributes": {
    "product_note": "${AI_DYNAMIC_ATTR_DEFAULTS.product_note}",
    "from_the_manufacturer": "${AI_DYNAMIC_ATTR_DEFAULTS.from_the_manufacturer}",
    "attribute_name": "value — only include other category-specific attributes if you are confident"
  }
}`;
}

// ─── Gemini AI call ───────────────────────────────────────────────────────────

// Preferred models in order. The first one that's available on the user's
// API key will be used. If none of these resolve, we discover the live model
// list from Google's API and pick whatever vision-capable model is available.
//
// Order matters: lite variants first because they're ~3-5× faster on
// vision/text calls (smaller params, lower latency per token) while still
// returning Jumia-acceptable quality output for structured-JSON tasks.
// Full Flash sits behind as a higher-quality fallback if the lite tier
// is unavailable on the backend.
const PREFERRED_MODELS = [
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-flash-latest",
];

// Cache the resolved model for the lifetime of the server process so we
// don't pay the discovery cost on every request.
let _resolvedModel: string | null = null;

async function discoverWorkingModel(apiKey: string): Promise<string> {
  // Use the v1beta ListModels endpoint to enumerate what THIS key can use
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`,
    { signal: AbortSignal.timeout(15_000) }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ListModels failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json() as {
    models?: Array<{
      name: string;
      supportedGenerationMethods?: string[];
    }>;
  };
  const all = data.models ?? [];

  // Models that support generateContent and aren't preview-only
  const usable = all
    .filter((m) =>
      (m.supportedGenerationMethods ?? []).includes("generateContent") &&
      !m.name.includes("vision-001") &&     // skip stale aliases
      !m.name.includes("aqa")               // attribution model, not for us
    )
    .map((m) => m.name.replace(/^models\//, ""));

  if (usable.length === 0) {
    throw new Error("No Gemini models support generateContent on this API key.");
  }

  // Prefer flash-class models (cheap, fast, vision-capable)
  const preferred = usable.find((m) => /gemini-(2\.5|2\.0)-flash/.test(m) && !m.includes("preview") && !m.includes("thinking"))
    ?? usable.find((m) => /gemini.*flash/.test(m) && !m.includes("preview"))
    ?? usable.find((m) => /gemini-(pro|2\.0|2\.5)/.test(m))
    ?? usable[0];

  console.info(`[AI] Discovered working model: ${preferred} (${usable.length} total available)`);
  return preferred;
}

// ─── In-module image cache ─────────────────────────────────────────────────
//
// The auto-analyze pipeline calls callGemini 3 times (Pass A, B, C), and
// every call re-fetches the same Supabase Storage images. Each image is
// 0.5-2MB and there can be up to 4 per listing — so we were downloading
// up to 24MB per analyze, most of it duplicate.
//
// This cache memoises the base64-encoded inline parts by URL for a short
// TTL. The 2nd and 3rd passes within the same analyze hit the cache and
// skip the network round-trip entirely. Single analyze drops by ~2-4s.
//
// TTL is short (60s) so we don't hold dozens of MB of image bytes in
// the Node process across requests. Auto-cleans on access — entries
// past expiry get deleted before any new write.
type ImagePart = { inlineData: { data: string; mimeType: string } };
// Loose shape so existing `.filter((r) => r.ok && r.part).map((r) => r.part!)`
// + `.map((r) => r.error)` callers downstream don't need narrowing.
type ImageFetchResult = { ok: boolean; part?: ImagePart; error?: string };

const _imagePartCache = new Map<string, { part: ImagePart; expires: number }>();
const IMAGE_CACHE_TTL_MS = 60_000;

function pruneExpiredImageCache() {
  const now = Date.now();
  // forEach to avoid the ES5 Map-iteration target warning. Behaviour
  // is identical to `for (const [url, entry] of _imagePartCache)`.
  _imagePartCache.forEach((entry, url) => {
    if (entry.expires <= now) _imagePartCache.delete(url);
  });
}

// Target the Gemini call at a 1024px-max-edge version of the image
// rather than the full-resolution upload (often 12MP / 3-4MB from
// modern phones). Gemini's image-token count scales with resolution
// — 2000×2000 ≈ 1290 tokens, 1024×1024 ≈ 258 tokens (~5× fewer) —
// and inference latency tracks tokens roughly linearly. Resizing
// the input therefore drops both AI cost AND wall-clock time per
// pass, with no measurable hit to category / attribute accuracy
// for product photos at this scale.
//
// We use Supabase Storage's built-in image transform endpoint
// (/render/image/public/) so the resize happens at Supabase's CDN
// edge — no new dependency, no compute in our serverless function,
// and the resized variant is cached by Supabase across requests.
//
// Non-Supabase URLs (Imagen 3 generated, third-party) are returned
// as-is — the transform endpoint only works on Supabase Storage.
function toResizedSupabaseUrl(url: string, maxEdge = 1024): string {
  if (!url.includes("/storage/v1/object/")) return url;
  // Rewrite /storage/v1/object/<scope>/<bucket>/<path>
  // →       /storage/v1/render/image/<scope>/<bucket>/<path>?width=N&height=N&resize=contain&quality=80
  const rewritten = url.replace("/storage/v1/object/", "/storage/v1/render/image/");
  const sep = rewritten.includes("?") ? "&" : "?";
  return `${rewritten}${sep}width=${maxEdge}&height=${maxEdge}&resize=contain&quality=80`;
}

// Single attempt against one URL — returns the fetched ImagePart or
// throws with a descriptive error. Used twice by fetchImagePart so the
// resize + original-URL fallback share the same encoding logic.
async function attemptImageFetch(url: string, timeoutMs: number): Promise<ImagePart> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buffer   = await res.arrayBuffer();
  const base64   = Buffer.from(buffer).toString("base64");
  const mimeType = (res.headers.get("content-type") ?? "image/jpeg") as string;
  return { inlineData: { data: base64, mimeType } };
}

// Process-level circuit breaker: once the Supabase `/render/image/`
// endpoint returns 403 for this project, it'll return 403 for every
// other image too (it's a Supabase plan setting, not per-image). Flip
// this flag on the first 403 and skip the resize path entirely until
// the serverless process restarts. Saves a wasted ~50ms per image
// fetch — at 3 images × 3 passes × N analyses, this adds up.
let _resizeDisabled = false;

async function fetchImagePart(url: string): Promise<ImageFetchResult> {
  // Resize-at-CDN: ~5× fewer image tokens for Gemini, ~2× faster inference.
  // Cache key is the RESIZED URL so we get cache hits across passes
  // on the same image, but a fresh upload (different storage path)
  // bypasses correctly.
  const resizedUrl = toResizedSupabaseUrl(url);

  // Cache hit — skip the network call entirely.
  const cached = _imagePartCache.get(resizedUrl);
  if (cached && cached.expires > Date.now()) {
    return { ok: true, part: cached.part };
  }

  // Circuit-breaker tripped on a prior 403? Skip the resize attempt
  // entirely and go straight to the original URL. The Supabase image
  // transform endpoint is gated behind a Pro plan; if the project
  // doesn't have it, no amount of retries will help.
  if (_resizeDisabled && resizedUrl !== url) {
    try {
      const part = await attemptImageFetch(url, 15_000);
      _imagePartCache.set(resizedUrl, { part, expires: Date.now() + IMAGE_CACHE_TTL_MS });
      return { ok: true, part };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  // 1) Try the resized URL first (fast path).
  // Generous 15s timeout — Supabase's first render of a given image is a
  // cold transform (~5-8s on free tier). Subsequent hits are CDN-cached.
  try {
    const part = await attemptImageFetch(resizedUrl, 15_000);
    _imagePartCache.set(resizedUrl, { part, expires: Date.now() + IMAGE_CACHE_TTL_MS });
    return { ok: true, part };
  } catch (resizeErr) {
    // 2) Fall back to the original URL on ANY failure of the resize
    //    path (timeout, network error, 4xx — previously only 4xx
    //    fell back, which meant a slow Supabase cold-render returned
    //    "ok: false" and the analyze silently failed for the listing).
    if (resizedUrl === url) {
      return { ok: false, error: (resizeErr as Error).message };
    }
    // Trip the circuit-breaker on 403 (image transformations not
    // enabled on this Supabase project). Future fetches skip straight
    // to the original URL.
    if (/HTTP\s*403/i.test((resizeErr as Error).message)) {
      _resizeDisabled = true;
      console.warn(
        "[AI] image-resize disabled for this process (Supabase project doesn't have image transformations enabled). Falling back to original URLs.",
      );
    }
    console.warn(
      `[AI] image-resize failed (${(resizeErr as Error).message.slice(0, 80)}) — falling back to original URL`,
    );
    try {
      const part = await attemptImageFetch(url, 15_000);
      _imagePartCache.set(resizedUrl, { part, expires: Date.now() + IMAGE_CACHE_TTL_MS });
      return { ok: true, part };
    } catch (originalErr) {
      return { ok: false, error: (originalErr as Error).message };
    }
  }
}

async function callGemini(
  prompt: string,
  imageUrls: string[],
  // Optional tier-based model override. When provided, we try this
  // model FIRST (instead of the PREFERRED_MODELS array). If it errors
  // out we fall through to the normal preference list. This lets paid
  // users get Gemini 2.5 Flash while free users get the cheaper
  // 2.0 Flash, without forcing a full pipeline rewrite. See
  // lib/billing/ai-models.ts → pickModelForPlan().
  preferredModel?: string,
): Promise<string> {
  // Backend selection (Vertex AI vs AI Studio) is resolved per-call via
  // env vars in callGeminiBackend(). We don't construct the backend
  // client here — it's cached at module scope inside gemini-client.ts.
  // Surface which backend is live exactly once per process so Vercel
  // logs make the migration state legible.
  logActiveBackendOnce();
  if (!isVertexEnabled() && !process.env.GOOGLE_API_KEY) {
    throw new Error(
      "Neither Vertex AI nor GOOGLE_API_KEY is configured — Gemini calls will fail.",
    );
  }

  // Periodically clear out cache entries we no longer need. Cheap
  // because we only do this on the way INTO an analyze call, not
  // during the Gemini round-trip itself.
  pruneExpiredImageCache();

  // Fetch images (cached) and convert to inline data. The cache means
  // that the 2nd and 3rd passes of a single analyze skip the network.
  const fetchedImages: ImageFetchResult[] = await Promise.all(
    imageUrls.slice(0, 4).map((url) => fetchImagePart(url)),
  );

  const validImageParts = fetchedImages
    .filter((r) => r.ok && r.part)
    .map((r) => r.part!) as { inlineData: { data: string; mimeType: string } }[];

  if (imageUrls.length > 0 && validImageParts.length === 0) {
    const errors = fetchedImages.map((r) => r.error).filter(Boolean).join(", ");
    throw new Error(`Could not download any of the ${imageUrls.length} images for analysis: ${errors}`);
  }

  // Build the canonical parts array: text prompt first, then image
  // parts. Both backends accept this shape via the abstraction.
  const parts: GeminiPart[] = [{ text: prompt }, ...validImageParts];

  // tryModel returns the text + how long the Gemini call took. We log the
  // duration prominently so Vercel logs surface which model + how slow
  // each pass actually is — critical for diagnosing the "why is this 5×
  // slower than expected" question without ad-hoc instrumentation.
  const tryModel = async (name: string): Promise<{ text: string; ms: number; backend: string }> => {
    const t0 = Date.now();
    // Wrapped so peak concurrency and quota rejections are countable — see
    // lib/ai/quota-telemetry.ts. Observes only; never changes behaviour.
    const { text, backend } = await trackGeminiCall(() => callGeminiBackend(name, parts));
    const ms = Date.now() - t0;
    return { text, ms, backend };
  };

  // A quota rejection and a "that model doesn't exist" rejection used to
  // produce identical log lines, so the one failure that means "the whole
  // project is at its ceiling" was indistinguishable from routine model
  // drift. Tagged distinctly here so it can be grepped for, and so the
  // fallback chain below says which kind of failure it is falling back
  // from.
  const describeFailure = (stage: string, name: string, e: unknown): string => {
    const message = (e as Error).message ?? String(e);
    const kind = isQuotaError(e) ? "[AI][QUOTA] " : "";
    return `${kind}${stage} model ${name} failed: ${message.slice(0, 200)}`;
  };

  // 1. Caller passed a tier-aware preferred model (e.g. Free → 2.0 Flash,
  //    Paid → 2.5 Flash). Try it first — succeeds in the common case.
  //    On failure (model unavailable, throttled, deprecated) fall through
  //    to the global cache + preference list.
  if (preferredModel) {
    try {
      const { text, ms, backend } = await tryModel(preferredModel);
      console.info(`[AI] Model=${preferredModel} backend=${backend} call_ms=${ms} images=${validImageParts.length}`);
      return text;
    } catch (e) {
      console.warn(`[AI] ${describeFailure("Tier-preferred", preferredModel, e)}. Falling back.`);
    }
  }

  // 2. If we previously resolved a working model, try it first
  if (_resolvedModel) {
    try {
      const { text, ms, backend } = await tryModel(_resolvedModel);
      console.info(`[AI] Model=${_resolvedModel} (cached) backend=${backend} call_ms=${ms} images=${validImageParts.length}`);
      return text;
    } catch (e) {
      console.warn(`[AI] ${describeFailure("Cached", _resolvedModel, e)}`);
      _resolvedModel = null;
    }
  }

  // 3. Try each preferred model in order
  const errors: string[] = [];
  for (const modelName of PREFERRED_MODELS) {
    try {
      const { text, ms, backend } = await tryModel(modelName);
      _resolvedModel = modelName;
      console.info(`[AI] Model=${modelName} (fallback) backend=${backend} call_ms=${ms} images=${validImageParts.length}`);
      return text;
    } catch (e) {
      if (isQuotaError(e)) {
        // Worth its own line: if EVERY model in the list answers this way
        // the project is over quota, and the final "No Gemini model
        // worked" error names every model but not the actual reason.
        console.warn(`[AI] ${describeFailure("Preferred", modelName, e)}`);
      }
      errors.push(`${modelName}: ${(e as Error).message.slice(0, 100)}`);
    }
  }

  // 3. None of the preferred models worked — discover what's actually live.
  //    Discovery uses the AI Studio v1beta ListModels endpoint, which only
  //    works with a `GOOGLE_API_KEY`. On Vertex AI we skip discovery and
  //    surface a clean error — Vertex's available models are predictable
  //    from the published model catalogue, so PREFERRED_MODELS exhausting
  //    means something else is wrong (auth, region, billing).
  const apiKeyForDiscovery = process.env.GOOGLE_API_KEY;
  if (!apiKeyForDiscovery) {
    throw new Error(
      `No Gemini model worked on Vertex AI. Tried: ${PREFERRED_MODELS.join(", ")}. ` +
        `Earlier failures: ${errors.join(" | ")}`,
    );
  }
  console.warn(`[AI] All preferred models failed. Discovering available models for this API key…`);
  let discovered: string;
  try {
    discovered = await discoverWorkingModel(apiKeyForDiscovery);
  } catch (e) {
    throw new Error(
      `No Gemini model worked. Tried: ${PREFERRED_MODELS.join(", ")}. ` +
      `Discovery also failed: ${(e as Error).message}`
    );
  }

  try {
    const { text, ms, backend } = await tryModel(discovered);
    _resolvedModel = discovered;
    console.info(`[AI] Model=${discovered} (discovered) backend=${backend} call_ms=${ms} images=${validImageParts.length}`);
    return text;
  } catch (e) {
    throw new Error(
      `Discovered model ${discovered} also failed: ${(e as Error).message}. ` +
      `Earlier failures: ${errors.join(" | ")}`
    );
  }
}

// ─── Parse + validate AI response ────────────────────────────────────────────

function parseAIResponse(raw: string): Record<string, unknown> {
  const cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  // Find the JSON object
  const start = cleaned.indexOf("{");
  const end   = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object in AI response");

  return JSON.parse(cleaned.slice(start, end + 1));
}

// ─── Resolve category from AI result ─────────────────────────────────────────

function resolveCategory(
  parsed:     Record<string, unknown>,
  categories: JumiaCategoryRow[]
): { code: number; path: string; commission_rate: number } {
  const aiCode = parseInt(String(parsed.category_code ?? ""), 10);

  // Try exact code match from real categories
  if (!isNaN(aiCode) && aiCode > 0) {
    const match = categories.find((c) => c.code === aiCode);
    if (match) {
      // Look up commission rate from mock categories (our fee data source)
      const mock = mockCategories.find(
        (m) =>
          m.code === String(aiCode) ||
          m.path.toLowerCase().includes(match.name.toLowerCase())
      );
      return {
        code:            match.code,
        path:            match.path,
        commission_rate: mock ? mock.commissionRate / 100 : 0.1,
      };
    }
  }

  // Fallback: path-based fuzzy match
  const aiPath = String(parsed.category_path ?? "").toLowerCase();
  if (aiPath) {
    const fuzzy = categories.find(
      (c) =>
        c.path.toLowerCase().includes(aiPath) ||
        aiPath.includes(c.name.toLowerCase())
    );
    if (fuzzy) {
      return { code: fuzzy.code, path: fuzzy.path, commission_rate: 0.1 };
    }
  }

  // Last resort: first category in list
  const first = categories[0];
  return {
    code:            first?.code ?? 0,
    path:            first?.path ?? "Unknown",
    commission_rate: 0.1,
  };
}

// ─── Shared result builder ────────────────────────────────────────────────────

function strOrNull(v: unknown): string | null {
  if (v == null || v === "" || v === "null") return null;
  return String(v).trim() || null;
}

function buildCoreResult(
  parsed:        Record<string, unknown>,
  cat:           { code: number; path: string; commission_rate: number },
  dynAttrs:      Record<string, string>,
  classificationCtx: {
    alternates:    AIProductAnalysis["category_alternates"];
    confidence:    number;
    needsUserConfirmation: boolean;
  }
): AIProductAnalysis {
  // ── 1. Filter dynamic attributes through the seller-required key list ─────
  //
  // Even if the model returns gtin / sku / price etc., strip them so the
  // seller is forced to supply them manually. Empty / null entries also
  // dropped here. We THEN layer the AI-defaulted attributes
  // (product_note + from_the_manufacturer) so they're always present
  // unless the AI already wrote real values for them.
  const cleanDyn: Record<string, string> = {};
  for (const [rawKey, v] of Object.entries(dynAttrs)) {
    const k = rawKey.toLowerCase();
    if (SELLER_REQUIRED_ATTR_KEYS.has(k)) continue;
    if (v != null && String(v).trim() !== "" && String(v).toLowerCase() !== "null") {
      cleanDyn[rawKey] = String(v).trim();
    }
  }

  // Layer the AI-defaulted dynamic attributes. If the AI already filled
  // them (or the seller's AI-chat override produced different values),
  // keep what the AI returned. Otherwise pad with the defaults so every
  // listing has the customer-feedback note + from_the_manufacturer
  // value — categories that don't use those attrs will ignore them.
  for (const [k, defaultVal] of Object.entries(AI_DYNAMIC_ATTR_DEFAULTS)) {
    if (!cleanDyn[k] || cleanDyn[k].length === 0) {
      cleanDyn[k] = defaultVal;
    }
  }

  // ── 2. Conservative brand inference ──────────────────────────────────────
  //
  // Only carry brand through if model self-reported confidence is above the
  // threshold. Otherwise fall back to "Generic" — per Jumia API docs, the
  // generic brand code is 1045133 (or 1039426 for Fashion). Resolving the
  // numeric code happens at push time via resolveBrand(). What matters
  // here is the seller sees a pre-filled brand instead of an empty field
  // they need to chase.
  const brandConfidence = Number(parsed.brand_confidence ?? 0);
  const aiBrand         = strOrNull(parsed.brand);

  // Anti-counterfeit gate: even when the model claims it spotted a
  // luxury / restricted brand logo with high confidence, Jumia will
  // reject the listing unless the seller holds documented brand
  // authorisation. Default these to "Generic" so the seller is forced
  // to acknowledge the requirement (the UI surfaces a banner upstream
  // when brand is Generic + the AI saw a restricted name).
  const aiBrandRestricted = isRestrictedBrand(aiBrand);
  if (aiBrandRestricted) {
    console.info(`[AI Pass A] AI claimed restricted brand "${aiBrand}" — overriding to Generic for QC safety.`);
  }
  const brandValue = brandConfidence >= BRAND_CONFIDENCE_THRESHOLD && aiBrand && !aiBrandRestricted
    ? aiBrand
    : "Generic";

  // ── 3. Hard exclusion of seller-required core fields ─────────────────────
  //
  // Regardless of what the model returned for these, force null. Keeps a
  // bad guess off the listing.
  const overrideNull = (key: string) => (SELLER_REQUIRED_FIELDS.has(key) ? null : undefined);

  // ── 4. Build field_sources + field_confidence maps ───────────────────────
  const field_sources:    AIProductAnalysis["field_sources"]    = {};
  const field_confidence: AIProductAnalysis["field_confidence"] = {};

  const coreFields = [
    "title", "description", "highlights",
    "color", "color_family",
    "weight_kg",
    "main_material", "material_family",
    // AI-fillable as of May 2026 — defaults applied below if absent.
    "model",
    "warranty_duration", "warranty_text", "warranty_address",
    "production_country",
  ];

  // Brand confidence depends on how we resolved it:
  //   - Above threshold + AI detected a real brand → high (image source)
  //   - Below threshold OR no AI brand → "Generic" fallback (inferred, low)
  field_sources["brand"] = "ai";
  if (brandConfidence >= BRAND_CONFIDENCE_THRESHOLD && aiBrand && !aiBrandRestricted) {
    field_confidence["brand"] = {
      confidence: brandConfidence,
      source:     "image",
      reasoning:  "Logo visible in image",
    };
  } else if (aiBrandRestricted && aiBrand) {
    field_confidence["brand"] = {
      confidence: 0.3,
      source:     "inferred",
      reasoning:  `Detected restricted brand "${aiBrand}". Jumia requires brand-authorisation paperwork for this name — defaulted to Generic. Update only if you can prove authorisation.`,
    };
  } else {
    field_confidence["brand"] = {
      confidence: 0.5,
      source:     "inferred",
      reasoning:  "No brand logo detected — defaulted to Generic. Edit if you know the real brand.",
    };
  }

  for (const f of coreFields) {
    if (parsed[f] != null && parsed[f] !== "" && parsed[f] !== "null") {
      field_sources[f]    = "ai";
      // We don't have explicit per-field confidences for the rest yet, so
      // tag them as "image" with a default 0.85 — UI can render them yellow
      // (inferred) until the seller accepts/edits.
      field_confidence[f] = {
        confidence: 0.85,
        source:     "inferred",
      };
    }
  }

  for (const k of Object.keys(cleanDyn)) {
    field_sources[`dynamic_attributes.${k}`]    = "ai";
    field_confidence[`dynamic_attributes.${k}`] = {
      confidence: 0.8,
      source:     "inferred",
    };
  }

  // Tag the explicit seller-required fields so the UI can render them gray
  Array.from(SELLER_REQUIRED_FIELDS).forEach((f) => {
    field_confidence[f] = {
      confidence: 0,
      source:     "seller-required",
      reasoning:  "Seller must supply this — legal/commercial risk to auto-fill.",
    };
  });
  Array.from(SELLER_REQUIRED_ATTR_KEYS).forEach((k) => {
    field_confidence[`dynamic_attributes.${k}`] = {
      confidence: 0,
      source:     "seller-required",
    };
  });

  // Post-AI title scrub. Even after the policy prompt and the rejection-
  // patterns block, Gemini sometimes drops the brand back into the title
  // — especially when the brand is short (Orium, Bose, MAC) and reads
  // like part of a model code. Jumia's QC will then reject the listing
  // with "Product name contains Brand name [X]". Strip the brand from
  // the title here as a non-negotiable safety net.
  const rawTitle = String(parsed.title ?? "");
  const cleanedTitle = stripBrandFromTitle(rawTitle, brandValue);
  if (cleanedTitle !== rawTitle.trim()) {
    console.info(
      `[AI Pass A] stripped brand "${brandValue}" from title — was "${rawTitle.trim()}", now "${cleanedTitle}".`,
    );
  }

  return {
    title:              cleanedTitle || rawTitle.trim() || "Unknown product",
    description:        String(parsed.description ?? ""),
    highlights:         String(parsed.highlights  ?? ""),
    brand:              brandValue,
    color:              strOrNull(parsed.color),
    color_family:       strOrNull(parsed.color_family),
    weight_kg:          overrideNull("weight_kg") !== undefined
                          ? overrideNull("weight_kg")!
                          : (parsed.weight_kg != null && parsed.weight_kg !== "null"
                              ? Number(parsed.weight_kg)
                              : null),
    selling_price:      null,   // ALWAYS seller-supplied (commercial risk)
    // model: AI may fill if confident; otherwise null. Was previously
    // hard-nulled because legal risk was assumed — clarified to "AI-
    // fillable if visible on the product itself" per May 2026 rule update.
    model:              strOrNull(parsed.model),
    main_material:      strOrNull(parsed.main_material),
    material_family:    strOrNull(parsed.material_family),
    // ── AI-defaulted fields with userContext override ────────────────────
    // The AI prompt explicitly tells Gemini to fill these with the values
    // in AI_FIELD_DEFAULTS unless the seller's AI-chat context says
    // otherwise. If the model returns nothing (older model, sub-par
    // response), we fall back to the defaults here.
    warranty_duration:  strOrNull(parsed.warranty_duration)  ?? AI_FIELD_DEFAULTS.warranty_duration,
    warranty_text:      strOrNull(parsed.warranty_text)      ?? AI_FIELD_DEFAULTS.warranty_text,
    warranty_address:   strOrNull(parsed.warranty_address)   ?? AI_FIELD_DEFAULTS.warranty_address,
    production_country: strOrNull(parsed.production_country),  // AI picks based on knowledge; null only if it genuinely can't decide
    category_id:        String(cat.code),
    category_code:      String(cat.code),
    category_path:      cat.path,
    commission_rate:    cat.commission_rate,
    category_alternates: classificationCtx.alternates,
    category_confidence: classificationCtx.confidence,
    needs_user_confirmation: classificationCtx.needsUserConfirmation,
    dynamic_attributes: cleanDyn,
    field_sources,
    field_confidence,
  };
}

// ─── Main: analyse images ─────────────────────────────────────────────────────

const USE_MOCK_AI = process.env.USE_MOCK_AI === "true";

export async function analyzeProductImages(
  imageUrls:   string[],
  userContext?: string | null,  // free-text AI-chat from the seller; threaded into every prompt pass
): Promise<AIProductAnalysis> {
  if (!imageUrls.length) throw new Error("No images provided");

  // Dev-only mock for local development without a Gemini key
  if (USE_MOCK_AI) {
    console.warn("[AI] USE_MOCK_AI=true — returning mock analysis (set USE_MOCK_AI=false in production)");
    return buildMockAnalysis();
  }

  if (!process.env.GOOGLE_API_KEY) {
    throw new Error(
      "GOOGLE_API_KEY is not set. Add it to your Vercel environment variables to enable AI analysis."
    );
  }

  // Resolve the tier-preferred Gemini model for this user (Free →
  // 2.0 Flash, Paid → 2.5 Flash). One quota lookup per call; if it
  // fails for any reason we degrade silently to the global default.
  const { userId } = await auth();
  const visionModel = await resolveModel(userId, "vision");

  // Load every category Jumia accepts listings on — listable leaves AND
  // listable parents. Vendor Center allows publishing into a parent
  // category when it has its own attributeSet (e.g. "Watches" can be
  // selected directly even though "Watches > Smartwatches" also exists).
  // Limiting the AI to leaves only would force every listing one level
  // deeper than Jumia actually requires.
  //
  // Brands are pulled in parallel — passing them to the prompt means
  // Gemini either picks a valid Jumia brand or returns null, instead of
  // inventing names we'd have to fuzzy-match at push time.
  const [categories, brands] = await Promise.all([
    getListableCategories(),
    getAllBrands(),
  ]);

  // If no real categories synced yet, fall back gracefully
  const categoryContext = categories.length > 0
    ? `Choose from the ${categories.length} Jumia GH listable categories listed below.`
    : "Use your best knowledge of Jumia Ghana categories.";

  // First pass: category detection without attributes (fast). userContext
  // is threaded in so AI-chat overrides apply even on the first pass.
  const firstPassPrompt = buildPrompt(categories, [], categoryContext, brands, null, true, userContext);

  let parsed: Record<string, unknown>;
  try {
    const raw = await callGemini(firstPassPrompt, imageUrls, visionModel);
    parsed = parseAIResponse(raw);
  } catch (e) {
    const msg = (e as Error).message ?? "Gemini analysis failed";
    console.error("[AI] Gemini call failed:", msg);
    throw new Error(`AI analysis failed: ${msg}`);
  }

  // Resolve category
  const cat = resolveCategory(parsed, categories);

  // Extract classification confidence + top-3 alternates so the UI can
  // offer a chooser when the primary pick is uncertain.
  const classificationCtx = extractClassificationConfidence(parsed, categories, cat.code);

  // Second pass: fetch attributes for detected category, re-fill if any
  let dynamicAttributes: Record<string, string> = {};
  if (cat.code > 0) {
    const attrs = await getCategoryAttributes(cat.code);
    if (attrs.length > 0) {
      try {
        // Pass the category path on the second pass so the policy block
        // can specialise its image rules (Fashion vs everything else).
        // userContext threaded through so AI-chat overrides persist.
        const secondPrompt = buildPrompt(categories, attrs, categoryContext, brands, cat.path, true, userContext);
        const raw2 = await callGemini(secondPrompt, imageUrls, visionModel);
        const parsed2 = parseAIResponse(raw2);
        dynamicAttributes = (parsed2.dynamic_attributes ?? {}) as Record<string, string>;
        // Use the re-parsed data (may have better attribute values)
        Object.assign(parsed, parsed2);
      } catch {
        // Non-fatal — use first pass result
        dynamicAttributes = (parsed.dynamic_attributes ?? {}) as Record<string, string>;
      }
    }
  }

  const coreResult = buildCoreResult(parsed, cat, dynamicAttributes, classificationCtx);
  return coreResult;
}

// Pulls the top-3 alternates + confidence out of the AI response and
// computes the `needsUserConfirmation` flag per the spec:
//   - true when primary confidence < 0.75
//   - OR when the spread between top-1 and top-2 is < 0.15 (close call)
function extractClassificationConfidence(
  parsed:     Record<string, unknown>,
  categories: JumiaCategoryRow[],
  primaryCode: number
): {
  alternates:            AIProductAnalysis["category_alternates"];
  confidence:            number;
  needsUserConfirmation: boolean;
} {
  const primaryConf = Number(parsed.category_confidence ?? 0);
  const raw         = (parsed.category_alternates ?? []) as Array<Record<string, unknown>>;

  // Resolve each alternate code → full category row so the UI gets path + name
  const resolveOne = (code: unknown, confidence: number) => {
    const num = Number(code);
    if (!num || isNaN(num)) return null;
    const cat = categories.find((c) => c.code === num);
    if (!cat) return null;
    return { code: cat.code, name: cat.name, path: cat.path, confidence };
  };

  // Always lead with the primary (so callers always have at least 1 alternate)
  const primaryAlt = resolveOne(primaryCode, primaryConf);
  const restAlts   = raw
    .map((a) => resolveOne(a.code, Number(a.confidence ?? 0)))
    .filter((a): a is NonNullable<typeof a> => a !== null);

  const alternates = [primaryAlt, ...restAlts]
    .filter((a): a is NonNullable<typeof a> => a !== null)
    .slice(0, 3);

  const top1 = alternates[0]?.confidence ?? 0;
  const top2 = alternates[1]?.confidence ?? 0;
  const needsUserConfirmation = top1 < 0.75 || (top1 - top2) < 0.15;

  return {
    alternates,
    confidence:            primaryConf,
    needsUserConfirmation,
  };
}

// ─── Focused pass: extract attributes for a known category ──────────────────
//
// Used when the seller manually picks a category (or switches to one of the
// AI's alternates) — we already have the right category, we just need to
// fill its attribute fields from the existing images.
//
// Distinct from analyzeProductImages which does category detection + full
// listing draft. This one is a single AI call, fast, scoped, and idempotent.

// ─── Pass A: describe the product ────────────────────────────────────────────
//
// Cheap, fast first pass. Takes product images and returns a tentative
// product description that a downstream lexical search can use to narrow
// down the Jumia category tree. This avoids forcing the vision model to
// classify 1-of-200 in a single shot.

export interface ProductDescription {
  title:           string;
  brand:           string | null;       // null unless logo clearly visible
  keywords:        string[];            // 5-10 search keywords
  summary:         string;              // one-sentence description
  // Universal Jumia listing fields the AI can infer from images. The
  // auto-analyze route persists these to the listing alongside the
  // category-specific dynamic_attributes from Pass C.
  description:     string;              // 80-3000 chars, prose/bullets/tables/HTML/inline images
  highlights:      string;              // free-form (prose, bullets, or mixed)
  color:           string | null;       // specific colour name(s), comma-separated
  color_family:    string | null;       // base colour from common Jumia families
  weight_kg:       number | null;       // only if visible on packaging
  main_material:   string | null;       // e.g. "Plastic", "Aluminium"
  material_family: string | null;       // e.g. "Plastic", "Metal", "Fabric"
  // ── AI-defaulted (overridable by seller's "What do you want in the
  // listing" text). Per May 2026 rule update these are no longer
  // seller-required — AI fills with stable defaults unless the seller's
  // userContext says otherwise.
  model:              string | null;    // model number/name if confident
  warranty_duration:  string | null;    // default "None"
  warranty_text:      string | null;    // default "N/A"
  warranty_address:   string | null;    // default "N/A"
  production_country: string | null;    // AI picks based on general knowledge
  /**
   * Short phrase describing what the product is FOR — e.g. "agricultural
   * pesticide spraying", "household carpet cleaning", "office stationery".
   * Threads into the retrieval query AND the rank prompt so we don't
   * confuse visually-similar products (e.g. farm sprayer vs carpet
   * cleaner pump — both have a tank + nozzle, very different categories).
   */
  intended_use_case: string | null;
  /**
   * Where the product is typically used. Constrained vocabulary so the
   * downstream rank pass can match it cleanly against category paths
   * like "Garden & Outdoors / Farm & Ranch".
   */
  environment: "home" | "farm" | "garden" | "office" | "workshop" | "industrial" | "outdoor" | "personal" | "unknown" | null;
  /**
   * Distinct variants visible in the images. Empty when the listing
   * shows a single product; populated when the images show e.g. a
   * garden-tool set ("3 Set", "Hoe only", "Trowel only") or a
   * multi-pack ("Pack of 6", "Pack of 12"). Auto-analyze writes these
   * into the variants table so the seller sees each as its own card
   * on the review page and can edit/add more.
   */
  variations:      Array<{ label: string; sku_suffix: string }>;
}

const VALID_ENVIRONMENTS = new Set([
  "home", "farm", "garden", "office", "workshop",
  "industrial", "outdoor", "personal", "unknown",
] as const);
type Environment = NonNullable<ProductDescription["environment"]>;

export async function aiPassA_describeProduct(
  imageUrls: string[],
  userContext?: string | null,   // free-text from the seller, e.g. "this is a pack of 6, teal not blue"
  // forceBestModel: bypass the tier ladder and force Gemini 2.5 Pro
  // for every user. Used by the listing analyze pipeline to give Free
  // sellers the same quality as Business sellers on the only flow that
  // is currently active. Falls through to the global fallback chain
  // if the premium model errors.
  opts: { forceBestModel?: boolean } = {},
): Promise<ProductDescription> {
  if (!imageUrls.length) throw new Error("No images provided");
  if (USE_MOCK_AI) {
    return {
      title: "Mock Product", brand: null, keywords: ["mock"], summary: "Mock product.",
      description: "Mock description filler text for development.", highlights: "• mock\n• mock\n• mock\n• mock",
      color: null, color_family: null, weight_kg: null, main_material: null, material_family: null,
      intended_use_case: null, environment: "unknown",
      variations: [],
      // AI-defaulted fields (May 2026)
      model: null,
      warranty_duration:  AI_FIELD_DEFAULTS.warranty_duration,
      warranty_text:      AI_FIELD_DEFAULTS.warranty_text,
      warranty_address:   AI_FIELD_DEFAULTS.warranty_address,
      production_country: "China",
    };
  }
  if (!process.env.GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY is not set.");

  // Tier-aware model selection (Free → Lite, Paid → Flash, Business → Pro).
  // When forceBestModel is set, every caller gets Gemini 2.5 Pro.
  const { userId } = await auth();
  const visionModel = await resolveModel(userId, "vision", { forceBestModel: opts.forceBestModel });

  // The full Jumia content policy — includes the verbatim banned-words
  // instruction, so we don't need restrictedInstr separately here.
  // We don't yet know the category (Pass A IS the describe-pass), so we
  // leave categoryPath null and let the policy use the default white-
  // background rules. Fashion-specific tone gets applied automatically
  // on Pass C once the category is picked.
  const policyBlock = buildContentPolicyInstructions({
    categoryPath:      null,
    includeImageRules: true,
  });

  const ctxSection = userContext && userContext.trim()
    ? `\n\nSELLER CONTEXT (treat this as authoritative for anything the images don't show):\n"${userContext.trim()}"\n`
    : "";

  // Same Description/Highlights writing-style rules the Chrome extension's
  // fill prompt uses (lib/ai/content-style-rules.ts) — rich HTML, tables
  // where they genuinely fit, minimum-length floors, "Perfect for:" closer,
  // and the rest — so a listing reads the same whether it was drafted via
  // the extension, the web upload flow, or WhatsApp. The mechanical rules
  // further down (bullet-per-line, HTML tags allowed, Jumia's 50-char
  // floor) still apply on top of this; this block sets the quality bar.
  const contentStyleBlock = buildDescriptionAndHighlightsStyleBlock();

  const prompt = `You are a product-listing assistant for Jumia. Look at the product images and return a JSON object that fills every visible product attribute.

${policyBlock}
${contentStyleBlock}
CRITICAL — ENVIRONMENT & USE CASE:
Pay special attention to ENVIRONMENT and PRIMARY USE CASE. A pump-and-tank
that looks visually similar to a carpet cleaner is a *sprayer* if it's intended
for outdoor/farm use. Look for spray nozzles vs cleaning brushes/heads, hose
endings, container labels, and contextual clues in the images (background,
accessories, packaging text). Use environment = "unknown" if you genuinely
can't tell — don't guess between farm and home when both are plausible. The
downstream category picker depends on these two fields to disambiguate
visually-similar products that live in very different parts of the catalogue.

Rules:
- title: Concise product name (model + product type + key specs, e.g. "WH-1000XM5 Wireless Noise-Cancelling Headphones" — note the BRAND "Sony" is OMITTED; brand goes in the brand field, NOT the title; Jumia rejects "Product name contains Brand name"). 5-12 words ideal but length is flexible. NO category names like "headphones for sale".
- brand: ONLY fill if a brand logo or wordmark is clearly visible AND you are confident. Otherwise null.
- keywords: 5-10 single-word lower-case keywords (no quotes, no underscores). Think of what a buyer would search for.
- summary: One sentence describing what the product is and its key visible features.
- description: LENGTH AND SHAPE ARE GOVERNED BY THE CONTENT STYLE BLOCK ABOVE — obey its minimum, and treat its guidance on tables and structure as instructions, not permissions. The only hard ceiling is 8000 characters including markup. Safe HTML tags (<p>, <ul>, <li>, <table>, <tr>, <td>, <br>, <strong>, <em>, <img>) are permitted; inline <img> with full URLs is allowed for spec diagrams or size charts. Marketing/promotional language is permitted ("premium", "best-in-class", "perfect for").
- highlights: LENGTH AND SHAPE ARE GOVERNED BY THE CONTENT STYLE BLOCK ABOVE — obey its minimum there too. No word limit per line. CRITICAL: when bullets are used, EVERY bullet MUST be on its OWN LINE — separate bullets with the newline character "\\n", never run them together in one paragraph. Prefer HTML lists for clean rendering: wrap bullets in <ul><li>…</li><li>…</li></ul>. Examples of CORRECT: "• Item 1\\n• Item 2\\n• Item 3" OR "<ul><li>Item 1</li><li>Item 2</li><li>Item 3</li></ul>". Example of WRONG (do not produce): "• Item 1 • Item 2 • Item 3" all on one line.
- color: Specific visible colour(s). Multiple colours separated by commas (e.g. "Blue, Black"). Null if uncertain.
- color_family: Base colour family from {Black, White, Grey, Brown, Beige, Red, Orange, Yellow, Green, Blue, Purple, Pink, Multicolour}. Null if uncertain.
- weight_kg: STRICTLY a number — nothing else. Examples of VALID values: 0.5, 1.2, 12.5. Examples of INVALID values you must NEVER return: "0.5 (estimated)", "approx 0.5", "0.5 kg", "0.5kg", "around 1.2", "unknown". If you can't see or confidently infer the weight, return null — not a guess wrapped in parentheses. The downstream form is a number-only input; any text you put here will be stripped or break the field.
- main_material: e.g. "Plastic", "Stainless Steel", "Cotton". Null if uncertain.
- material_family: e.g. "Plastic", "Metal", "Fabric", "Wood", "Glass". Null if uncertain.
- model: Product model number/name if visible on the packaging or product itself (e.g. "WH-1000XM5", "Galaxy A15"). Null if not visible.
- warranty_duration: "${AI_FIELD_DEFAULTS.warranty_duration}" by default. Override only if the seller's "What do you want in the listing" text mentions a real warranty period.
- warranty_text: "${AI_FIELD_DEFAULTS.warranty_text}" by default. Override only if the seller's text describes the warranty terms.
- warranty_address: "${AI_FIELD_DEFAULTS.warranty_address}" by default. Override only if the seller's text gives a real warranty address.
- production_country: Pick based on general knowledge — country of likely manufacture for this product/brand (e.g. "China" for unbranded electronics, "Vietnam" for many sneakers, "Ghana" for hand-made local goods, "USA" for many Apple products, "Germany" for many automotive accessories). Use the country name in English. Override the default with whatever country the seller's text specifies if any.
- intended_use_case: Short phrase identifying what the product is FOR — e.g. "agricultural pesticide spraying", "household carpet cleaning", "office stationery", "outdoor camping". Null only if completely unclear.
- environment: Exactly one of {home, farm, garden, office, workshop, industrial, outdoor, personal, unknown}. "home" = lived-in indoor spaces. "farm" = agriculture / ranch / crops. "garden" = backyard / lawn / small-scale outdoor plant care. "workshop" = handyman / DIY / hobby builds. "industrial" = factory / commercial scale. "outdoor" = recreation outside the home (camping, sports). "personal" = items worn or carried on the body (clothing, accessories). Use "unknown" instead of guessing.
- variations: Distinct product variants. Two ways to populate this, and the seller's text WINS whenever it says anything about variants:
    1. The seller's text explicitly states the variant options (e.g. "comes in red, blue and green", "sizes S/M/L available", "this one is the red version") — use EXACTLY what they said, verbatim as the label, even if the images only show one of them. Do not second-guess or expand on it; the seller knows their own stock better than the photo does. If the seller states only ONE variant (e.g. "the variation is red" — a single-SKU listing that just needs its option named), treat that single stated value as the whole variations list, not multiple variants that don't exist.
    2. No seller text about variants — fall back to what the images show, and be CONSERVATIVE: only populate when the images clearly show multiple choices the buyer can pick between.
    IMPORTANT: these are the only two cases. If the seller's text is clearly TRYING to say something about which options are or aren't available/in stock, but it's garbled, ambiguous, or you can't confidently extract a clean list from it (typos, broken grammar, a phrase that doesn't map cleanly to any colour/size you can see), do NOT fall back to case 2 and invent variants from the photo instead — a catalogue/stock photo showing several colour options does not mean the seller actually stocks all of them. Treat this the same as case 1 with only a partial, low-confidence read: include ONLY the specific option(s) you're genuinely confident the text confirms (could be zero), never pad the rest out from the image. Getting a seller's stock availability wrong on a live marketplace is worse than asking them to add variants manually.
    Examples of when to populate from images alone:
      * Garden tool set with separate pieces shown: ["3 Set (Trowel, Fork & Cultivator)", "Hoe only", "Trowel only", "Fork only"]
      * Spice multipack: ["Pack of 3", "Pack of 6", "Pack of 12"]
      * Phone case in multiple colours laid out: ["Black", "Navy Blue", "Rose Gold"]
      * Apparel in sizes: ["Small", "Medium", "Large"]
    Leave EMPTY ([]) when neither of the above applies:
      * One product shown from multiple angles, no seller text about variants
      * Product has one colour / one size / one configuration, no seller text about variants
      * Unsure
    Each variation needs: label (what the buyer sees, e.g. "Pack of 6", or the seller's own wording verbatim) and sku_suffix (short uppercase alphanumeric, e.g. "P6", "HOE", "3SET", "RED" — used as a unique tag appended to the parent SKU).

IMPORTANT — All defaults above are OVERRIDDEN by the seller's "What do you want in the listing" text below. If they mention a warranty, country, or any other field-specific override, use their version instead.

${ctxSection}

Return ONLY valid JSON. No markdown, no commentary:
{
  "title": "...",
  "brand": null,
  "keywords": ["..."],
  "summary": "...",
  "description": "...",
  "highlights": "...",
  "color": null,
  "color_family": null,
  "weight_kg": null,  // ⚠ NUMBER OR null ONLY — never strings, units, or parentheticals like "0.5 (estimated)".
  "main_material": null,
  "material_family": null,
  "model": null,
  "warranty_duration": "${AI_FIELD_DEFAULTS.warranty_duration}",
  "warranty_text": "${AI_FIELD_DEFAULTS.warranty_text}",
  "warranty_address": "${AI_FIELD_DEFAULTS.warranty_address}",
  "production_country": "China",
  "intended_use_case": null,
  "environment": "unknown",
  "variations": []
}`;

  let parsed: Record<string, unknown>;
  try {
    const raw = await callGemini(prompt, imageUrls, visionModel);
    parsed = parseAIResponse(raw);
  } catch (e) {
    throw new Error(`Describe pass failed: ${(e as Error).message}`);
  }

  const keywords = Array.isArray(parsed.keywords)
    ? (parsed.keywords as unknown[]).map((k) => String(k).toLowerCase().trim()).filter(Boolean)
    : [];

  // Post-filter: strip any Jumia-restricted words the model snuck through
  // despite the prompt. Belt-and-braces — safer than trusting the prompt.
  const clean = (s: string | null): string => stripRestrictedWords(s ?? "");
  const cleanOrNull = (s: string | null): string | null => {
    const v = clean(s);
    return v ? v : null;
  };

  // Logging helps catch model drift / new restricted-word patterns
  const stripped = [
    findRestrictedWords(String(parsed.title ?? "")),
    findRestrictedWords(String(parsed.description ?? "")),
    findRestrictedWords(String(parsed.highlights ?? "")),
  ].flat();
  if (stripped.length > 0) {
    console.warn(`[AI Pass A] stripped restricted words: ${stripped.join(", ")}`);
  }

  // Parse + sanitise variations. Each entry needs a non-empty label;
  // sku_suffix defaults to a short slug of the label if the model omits
  // it. Cap at 20 entries to defend against runaway hallucination.
  const rawVariations = Array.isArray(parsed.variations) ? parsed.variations : [];
  const variations = (rawVariations as Array<Record<string, unknown>>)
    .slice(0, 20)
    .map((v) => {
      const label = clean(String(v?.label ?? "").trim());
      if (!label) return null;
      const rawSuffix = String(v?.sku_suffix ?? "").trim();
      const sku_suffix = rawSuffix
        ? rawSuffix.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8) || "V"
        : label.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6) || "V";
      return { label, sku_suffix };
    })
    .filter((v): v is { label: string; sku_suffix: string } => v !== null);

  // Parse + validate the environment field — anything outside the
  // controlled vocabulary collapses to null so the rank pass doesn't
  // see junk like "garage" or "vehicle".
  const rawEnv = String(parsed.environment ?? "").toLowerCase().trim() as Environment | "";
  const environment: ProductDescription["environment"] =
    rawEnv && VALID_ENVIRONMENTS.has(rawEnv as Environment) ? (rawEnv as Environment) : null;

  // Pass-A title scrub. Same logic as buildCoreResult — strip the brand
  // out of the title before persisting, even if the model slipped it in
  // despite the policy block. The Pass-A brand is what the model
  // claimed, not necessarily the field that ends up on the listing —
  // we strip whichever brand it returned so we cover both the "AI
  // proposed Samsung" case (brand survives later) and the "AI proposed
  // Samsung but it gets downgraded" case (brand becomes Generic but
  // the title still had Samsung).
  const passAFinalBrand   = cleanOrNull(strOrNull(parsed.brand));
  const passARawTitle     = clean(String(parsed.title ?? "").trim());
  const passACleanedTitle = stripBrandFromTitle(passARawTitle, passAFinalBrand);
  if (passACleanedTitle !== passARawTitle && passAFinalBrand) {
    console.info(
      `[Pass A] stripped brand "${passAFinalBrand}" from title — was "${passARawTitle}", now "${passACleanedTitle}".`,
    );
  }

  return {
    title:             passACleanedTitle || passARawTitle || "Unknown product",
    brand:             passAFinalBrand,
    keywords:          keywords.slice(0, 10),
    summary:           clean(String(parsed.summary ?? "").trim()),
    description:       clean(String(parsed.description ?? "").trim()),
    highlights:        clean(String(parsed.highlights ?? "").trim()),
    color:             cleanOrNull(strOrNull(parsed.color)),
    color_family:      cleanOrNull(strOrNull(parsed.color_family)),
    weight_kg:         parsed.weight_kg != null && parsed.weight_kg !== "null"
                         ? Number(parsed.weight_kg) || null
                         : null,
    main_material:     cleanOrNull(strOrNull(parsed.main_material)),
    material_family:   cleanOrNull(strOrNull(parsed.material_family)),
    // ── AI-defaulted fields (overridable via userContext / "What do you
    // want in the listing" text). Fall back to the centrally-defined
    // defaults if the model didn't return anything.
    model:              cleanOrNull(strOrNull(parsed.model)),
    warranty_duration:  cleanOrNull(strOrNull(parsed.warranty_duration))  ?? AI_FIELD_DEFAULTS.warranty_duration,
    warranty_text:      cleanOrNull(strOrNull(parsed.warranty_text))      ?? AI_FIELD_DEFAULTS.warranty_text,
    warranty_address:   cleanOrNull(strOrNull(parsed.warranty_address))   ?? AI_FIELD_DEFAULTS.warranty_address,
    production_country: cleanOrNull(strOrNull(parsed.production_country)),  // AI picks; null only if it can't decide
    intended_use_case:  cleanOrNull(strOrNull(parsed.intended_use_case)),
    environment,
    variations,
  };
}

// ─── Pass B0: pick a top-level department ────────────────────────────────────
//
// Runs BEFORE retrieval — see auto-analyze.ts's category-resolution section
// for the full rationale. A small, cheap, fast decision among ~20-40 broad
// departments (no retrieval, no candidate list to build), used to scope the
// fuzzy search that produces Pass B's actual candidates to one department's
// subtree instead of the full ~27k-row catalog. Confirmed live: without this,
// a full-catalog retrieval miss used to fall back to a blind alphabetical
// slice of the whole catalog — how a safety helmet got filed under "Laptops".

export interface DepartmentPick {
  name:       string;
  path:       string;
  confidence: number;
}

export interface DepartmentPickResult {
  primary:    DepartmentPick | null;
  alternates: DepartmentPick[];
}

export async function aiPassB0_pickDepartment(
  imageUrls:   string[],
  departments: Array<{ name: string; path: string }>,
  userContext?: string | null,
  useCase?:    string | null,
  environment?: ProductDescription["environment"],
  opts: { forceBestModel?: boolean } = {},
): Promise<DepartmentPickResult> {
  if (departments.length === 0) return { primary: null, alternates: [] };
  if (!imageUrls.length) {
    const d = departments[0];
    return { primary: { ...d, confidence: 0.3 }, alternates: [] };
  }
  if (USE_MOCK_AI) {
    const d = departments[0];
    return { primary: { ...d, confidence: 0.9 }, alternates: [] };
  }
  if (!process.env.GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY is not set.");

  const { userId: deptUserId } = await auth();
  const deptVisionModel = await resolveModel(deptUserId, "vision", { forceBestModel: opts.forceBestModel });

  const list = departments.map((d, i) => `${i + 1}. ${d.name}`).join("\n");

  const ctxSection = userContext && userContext.trim()
    ? `\n\nSELLER CONTEXT (treat as authoritative for what the images don't show):\n"${userContext.trim()}"\n`
    : "";
  const useCaseBlock = useCase || (environment && environment !== "unknown")
    ? `\nPRIMARY USE CASE: ${useCase ?? "(not specified)"}\nENVIRONMENT: ${environment ?? "unknown"}\n`
    : "";

  const prompt = `You are a Jumia marketplace classification expert. Look at the product images and pick the ONE top-level department this product's specific category would live under — this is a broad first step, not the final category.

DEPARTMENTS:
${list}
${useCaseBlock}
Rules:
1. Pick exactly one department name from the list above, copied verbatim.
2. List up to 2 alternate departments in case the primary is wrong (e.g. a product that could plausibly sit in more than one department).
3. Confidence is 0..1 — be honest, use 0.5 or below if genuinely torn between departments.
${ctxSection}
Return ONLY valid JSON, no markdown:
{
  "primary_department": "<exact name from the list>",
  "primary_confidence": 0.0,
  "alternates": ["<name>", "<name>"],
  "reasoning": "one-line explanation"
}`;

  let parsed: Record<string, unknown>;
  try {
    const raw = await callGemini(prompt, imageUrls, deptVisionModel);
    parsed = parseAIResponse(raw);
  } catch (e) {
    throw new Error(`Department pick failed: ${(e as Error).message}`);
  }

  const byName = new Map(departments.map((d) => [d.name, d]));
  const resolve = (rawName: unknown, rawConf?: unknown): DepartmentPick | null => {
    const d = byName.get(String(rawName ?? ""));
    if (!d) return null;
    return { ...d, confidence: Math.max(0, Math.min(1, Number(rawConf ?? 0.5))) };
  };

  const primary = resolve(parsed.primary_department, parsed.primary_confidence);
  const rawAlts = Array.isArray(parsed.alternates) ? (parsed.alternates as unknown[]) : [];
  const alternates = rawAlts
    .map((n) => resolve(n))
    .filter((d): d is DepartmentPick => d !== null && (primary == null || d.name !== primary.name))
    .slice(0, 2);

  return { primary, alternates };
}

// ─── Pass B: rank candidates ────────────────────────────────────────────────
//
// Second AI call. Given the original images and a small (5-8) list of
// candidate leaf categories from the retrieval step, asks the model to pick
// the single best fit with confidence + 2 alternates. This is consistently
// 90%+ accurate vs ~70% for 1-of-200 free-form classification.

export interface RankedCategory {
  code:       number;
  name:       string;
  path:       string;
  confidence: number;
}

export interface RankingResult {
  primary:                RankedCategory | null;
  alternates:             RankedCategory[];
  needsUserConfirmation:  boolean;
}

export async function aiPassB_rankCategory(
  imageUrls:  string[],
  candidates: Array<{ code: number; name: string; path: string }>,
  userContext?: string | null,
  // From Pass A — anchors the rank model so it disambiguates
  // visually-similar candidates by what the product is actually FOR.
  useCase?: string | null,
  environment?: ProductDescription["environment"],
  // Force the premium model across all tiers (see Pass A for rationale).
  opts: { forceBestModel?: boolean } = {},
): Promise<RankingResult> {
  if (candidates.length === 0) {
    return { primary: null, alternates: [], needsUserConfirmation: true };
  }
  if (!imageUrls.length) {
    // No images — return the first candidate without ranking
    const c = candidates[0];
    return {
      primary:               { ...c, confidence: 0.5 },
      alternates:            candidates.slice(1, 3).map((x) => ({ ...x, confidence: 0.3 })),
      needsUserConfirmation: true,
    };
  }
  if (USE_MOCK_AI) {
    const c = candidates[0];
    return {
      primary: { ...c, confidence: 0.9 },
      alternates: candidates.slice(1, 3).map((x) => ({ ...x, confidence: 0.4 })),
      needsUserConfirmation: false,
    };
  }
  if (!process.env.GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY is not set.");

  // Tier-aware model selection — Pass B is a vision call.
  const { userId: rankUserId } = await auth();
  const rankVisionModel = await resolveModel(rankUserId, "vision", { forceBestModel: opts.forceBestModel });

  const candidateList = candidates
    .map((c, i) => `${i + 1}. ${c.code} — ${c.path}`)
    .join("\n");

  const ctxSection = userContext && userContext.trim()
    ? `\n\nSELLER CONTEXT (treat as authoritative for what the images don't show — may bias the category choice):\n"${userContext.trim()}"\n`
    : "";

  // Pass-A's use case + environment anchor the disambiguation rule below.
  // Without these the rank pass falls back to pure visual similarity,
  // which is how a farm sprayer gets filed under carpet cleaners.
  const useCaseBlock =
    useCase || (environment && environment !== "unknown")
      ? `\nPRIMARY USE CASE: ${useCase ?? "(not specified)"}\nENVIRONMENT: ${environment ?? "unknown"}\n`
      : "";

  const prompt = `You are a Jumia category classification expert. Look at the product images and pick the single best Jumia listable category for them from the candidates below. Candidates can be either leaves or listable parents — both are valid choices.

CANDIDATES:
${candidateList}
${useCaseBlock}
Rules:
1. Pick exactly one as the primary (the best match).
2. List up to 2 alternates in case the primary is wrong.
3. Confidence is 0..1. Be honest — use 0.5 or below if you're unsure.
4. You MUST choose from the candidates above. Do not invent new codes.
5. When two candidates look visually similar (e.g. carpet cleaner vs farm sprayer, yoga mat vs camping mat, kitchen knife vs hunting knife), pick the one whose path matches the PRIMARY USE CASE and ENVIRONMENT above. Visual similarity alone is not enough — a handheld pump-and-tank used on a farm belongs under Agriculture, not Home Cleaning.
6. Jumia QC ALWAYS rejects wrong-category listings. Phone cases must NOT be filed under Mobile Phones; they belong in Mobile Accessories > Phone Cases. Headphone cables go under Audio Accessories, not Headphones. Pick the leaf or listable parent whose path matches the product's primary identity, not its parent category.
7. If the visible brand is a luxury / restricted brand (Rolex, Gucci, Bose, MAC, Ray-Ban, Yeezy, Chanel etc.) the seller will likely fail brand-permission QC regardless of the category you pick — but pick the category accurately anyway; the brand-permission flag is handled separately downstream.
${ctxSection}
Return ONLY valid JSON, no markdown:
{
  "primary_code":       <number from the list>,
  "primary_confidence": 0.0,
  "alternates": [
    { "code": <number>, "confidence": 0.0 },
    { "code": <number>, "confidence": 0.0 }
  ],
  "reasoning": "one-line explanation"
}`;

  let parsed: Record<string, unknown>;
  try {
    const raw = await callGemini(prompt, imageUrls, rankVisionModel);
    parsed = parseAIResponse(raw);
  } catch (e) {
    throw new Error(`Rank pass failed: ${(e as Error).message}`);
  }

  const codeToCandidate = new Map(candidates.map((c) => [c.code, c]));

  const resolve = (rawCode: unknown, rawConf: unknown): RankedCategory | null => {
    const code = Number(rawCode);
    const conf = Math.max(0, Math.min(1, Number(rawConf ?? 0)));
    const cand = codeToCandidate.get(code);
    if (!cand) return null;
    return { ...cand, confidence: conf };
  };

  const primary = resolve(parsed.primary_code, parsed.primary_confidence);
  const rawAlts = Array.isArray(parsed.alternates) ? (parsed.alternates as Array<Record<string, unknown>>) : [];
  const alternates = rawAlts
    .map((a) => resolve(a.code, a.confidence))
    .filter((a): a is RankedCategory => a !== null && (primary == null || a.code !== primary.code))
    .slice(0, 2);

  const top1 = primary?.confidence ?? 0;
  const top2 = alternates[0]?.confidence ?? 0;
  const needsUserConfirmation = top1 < 0.75 || (top1 - top2) < 0.15;

  return { primary, alternates, needsUserConfirmation };
}

export async function extractAttributesForCategory(
  imageUrls:    string[],
  categoryCode: number,
  userContext?: string | null,
  // Force the premium model across all tiers (see Pass A for rationale).
  opts: { forceBestModel?: boolean } = {},
): Promise<{
  dynamic_attributes: Record<string, string>;
  field_sources:      Record<string, "ai">;
  field_confidence:   AIProductAnalysis["field_confidence"];
}> {
  if (!imageUrls.length) {
    return { dynamic_attributes: {}, field_sources: {}, field_confidence: {} };
  }

  if (USE_MOCK_AI) {
    return { dynamic_attributes: {}, field_sources: {}, field_confidence: {} };
  }
  if (!process.env.GOOGLE_API_KEY) {
    throw new Error("GOOGLE_API_KEY is not set.");
  }

  const attrs = await getCategoryAttributes(categoryCode);
  if (attrs.length === 0) {
    return { dynamic_attributes: {}, field_sources: {}, field_confidence: {} };
  }

  // Filter out fields the AI must NEVER fill (price, stock, gtin, etc.)
  const inferableAttrs = attrs.filter((a) => !SELLER_REQUIRED_ATTR_KEYS.has(a.name.toLowerCase()));

  const attrLines = inferableAttrs.map((a) => {
    const valStr = a.allowed_values.length
      ? ` (allowed values: ${a.allowed_values.join(", ")})`
      : "";
    return `  - ${a.name}: ${a.label}${valStr}${a.required ? " [REQUIRED]" : ""}`;
  }).join("\n");

  const ctxSection = userContext && userContext.trim()
    ? `\n\nSELLER CONTEXT (treat as authoritative — these are things the seller knows that the images don't show, e.g. pack size, variant, exact spec):\n"${userContext.trim()}"\n`
    : "";

  // Tier-aware model selection — Pass C is a vision call.
  const { userId: attrUserId } = await auth();
  const attrVisionModel = await resolveModel(attrUserId, "vision", { forceBestModel: opts.forceBestModel });

  // Look up the category path so the policy block can specialise its
  // image rules (Fashion vs everything else). One extra DB hit per Pass
  // C — cheap, and the row is almost certainly already in Supabase's
  // PostgREST cache from earlier in the request.
  const categoryMeta = await getCategoryByCode(categoryCode);
  const policyBlock = buildContentPolicyInstructions({
    categoryPath:      categoryMeta?.path ?? null,
    includeImageRules: true,
  });

  const prompt = `You are a Jumia product-listing assistant. Look at the product images and fill ONLY the attributes listed below for the category. Return a SINGLE JSON object.

${policyBlock}

CATEGORY ATTRIBUTES TO FILL (use the exact attribute names as keys):
${attrLines}

RULES:
1. Use the exact attribute name as the JSON key.
2. For attributes with allowed values, pick exactly one value from the list (or null if unsure). NEVER invent a value outside the allowed list.
3. Skip / set null for fields you can't determine from the images. NEVER guess price, model, brand (unless logo clearly visible), or warranty terms.
4. Return only attributes you could fill — omit ones you're not sure about.
5. Any attribute value you produce MUST follow the JUMIA CONTENT POLICY above — strip restricted words, never write banned terms ("original", "imported", "brand new", etc.), never invent specs the images don't show.
6. If an attribute below is about package/box contents (named something like "what's in the box", "package contents", "box contents") and the seller's context states what's included, use EXACTLY what they said — formatted as a multi-line list, one item per line, each starting with a count like "1x", "2x" (e.g. "1x Drone\\n1x Remote Controller\\n2x Batteries"). The seller's own answer always wins over guessing from the images.
${ctxSection}
Return ONLY valid JSON, no markdown:
{
  "attributes": {
    "attribute_name": "value"
  }
}`;

  let parsed: Record<string, unknown>;
  try {
    const raw = await callGemini(prompt, imageUrls, attrVisionModel);
    parsed = parseAIResponse(raw);
  } catch (e) {
    console.error("[AI] extractAttributesForCategory failed:", (e as Error).message);
    return { dynamic_attributes: {}, field_sources: {}, field_confidence: {} };
  }

  // Clean + apply seller-required guard
  const rawAttrs = (parsed.attributes ?? parsed) as Record<string, unknown>;
  const dynamic_attributes: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawAttrs)) {
    if (SELLER_REQUIRED_ATTR_KEYS.has(k.toLowerCase())) continue;
    if (v == null || String(v).trim() === "" || String(v).toLowerCase() === "null") continue;
    dynamic_attributes[k] = String(v).trim();
  }

  // Layer in the AI-defaulted attribute values (product_note,
  // from_the_manufacturer). If the AI already filled them with real
  // content — possibly because the seller's userContext said so —
  // keep what the AI returned. Otherwise pad with the defaults so
  // every listing has the customer-feedback note + manufacturer
  // placeholder. Categories that don't accept these attribute names
  // will silently drop them at push time.
  for (const [k, defaultVal] of Object.entries(AI_DYNAMIC_ATTR_DEFAULTS)) {
    if (!dynamic_attributes[k] || dynamic_attributes[k].length === 0) {
      dynamic_attributes[k] = defaultVal;
    }
  }

  const field_sources:    Record<string, "ai"> = {};
  const field_confidence: AIProductAnalysis["field_confidence"] = {};
  for (const k of Object.keys(dynamic_attributes)) {
    field_sources[`dynamic_attributes.${k}`]    = "ai";
    field_confidence[`dynamic_attributes.${k}`] = { confidence: 0.8, source: "inferred" };
  }

  return { dynamic_attributes, field_sources, field_confidence };
}

// ─── Combined Pass B + Pass C ────────────────────────────────────────────────
//
// One Gemini call that picks a category AND fills its attributes — replaces
// the old two-call sequence (aiPassB_rankCategory followed by
// extractAttributesForCategory).
//
// Why combine: each Gemini round-trip is the dominant cost in the analyze
// pipeline (~5-12s with Flash Lite, more with Pro). Folding two calls into
// one shaves roughly one round-trip per analyze (~5-8s typical), plus we
// dodge the schema-fetch round-trip that used to sit between B and C
// because we pre-fetch all candidate schemas in parallel upstream.
//
// Caller contract (auto-analyze route):
//   1. Pick the top 3 candidates from retrieval.
//   2. Fetch their attribute schemas in parallel (Promise.all over
//      getCategoryAttributes; fall back to fetchAttributesFromJumia for
//      uncached categories) — schemas typically cached, so this is cheap.
//   3. Pass the candidate + schema pairs here.
//
// Validation: if the model picks a code that's NOT in the candidate set,
// we reject the response and the caller falls back to the old separate-
// Pass B + Pass C flow as a safety net.
//
// On Gemini failure, we DON'T throw — return an empty PickAndFillResult
// with primary=null + needsUserConfirmation=true so the caller can
// gracefully drop to the fallback path. Throws are reserved for hard
// errors (API key missing, network completely down).

export interface CandidateWithSchema {
  code:   number;
  name:   string;
  path:   string;
  attrs:  JumiaCategoryAttribute[];
}

export interface PickAndFillResult {
  primary:                RankedCategory | null;
  alternates:             RankedCategory[];
  needsUserConfirmation:  boolean;
  dynamic_attributes:     Record<string, string>;
  field_sources:          Record<string, "ai">;
  field_confidence:       AIProductAnalysis["field_confidence"];
  /** True when the Gemini call returned a valid response we could use. */
  ok:                     boolean;
  /**
   * The model looked at the candidates and said none of them actually fit
   * this product. Distinct from ok:false (the call failed): retrying with
   * the separate Pass B would just force the same bad pick, since it has
   * the same candidates and no way to decline either. The caller should
   * hand the category choice back to the seller instead.
   */
  noCandidateFits?:       boolean;
}

export async function aiPassBC_pickAndFill(
  imageUrls: string[],
  candidates: CandidateWithSchema[],
  userContext?: string | null,
  useCase?: string | null,
  environment?: ProductDescription["environment"],
  opts: { forceBestModel?: boolean } = {},
): Promise<PickAndFillResult> {
  const empty = (ok: boolean): PickAndFillResult => ({
    primary:               null,
    alternates:            [],
    needsUserConfirmation: true,
    dynamic_attributes:    {},
    field_sources:         {},
    field_confidence:      {},
    ok,
  });

  if (candidates.length === 0) return empty(false);

  if (!imageUrls.length) {
    // No images — return the first candidate without ranking, no attrs.
    const c = candidates[0];
    return {
      primary:               { code: c.code, name: c.name, path: c.path, confidence: 0.5 },
      alternates:            candidates.slice(1, 3).map((x) => ({
        code: x.code, name: x.name, path: x.path, confidence: 0.3,
      })),
      needsUserConfirmation: true,
      dynamic_attributes:    {},
      field_sources:         {},
      field_confidence:      {},
      ok:                    true,
    };
  }

  if (USE_MOCK_AI) {
    const c = candidates[0];
    return {
      primary:               { code: c.code, name: c.name, path: c.path, confidence: 0.9 },
      alternates:            candidates.slice(1, 3).map((x) => ({
        code: x.code, name: x.name, path: x.path, confidence: 0.4,
      })),
      needsUserConfirmation: false,
      dynamic_attributes:    {},
      field_sources:         {},
      field_confidence:      {},
      ok:                    true,
    };
  }

  if (!process.env.GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY is not set.");

  const { userId } = await auth();
  const visionModel = await resolveModel(userId, "vision", { forceBestModel: opts.forceBestModel });

  // Cap schemas at the first 20 inferable attributes per candidate so the
  // prompt stays under control even for huge categories like Smartphones
  // (which has 40+ attributes). Most listings rarely need to fill more
  // than 10-15 anyway — required attributes are usually a handful.
  const MAX_ATTRS_PER_CANDIDATE = 20;

  const candidateBlocks = candidates.map((c, i) => {
    const inferable = c.attrs.filter((a) => !SELLER_REQUIRED_ATTR_KEYS.has(a.name.toLowerCase()));
    // Required attributes float to the top so the model always sees them.
    const sorted = inferable.sort((a, b) => (b.required ? 1 : 0) - (a.required ? 1 : 0));
    const trimmed = sorted.slice(0, MAX_ATTRS_PER_CANDIDATE);
    const attrLines = trimmed.length === 0
      ? "    (no inferable attributes)"
      : trimmed.map((a) => {
          const valStr = a.allowed_values.length
            ? ` (allowed: ${a.allowed_values.slice(0, 12).join(", ")}${a.allowed_values.length > 12 ? ", …" : ""})`
            : "";
          return `    - ${a.name}: ${a.label}${valStr}${a.required ? " [REQUIRED]" : ""}`;
        }).join("\n");

    return `${i + 1}. CODE ${c.code} — ${c.path}\n${attrLines}`;
  }).join("\n\n");

  const ctxSection = userContext && userContext.trim()
    ? `\n\nSELLER CONTEXT (treat as authoritative for what the images don't show):\n"${userContext.trim()}"\n`
    : "";

  const useCaseBlock =
    useCase || (environment && environment !== "unknown")
      ? `\nPRIMARY USE CASE: ${useCase ?? "(not specified)"}\nENVIRONMENT: ${environment ?? "unknown"}\n`
      : "";

  // Use Pass C-style policy block (Fashion-vs-other image-rules tone) —
  // we don't know the chosen category yet, so pass null categoryPath
  // and the default white-background rules apply. Acceptable tradeoff
  // for the round-trip we're saving.
  const policyBlock = buildContentPolicyInstructions({
    categoryPath:      null,
    includeImageRules: true,
  });

  const prompt = `You are a Jumia listing assistant. In ONE response, do TWO things:

STEP 1 — Pick the best Jumia category from these candidates (each shows its attribute schema underneath):

${candidateBlocks}
${useCaseBlock}
STEP 2 — For YOUR CHOSEN category from Step 1, fill the attribute values you can determine from the images.

${policyBlock}

OUTPUT RULES:
1. chosen_code MUST be one of the candidate codes above, or null. Do not invent a code that isn't listed. These candidates came from a text search that can miss badly — if NONE of them is a genuine home for this product (e.g. the product is a wall-art print and the candidates are all kitchen utensils), set chosen_code to null and say why in reasoning. Do NOT settle for the least-wrong one: a listing the seller categorises themselves is far better than a confidently wrong category, which Jumia rejects outright. Only pick a candidate you'd actually defend as the right shelf for this product.
2. dynamic_attributes keys MUST be attribute names from your chosen category's list (the names shown after "- " on each schema line). NEVER include attributes from a different candidate.
3. For attributes with an allowed list, pick exactly one value from that list. Otherwise omit.
4. Skip any attribute you can't determine — null/omit is better than guessing. EXCEPT for required-by-Jumia fields where general online knowledge can give you a sensible answer (e.g. typical material for a known product line) — fill those with moderate confidence.
5. Disambiguate visually-similar candidates by PRIMARY USE CASE + ENVIRONMENT — a farm sprayer goes under Agriculture, not Home Cleaning.
6. Confidence is 0..1, and it means "how well does this category actually fit this product" — NOT "how sure am I this is the best of the three offered". If the best candidate is only a loose fit, that's a LOW confidence even when it's clearly better than the other two. Be honest. Set needsConfirmation=true if your top pick is below 0.75 OR within 0.15 of your second choice.
7. ALWAYS include these dynamic_attributes keys, even if the chosen category's schema doesn't list them (Jumia silently drops unknown keys; the cost of including is zero, the cost of omitting is a missed buyer-trust signal):
   - product_note: A short, friendly note thanking the buyer and asking for a review once they receive the item. The default is fine: "Dear Customer, once you receive your item, please take a moment to share your feedback and leave a review. Thank you for shopping with us!"
   - what_is_in_the_box: A real, product-specific MULTI-LINE LIST in Jumia's preferred format. EACH item is on its OWN LINE, starting with a count like "1x", "2x", etc. NEVER a single line / paragraph. NEVER just a number like "1". If the seller's context states what's included, use EXACTLY that (reformatted into this list style) — it always wins over guessing from images. Otherwise read the images for clues (charger? case? cable? manual?).
       CORRECT format examples (newline-separated, one item per line):
         "1x Smartphone\\n1x USB-C Charger\\n1x USB Cable\\n1x User Manual"
         "1x Drone\\n1x Remote Controller\\n2x Batteries\\n1x Charger\\n4x Spare Propellers\\n1x Carrying Case"
         "1x Volcano Humidifier\\n1x Power Adapter\\n1x User Manual"
       WRONG (do not produce):
         "1"                                      — just a digit
         "1x Smartphone 1x Charger 1x Manual"     — all on one line
         "Smartphone, charger, manual"            — missing counts
       If the image only shows the product itself with no accessories, default to:
         "1x [Product Name]\\n1x User Manual (if applicable)\\n1x Original Packaging"
       NEVER omit this field.
${ctxSection}
Return ONLY valid JSON, no markdown:
{
  "chosen_code":       <number from the list, or null if none genuinely fit>,
  "chosen_confidence": 0.0,
  "alternates": [
    { "code": <number>, "confidence": 0.0 }
  ],
  "needsConfirmation": false,
  "dynamic_attributes": {
    "attribute_name": "value"
  },
  "reasoning": "one-line explanation"
}`;

  let parsed: Record<string, unknown>;
  try {
    const raw = await callGemini(prompt, imageUrls, visionModel);
    parsed = parseAIResponse(raw);
  } catch (e) {
    console.warn(`[AI] aiPassBC_pickAndFill failed: ${(e as Error).message}`);
    return empty(false);
  }

  // ── Validate the response ───────────────────────────────────────────────
  const codeToCandidate = new Map(candidates.map((c) => [c.code, c]));

  // An explicit "none of these fit" (see OUTPUT RULE 1) — not a failure, and
  // deliberately NOT routed to the separate-passes fallback, which would
  // just force a pick from the same bad candidates.
  if (parsed.chosen_code === null || parsed.chosen_code === undefined) {
    console.info(
      `[AI] aiPassBC_pickAndFill: model declined all ${candidates.length} candidate(s) — ${String(parsed.reasoning ?? "no reason given")}`,
    );
    return { ...empty(true), noCandidateFits: true };
  }

  const chosenCode      = Number(parsed.chosen_code);
  const chosen          = codeToCandidate.get(chosenCode);

  if (!chosen) {
    console.warn(
      `[AI] aiPassBC_pickAndFill: model returned code ${chosenCode} not in candidates [${candidates.map((c) => c.code).join(", ")}].`,
    );
    return empty(false);
  }

  const primary: RankedCategory = {
    code:       chosen.code,
    name:       chosen.name,
    path:       chosen.path,
    confidence: Math.max(0, Math.min(1, Number(parsed.chosen_confidence ?? 0))),
  };

  const rawAlts = Array.isArray(parsed.alternates) ? (parsed.alternates as Array<Record<string, unknown>>) : [];
  const alternates: RankedCategory[] = rawAlts
    .map((a) => {
      const code = Number(a.code);
      const cand = codeToCandidate.get(code);
      if (!cand || cand.code === primary.code) return null;
      return {
        code: cand.code, name: cand.name, path: cand.path,
        confidence: Math.max(0, Math.min(1, Number(a.confidence ?? 0))),
      };
    })
    .filter((a): a is RankedCategory => a !== null)
    .slice(0, 2);

  // Determine needsConfirmation. Honour the model's hint if it set one,
  // else recompute from confidences (same rule as Pass B).
  const top1 = primary.confidence;
  const top2 = alternates[0]?.confidence ?? 0;
  const needsUserConfirmation =
    typeof parsed.needsConfirmation === "boolean"
      ? parsed.needsConfirmation
      : (top1 < 0.75 || (top1 - top2) < 0.15);

  // Filter dynamic_attributes to only keys that exist in the chosen
  // category's schema AND aren't seller-required (price, sku, etc.).
  // Strips any hallucinated attribute names the model returned.
  const allowedAttrNames = new Set(chosen.attrs.map((a) => a.name.toLowerCase()));
  const rawAttrs = (parsed.dynamic_attributes ?? {}) as Record<string, unknown>;
  const dynamic_attributes: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawAttrs)) {
    if (SELLER_REQUIRED_ATTR_KEYS.has(k.toLowerCase())) continue;
    if (!allowedAttrNames.has(k.toLowerCase())) continue;
    if (v == null || String(v).trim() === "" || String(v).toLowerCase() === "null") continue;
    dynamic_attributes[k] = String(v).trim();
  }

  // Pad with the AI-defaulted attribute values (product_note, etc.)
  // so every listing gets them — same convention as extractAttributesForCategory.
  for (const [k, defaultVal] of Object.entries(AI_DYNAMIC_ATTR_DEFAULTS)) {
    if (!dynamic_attributes[k] || dynamic_attributes[k].length === 0) {
      dynamic_attributes[k] = defaultVal;
    }
  }

  const field_sources:    Record<string, "ai">                                = {};
  const field_confidence: AIProductAnalysis["field_confidence"]               = {};
  for (const k of Object.keys(dynamic_attributes)) {
    field_sources[`dynamic_attributes.${k}`]    = "ai";
    field_confidence[`dynamic_attributes.${k}`] = { confidence: 0.8, source: "inferred" };
  }

  return {
    primary,
    alternates,
    needsUserConfirmation,
    dynamic_attributes,
    field_sources,
    field_confidence,
    ok: true,
  };
}

// ─── Phase 1 / Phase 3: gap-fill pass ──────────────────────────────────────
//
// After the main pipeline (Pass A + combined B+C + post-hoc defaults +
// pattern defaults), some REQUIRED attributes can still be empty —
// usually category-specific fields the AI couldn't determine and that
// don't match any of our pattern defaults. This single focused call
// asks the AI to fill ONLY those gaps with confident, sensible values
// drawn from general knowledge of the product class.
//
// Output is filter-validated server-side: enum fields must pick from
// allowed_values, number fields must parse to a number, others
// pass-through.

export interface GapField {
  name:           string;
  label:          string;
  type:           string;
  allowed_values: string[];
}

export interface GapFillResult {
  filled:    Record<string, string>;
  reasoning?: string;
}

export async function aiFillGaps(
  context: {
    title:        string;
    brand:        string | null;
    description:  string;
    categoryPath: string;
    images:       string[];
    /**
     * Optional ground-truth context block, typically formatted Google
     * Custom Search snippets from lib/ai/web-search.ts. When present
     * the model is told to prefer this real-world data over generic
     * inferences when filling gaps. Empty string = no boost.
     */
    webSearchContext?: string;
  },
  emptyFields: GapField[],
  opts: { forceBestModel?: boolean } = {},
): Promise<GapFillResult> {
  if (emptyFields.length === 0) return { filled: {} };
  if (USE_MOCK_AI) return { filled: {} };
  if (!process.env.GOOGLE_API_KEY) return { filled: {} };

  const fieldsBlock = emptyFields.map((f) => {
    const typeNote =
      f.type === "number"   ? " [NUMBER — return a real number]" :
      f.type === "boolean"  ? " [BOOLEAN — true/false]" :
      f.type === "enum"     ? ` [ENUM — pick one of: ${f.allowed_values.slice(0, 12).join(", ")}${f.allowed_values.length > 12 ? ", …" : ""}]` :
      f.type === "multi"    ? ` [MULTI-SELECT — comma-separated from: ${f.allowed_values.slice(0, 8).join(", ")}]` :
      "";
    return `  - ${f.name} (${f.label})${typeNote}`;
  }).join("\n");

  const webBlock = context.webSearchContext ?? "";

  const prompt = `You are a Jumia listing assistant. Fill the empty REQUIRED attribute fields below with confident, sensible values for this product. The seller cannot submit until every required field has a value, so DO NOT return null or empty — pick the most reasonable default you can from general knowledge of the brand / product class.

PRODUCT CONTEXT:
  Title:       ${context.title}
  Brand:       ${context.brand ?? "Generic"}
  Category:    ${context.categoryPath}
  Description: ${context.description.slice(0, 600)}
${webBlock}
EMPTY REQUIRED FIELDS:
${fieldsBlock}

Rules for each field:
- NEVER leave a field null or empty. The seller is blocked from submitting otherwise.
- For NUMBER fields: return a real numeric value (estimate from product class if no visible data). Never "true", "yes", "unknown", or text.
- For ENUM fields: pick exactly one value from the allowed list — typically prefer "all", "unisex", "standard", "classic", "regular" or similar most-inclusive option when in doubt.
- For BOOLEAN fields: pick the most-common-case value for this product class.
- For free-text fields: write a short, neutral value (e.g. "Standard", "Refer to product label", "Adult", "Unisex").
- Use the images + general online knowledge of the brand to be as accurate as possible. When the WEB SEARCH RESULTS block above is present, PREFER concrete specs from those snippets over generic estimates — they reflect the real product page.
- Only fall back to neutral defaults when you really have no basis.

Output ONLY this JSON shape, no markdown, no prose:
{
  "filled": {
    "<field_name>": "<value>",
    ...
  },
  "reasoning": "one short line"
}`;

  const { userId } = await auth();
  const visionModel = await resolveModel(userId, "vision", { forceBestModel: opts.forceBestModel });

  let raw: string;
  try {
    raw = await callGemini(prompt, context.images.slice(0, 2), visionModel);
  } catch (e) {
    console.warn(`[aiFillGaps] gemini call failed: ${(e as Error).message}`);
    return { filled: {} };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseAIResponse(raw);
  } catch (e) {
    console.warn(`[aiFillGaps] parse failed: ${(e as Error).message}`);
    return { filled: {} };
  }

  // Validate each filled value against its field's type / allowed_values.
  const inputByName = new Map(emptyFields.map((f) => [f.name, f]));
  const rawFilled = (parsed.filled ?? {}) as Record<string, unknown>;
  const filled: Record<string, string> = {};

  for (const [k, v] of Object.entries(rawFilled)) {
    const field = inputByName.get(k);
    if (!field) continue;          // model invented a field name; drop it
    if (v == null) continue;
    const value = String(v).trim();
    if (value.length === 0) continue;

    if (field.type === "number") {
      const m = value.match(/-?\d+(?:\.\d+)?/);
      if (m) {
        filled[k] = String(parseFloat(m[0]));
      }
      continue;
    }
    if (field.type === "enum" && field.allowed_values.length > 0) {
      const lower = value.toLowerCase();
      const match = field.allowed_values.find((a) => a.toLowerCase() === lower);
      if (match) filled[k] = match;
      continue;
    }
    if (field.type === "boolean") {
      if (/^(true|yes|1)$/i.test(value)) filled[k] = "true";
      else if (/^(false|no|0)$/i.test(value)) filled[k] = "false";
      continue;
    }
    // text / textarea / date / multi — pass through trimmed value
    filled[k] = value;
  }

  return {
    filled,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : undefined,
  };
}

// ─── Phase 2: description auto-expand ──────────────────────────────────────
//
// Jumia rejects descriptions under 50 characters. Pass A's prompt asks
// for a real, richly-formatted description (see buildDescriptionAndHighlights
// StyleBlock, wired into aiPassA_describeProduct) but the model sometimes
// returns a 20-30 char summary when it can't find much to say about a
// product. This is a focused rewrite call that takes a too-short
// description and expands it to the same content-style bar Pass A and the
// Chrome extension's fill prompt both hold to, using the title / brand /
// keywords / highlights as context.

export async function aiExpandDescription(
  current: string,
  context: {
    title:      string;
    brand:      string | null;
    keywords:   string[];
    highlights: string;
  },
  opts: { forceBestModel?: boolean } = {},
): Promise<string> {
  if (USE_MOCK_AI) return current + " — (mock expansion)";
  if (!process.env.GOOGLE_API_KEY) return current;
  // Already long enough — no need to spend tokens.
  if (current.trim().length >= 150) return current;

  const policyBlock = buildContentPolicyInstructions({ includeImageRules: false });
  const styleBlock = buildDescriptionStyleBlock();

  const prompt = `Rewrite the following Jumia product description. Keep it factual + sales-friendly. May use plain prose, HTML, bullet lists or tables — whatever fits the product best.

ORIGINAL DESCRIPTION (may be empty or too short):
"${current}"

PRODUCT CONTEXT:
- Title: ${context.title}
- Brand: ${context.brand ?? "Generic"}
- Keywords: ${context.keywords.join(", ")}
- Highlights: ${context.highlights.slice(0, 400)}

${policyBlock}
${styleBlock}
Rules:
- Lead with what the product IS and its headline feature.
- May use bold / italics / bullets / tables / HTML. Inline <img> is allowed.
- No banned words, no condition descriptors ("brand new", "original" etc.), no URLs or social handles, no prices.
- Marketing language permitted ("premium", "perfect for", "best-in-class").

Output ONLY the expanded description text. No JSON wrapper, no markdown fences, no quotes around the output, no explanation.`;

  const { userId } = await auth();
  const textModel = await resolveModel(userId, "text", { forceBestModel: opts.forceBestModel });

  try {
    const raw = await callGemini(prompt, [], textModel);
    const cleaned = raw.trim().replace(/^"+|"+$/g, "").trim();
    if (cleaned.length >= 50) return cleaned;
    return current;            // fallback if the model returned garbage
  } catch (e) {
    console.warn(`[aiExpandDescription] failed: ${(e as Error).message}`);
    return current;
  }
}

// ─── Main: analyse text description ──────────────────────────────────────────

export async function analyzeProductDescription(
  description:  string,
  userContext?: string | null,  // free-text AI-chat from the seller; threaded into every prompt pass
): Promise<AIProductAnalysis> {
  if (USE_MOCK_AI) {
    console.warn("[AI] USE_MOCK_AI=true — returning mock analysis");
    return buildMockAnalysis();
  }

  if (!process.env.GOOGLE_API_KEY) {
    throw new Error(
      "GOOGLE_API_KEY is not set. Add it to your Vercel environment variables to enable AI analysis."
    );
  }

  // Tier-aware model selection — no images here, so "text" kind.
  const { userId: descUserId } = await auth();
  const descTextModel = await resolveModel(descUserId, "text");

  // Same pool as the image path — listable parents too, not just
  // leaves — plus the brand catalogue so the AI binds to real names.
  const [categories, brands] = await Promise.all([
    getListableCategories(),
    getAllBrands(),
  ]);
  const categoryContext = categories.length > 0
    ? `Choose from the ${categories.length} Jumia GH listable categories listed below.`
    : "Use your best knowledge of Jumia Ghana categories.";

  // Description-only path — no images, so skip the image-rules section
  // of the policy block (includeImageRules=false). userContext threaded
  // through so AI-chat overrides apply on every pass.
  const prompt = buildPrompt(categories, [], categoryContext, brands, null, false, userContext) +
    `\n\nProduct description to analyse:\n"${description}"`;

  let parsed: Record<string, unknown>;
  try {
    const raw = await callGemini(prompt, [], descTextModel);
    parsed = parseAIResponse(raw);
  } catch (e) {
    const msg = (e as Error).message ?? "Gemini analysis failed";
    console.error("[AI] Gemini call failed:", msg);
    throw new Error(`AI analysis failed: ${msg}`);
  }

  const cat = resolveCategory(parsed, categories);
  const classificationCtx = extractClassificationConfidence(parsed, categories, cat.code);

  let dynamicAttributes: Record<string, string> = (parsed.dynamic_attributes ?? {}) as Record<string, string>;
  if (cat.code > 0) {
    const attrs = await getCategoryAttributes(cat.code);
    if (attrs.length > 0) {
      try {
        const secondPrompt = buildPrompt(categories, attrs, categoryContext, brands, cat.path, false, userContext) +
          `\n\nProduct description: "${description}"`;
        const raw2 = await callGemini(secondPrompt, [], descTextModel);
        const parsed2 = parseAIResponse(raw2);
        dynamicAttributes = (parsed2.dynamic_attributes ?? dynamicAttributes) as Record<string, string>;
        Object.assign(parsed, parsed2);
      } catch { /* use first pass */ }
    }
  }

  return buildCoreResult(parsed, cat, dynamicAttributes, classificationCtx);
}

// ─── Mock fallback ────────────────────────────────────────────────────────────

const MOCK_PRODUCTS = [
  {
    title:           "Samsung Galaxy A55 5G Smartphone – 128GB – Awesome Navy",
    description:     "The Samsung Galaxy A55 5G delivers a premium experience with its 6.6-inch Super AMOLED display and 50MP triple camera system.",
    highlights:      "• 6.6-inch Super AMOLED 120Hz display\n• 50MP OIS main camera + 12MP ultra-wide\n• 5000mAh battery with 25W fast charging\n• IP67 water resistance\n• 5G connectivity",
    brand:           "Samsung",
    color:           "Navy Blue",
    color_family:    "Navy Blue",
    weight_kg:       0.213,
    selling_price:   2199,
    model:           "SM-A556E",
    main_material:   "Aluminium",
    material_family: "Metal",
    mock_category:   "Mobile Phones",
    dynamic_attributes: { operating_system: "Android", ram: "8GB", internal_memory: "128GB", sim_type: "Dual SIM", network: "5G" },
  },
  {
    title:           "Sony WH-1000XM5 Wireless Noise-Cancelling Headphones – Black",
    description:     "Industry-leading noise cancellation with 30-hour battery life and crystal-clear hands-free calling.",
    highlights:      "• Industry-leading noise cancellation\n• 30-hour battery life\n• Multi-device pairing via Bluetooth 5.2\n• Lightweight 250g design\n• Hi-Res Audio support",
    brand:           "Sony",
    color:           "Black",
    color_family:    "Black",
    weight_kg:       0.25,
    selling_price:   1850,
    model:           "WH-1000XM5",
    main_material:   "Plastic",
    material_family: "Plastic",
    mock_category:   "Headphones",
    dynamic_attributes: { connectivity: "Bluetooth", battery_life: "30 hours", noise_cancellation: "Yes" },
  },
];

function buildMockAnalysis(): AIProductAnalysis {
  const template = MOCK_PRODUCTS[Math.floor(Math.random() * MOCK_PRODUCTS.length)];
  const mock = mockCategories.find((c) => c.name === template.mock_category) ?? mockCategories[0];
  const field_sources: Record<string, "ai"> = {};
  for (const k of Object.keys(template)) {
    if (k !== "mock_category" && k !== "dynamic_attributes") field_sources[k] = "ai";
  }
  for (const k of Object.keys(template.dynamic_attributes)) {
    field_sources[`dynamic_attributes.${k}`] = "ai";
  }
  return {
    ...template,
    // Layer the new AI-defaulted fields so the mock matches the live
    // AIProductAnalysis shape (warranty / production_country are
    // AI-fillable as of May 2026).
    warranty_duration:  AI_FIELD_DEFAULTS.warranty_duration,
    warranty_text:      AI_FIELD_DEFAULTS.warranty_text,
    warranty_address:   AI_FIELD_DEFAULTS.warranty_address,
    production_country: "China",  // arbitrary plausible default for mock data
    dynamic_attributes: {
      ...AI_DYNAMIC_ATTR_DEFAULTS,
      ...(template.dynamic_attributes as unknown as Record<string, string>),
    },
    category_id:     mock.id,
    category_code:   mock.code,
    category_path:   mock.path,
    commission_rate: mock.commissionRate / 100,
    category_alternates: [
      { code: parseInt(mock.code, 10) || 0, name: mock.name, path: mock.path, confidence: 0.9 },
    ],
    category_confidence: 0.9,
    needs_user_confirmation: false,
    field_sources,
    field_confidence: {},
  };
}

// ─── Rejection resolver ──────────────────────────────────────────────────────
//
// Given a Jumia rejection reason + current listing fields, asks the AI to
// propose specific field changes that address the rejection. Returns the
// updates as a plain object so the caller can merge them into the listing
// via updateListing.
//
// The resolver is single-shot — one AI pass per call. The UI exposes a
// "Resolve with AI" button that triggers this, then shows the changes for
// the seller to verify before re-pushing. We intentionally do NOT auto-loop
// (AI → push → AI → push …) because (a) it can burn quota on a bad
// rejection reason and (b) the seller deserves to see what changed.

export interface RejectionResolution {
  /** Field changes — keys match ListingRow columns or dynamic_attributes keys */
  updates:   Record<string, unknown>;
  /** One-sentence human summary, shown to the seller */
  summary:   string;
  /** Longer reasoning explaining how each change addresses the rejection */
  reasoning: string;
}

export async function resolveRejection(
  listing: {
    title?:              string | null;
    description?:        string | null;
    highlights?:         string | null;
    brand?:              string | null;
    color?:              string | null;
    color_family?:       string | null;
    weight_kg?:          number | null;
    main_material?:      string | null;
    material_family?:    string | null;
    production_country?: string | null;
    selling_price?:      number | null;
    category_path?:      string | null;
    category_code?:      number | null;     // NEW: needed to fetch attribute schema
    warranty_text?:      string | null;
    warranty_address?:   string | null;
    dynamic_attributes?: Record<string, string> | null;
    images?:             string[] | null;
  },
  rejectionReason: string,
): Promise<RejectionResolution> {
  if (USE_MOCK_AI) {
    return {
      updates: { description: (listing.description ?? "") + " — refined." },
      summary: "(mock) Lengthened description",
      reasoning: "USE_MOCK_AI=true; returning a stub fix.",
    };
  }

  if (!process.env.GOOGLE_API_KEY) {
    throw new Error("GOOGLE_API_KEY is not set");
  }

  const restrictedInstruction = buildRestrictedWordsInstruction();

  const currentFields = {
    title:              listing.title              ?? "",
    description:        listing.description        ?? "",
    highlights:         listing.highlights         ?? "",
    brand:              listing.brand              ?? "",
    color:              listing.color              ?? "",
    color_family:       listing.color_family       ?? "",
    weight_kg:          listing.weight_kg          ?? null,
    main_material:      listing.main_material      ?? "",
    material_family:    listing.material_family    ?? "",
    production_country: listing.production_country ?? "",
    selling_price:      listing.selling_price      ?? null,
    category_path:      listing.category_path      ?? "",
    warranty_text:      listing.warranty_text      ?? "",
    warranty_address:   listing.warranty_address   ?? "",
    dynamic_attributes: listing.dynamic_attributes ?? {},
  };

  // ── Fetch the category's attribute schema so the AI knows the EXPECTED
  // TYPE of each dynamic_attribute it's being asked to fix. Without this,
  // a rejection like "Attribute [capacity_liter] with the value [true]
  // should be a number" gets "fixed" with another invalid value because
  // the AI guesses at the field's shape.
  const categorySchemaLines: string[] = [];
  if (listing.category_code != null) {
    try {
      const schema = await getCategoryAttributes(listing.category_code);
      for (const a of schema) {
        const typeLabel =
          a.type === "number"   ? " (NUMBER — value must be numeric, e.g. 1.5, 12, 250 — never 'true', 'yes', or text)" :
          a.type === "boolean"  ? " (BOOLEAN — value must be 'true' or 'false')" :
          a.type === "enum"     ? ` (ENUM — value must be one of: ${a.allowed_values.slice(0, 10).join(", ")}${a.allowed_values.length > 10 ? ", …" : ""})` :
          a.type === "multi"    ? ` (MULTI-SELECT — comma-separated values from: ${a.allowed_values.slice(0, 8).join(", ")}${a.allowed_values.length > 8 ? ", …" : ""})` :
          a.type === "date"     ? " (DATE — YYYY-MM-DD)" :
          a.type === "datetime" ? " (DATETIME — ISO 8601)" :
          "";
        categorySchemaLines.push(`  - ${a.name}: ${a.label}${typeLabel}${a.required ? " [REQUIRED]" : ""}`);
      }
    } catch (e) {
      console.warn(`[resolveRejection] failed to fetch schema for category ${listing.category_code}: ${(e as Error).message}`);
    }
  }
  const categorySchemaBlock = categorySchemaLines.length > 0
    ? `\n\nCATEGORY ATTRIBUTE SCHEMA — every dynamic_attributes.<key> change MUST respect the TYPE shown below:\n${categorySchemaLines.join("\n")}\n`
    : "";

  const prompt = `
You are an expert Jumia vendor assistant. A listing was REJECTED by Jumia's quality check. Your job is to propose specific, concrete field changes that will pass on the next submission.

REJECTION REASON FROM JUMIA:
${rejectionReason}

CURRENT LISTING DATA (JSON):
${JSON.stringify(currentFields, null, 2)}
${categorySchemaBlock}
YOUR TASK:
1. Identify which fields are likely causing the rejection.
2. Propose specific corrected values for ONLY those fields. Don't echo unchanged fields.
3. Keep changes minimal and concrete. Sellers can fine-tune after.
4. For "brand": if the rejection suggests the brand isn't recognised, suggest the closest well-known equivalent (e.g. "Generic" if you can't identify a brand).
5. For "description": Jumia requires 50–9,000 characters, focusing on product features only. No testimonials, no promotional language.
6. For "highlights": 4+ bullets is ideal. EVERY bullet on its own line (separate with "\\n") or use <ul><li>…</li></ul>. NEVER run bullets together in one paragraph.
7. NUMERIC ATTRIBUTES — if the rejection says "should be a number" for an attribute (e.g. capacity_liter, battery_capacity, screen_size), your new value MUST be a plain number — NEVER strings, NEVER booleans like "true", NEVER text like "0.5 (estimated)" or "approx 1.5". Read the image (or use general knowledge of the product/brand) to give a real numeric estimate. If you cannot give a number with any confidence, omit the field entirely — null is better than a bad value that triggers the same rejection again.
8. Respect the attribute TYPES shown in the schema block above (when present). NUMBER → number only. ENUM → exact value from the allowed list. BOOLEAN → "true" or "false". DATE → YYYY-MM-DD.

${restrictedInstruction}

OUTPUT STRICTLY THIS JSON SHAPE (no prose before or after):
{
  "updates": {
    "<field_name>": "<new value>",
    ...
  },
  "summary": "<one-sentence description of what changed>",
  "reasoning": "<2-3 sentences explaining how the changes address the rejection>"
}

Valid field names:
  title | description | highlights | brand | color | color_family |
  weight_kg | main_material | material_family | production_country |
  selling_price | warranty_text | warranty_address |
  dynamic_attributes.<any_key>  (for category-specific attributes — see schema block)

Examples:
- "Attribute [capacity_liter] with the value [true] should be a number." → set "dynamic_attributes.capacity_liter" to a number like 0.5 or 1.2 based on the image (humidifier tank size).
- "Attribute [battery_capacity] should be a number." → set "dynamic_attributes.battery_capacity" to the milliamp-hour or watt-hour value (e.g. 5000).
- "brand not recognised" → set "brand" to a known equivalent or "Generic".
- "description too short" → expand the description (50+ chars).
- "weight missing" → set "weight_kg" to a numeric estimate (number only — never "0.5 (estimated)").
- "bullet formatting" → rewrite highlights with \\n-separated bullets.
`.trim();

  // Use first image only — context for "image quality" rejections.
  // No image is also fine; rejection text alone is usually enough.
  const imageUrls = (listing.images ?? []).slice(0, 1);

  // Tier-aware model selection — rejection resolver is vision when
  // images are present, text otherwise.
  const { userId: resolveUserId } = await auth();
  const resolveModelName = await resolveModel(
    resolveUserId,
    imageUrls.length > 0 ? "vision" : "text",
  );

  const raw = await callGemini(prompt, imageUrls, resolveModelName);
  const parsed = parseAIResponse(raw) as Partial<RejectionResolution>;

  if (!parsed.updates || typeof parsed.updates !== "object") {
    throw new Error("AI response did not include an 'updates' object");
  }

  // Sanitise text fields through the restricted-words filter before returning.
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.updates)) {
    if (typeof v === "string") {
      cleaned[k] = stripRestrictedWords(v);
    } else {
      cleaned[k] = v;
    }
  }

  // Surface any restricted words we caught so the seller knows the AI tried
  // (and we caught) something dodgy.
  const flagged: string[] = [];
  for (const v of Object.values(parsed.updates)) {
    if (typeof v === "string") {
      flagged.push(...findRestrictedWords(v));
    }
  }

  return {
    updates:   cleaned,
    summary:   String(parsed.summary   ?? "Updated fields to address the rejection."),
    reasoning: String(parsed.reasoning ?? "") + (
      flagged.length ? ` (Filtered restricted words: ${Array.from(new Set(flagged)).join(", ")}.)` : ""
    ),
  };
}
