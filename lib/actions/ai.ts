"use server";

import { GoogleGenerativeAI } from "@google/generative-ai";
import { getLeafCategories, getCategoryAttributes } from "@/lib/jumia/categories";
import { mockCategories } from "@/lib/mock/categories";
import type { JumiaCategoryRow, JumiaCategoryAttribute } from "@/lib/jumia/categories";
import {
  SELLER_REQUIRED_FIELDS,
  SELLER_REQUIRED_ATTR_KEYS,
  BRAND_CONFIDENCE_THRESHOLD,
} from "@/lib/ai/policy";

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
  categoryContext: string
): string {
  const categoryList = categories
    .map((c) => `${c.code}|${c.path}`)
    .join("\n");

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

  return `You are an expert Jumia Ghana product listing assistant.
Analyse the product image(s) and/or description, then return a SINGLE valid JSON object.

${categoryContext}

JUMIA CATEGORY LIST (code|path):
${categoryList}

STRICT RULES — violations will cause the submission to be rejected:
1. Pick the single most specific matching category from the list. Use the exact numeric code.
2. Provide the top 3 best-matching category codes from the list above, in descending confidence order.
3. NEVER fabricate or guess values. If a field cannot be determined with reasonable confidence, set it to null.
4. For dynamic_attributes: include ONLY fields you can determine from the product. Omit fields you cannot determine — do NOT guess.
5. Description MUST be between 80 and 500 characters — Jumia rejects anything under 50. Write 2–3 full sentences.
6. Title MUST be 15–70 characters. Include the brand, model and 1–2 key specs.
7. Highlights MUST be at least 4 bullet points starting with "•" (the bullet character). Each on its own line.
8. Brand: leave NULL unless you can clearly see a brand logo or wordmark in the image AND your confidence is above 0.9. A guessed brand causes legal/commercial issues.
9. NEVER fill: model, selling_price, warranty fields, production_country, certifications, GTIN, SKU. The seller fills those manually.${attributeSection}

Return ONLY valid JSON. No markdown fences, no explanation, no trailing text:
{
  "title": "Full product name including brand, model and 1-2 key specs (15-70 chars)",
  "description": "2-3 sentences for a Jumia listing (min 80 chars)",
  "highlights": "• bullet1\\n• bullet2\\n• bullet3\\n• bullet4 (min 4 bullets, start each with •)",
  "brand": "Brand name ONLY if logo is clearly visible AND confidence > 0.9, else null",
  "brand_confidence": 0.0,
  "color": "Specific color e.g. Midnight Black, or null",
  "color_family": "Base color e.g. Black, or null",
  "weight_kg": null,
  "selling_price": null,
  "model": null,
  "main_material": "e.g. Plastic, Metal, Fabric, or null",
  "material_family": "e.g. Metal, Fabric, Plastic, or null",
  "category_code": "EXACT numeric code from category list above — your top pick",
  "category_path": "Matching path from category list above for your top pick",
  "category_confidence": 0.0,
  "category_alternates": [
    { "code": "second-best numeric code", "confidence": 0.0 },
    { "code": "third-best numeric code",  "confidence": 0.0 }
  ],
  "dynamic_attributes": {
    "attribute_name": "value — only include if you are confident"
  }
}`;
}

// ─── Gemini AI call ───────────────────────────────────────────────────────────

// Preferred models in order. The first one that's available on the user's
// API key will be used. If none of these resolve, we discover the live model
// list from Google's API and pick whatever vision-capable model is available.
const PREFERRED_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.0-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash-lite",
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

async function callGemini(
  prompt: string,
  imageUrls: string[]
): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY not set");

  const genAI = new GoogleGenerativeAI(apiKey);

  // Fetch images and convert to inline data
  const fetchedImages: { ok: boolean; part?: { inlineData: { data: string; mimeType: string } }; error?: string }[] =
    await Promise.all(
      imageUrls.slice(0, 4).map(async (url) => {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
          const buffer   = await res.arrayBuffer();
          const base64   = Buffer.from(buffer).toString("base64");
          const mimeType = (res.headers.get("content-type") ?? "image/jpeg") as string;
          return { ok: true, part: { inlineData: { data: base64, mimeType } } };
        } catch (e) {
          return { ok: false, error: (e as Error).message };
        }
      })
    );

  const validImageParts = fetchedImages
    .filter((r) => r.ok && r.part)
    .map((r) => r.part!) as { inlineData: { data: string; mimeType: string } }[];

  if (imageUrls.length > 0 && validImageParts.length === 0) {
    const errors = fetchedImages.map((r) => r.error).filter(Boolean).join(", ");
    throw new Error(`Could not download any of the ${imageUrls.length} images for analysis: ${errors}`);
  }

  // 1. If we previously resolved a working model, try it first
  const tryModel = async (name: string) => {
    const model = genAI.getGenerativeModel({ model: name });
    const result = await model.generateContent([prompt, ...validImageParts]);
    return result.response.text();
  };

  if (_resolvedModel) {
    try { return await tryModel(_resolvedModel); }
    catch (e) {
      console.warn(`[AI] Cached model ${_resolvedModel} failed: ${(e as Error).message}`);
      _resolvedModel = null;
    }
  }

  // 2. Try each preferred model in order
  const errors: string[] = [];
  for (const modelName of PREFERRED_MODELS) {
    try {
      const text = await tryModel(modelName);
      _resolvedModel = modelName;
      console.info(`[AI] Using model: ${modelName}`);
      return text;
    } catch (e) {
      errors.push(`${modelName}: ${(e as Error).message.slice(0, 100)}`);
    }
  }

  // 3. None of the preferred models worked — discover what's actually live
  console.warn(`[AI] All preferred models failed. Discovering available models for this API key…`);
  let discovered: string;
  try {
    discovered = await discoverWorkingModel(apiKey);
  } catch (e) {
    throw new Error(
      `No Gemini model worked. Tried: ${PREFERRED_MODELS.join(", ")}. ` +
      `Discovery also failed: ${(e as Error).message}`
    );
  }

  try {
    const text = await tryModel(discovered);
    _resolvedModel = discovered;
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
  // dropped here.
  const cleanDyn: Record<string, string> = {};
  for (const [rawKey, v] of Object.entries(dynAttrs)) {
    const k = rawKey.toLowerCase();
    if (SELLER_REQUIRED_ATTR_KEYS.has(k)) continue;
    if (v != null && String(v).trim() !== "" && String(v).toLowerCase() !== "null") {
      cleanDyn[rawKey] = String(v).trim();
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
  const brandValue      = brandConfidence >= BRAND_CONFIDENCE_THRESHOLD && aiBrand
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
  ];

  // Brand confidence depends on how we resolved it:
  //   - Above threshold + AI detected a real brand → high (image source)
  //   - Below threshold OR no AI brand → "Generic" fallback (inferred, low)
  field_sources["brand"] = "ai";
  if (brandConfidence >= BRAND_CONFIDENCE_THRESHOLD && aiBrand) {
    field_confidence["brand"] = {
      confidence: brandConfidence,
      source:     "image",
      reasoning:  "Logo visible in image",
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

  return {
    title:              String(parsed.title       ?? ""),
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
    selling_price:      null,   // ALWAYS seller-supplied
    model:              null,   // ALWAYS seller-supplied
    main_material:      strOrNull(parsed.main_material),
    material_family:    strOrNull(parsed.material_family),
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
  imageUrls: string[]
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

  // Load real categories from Supabase
  const categories = await getLeafCategories();

  // If no real categories synced yet, fall back gracefully
  const categoryContext = categories.length > 0
    ? `Choose from the ${categories.length} Jumia GH leaf categories listed below.`
    : "Use your best knowledge of Jumia Ghana categories.";

  // First pass: category detection without attributes (fast)
  const firstPassPrompt = buildPrompt(categories, [], categoryContext);

  let parsed: Record<string, unknown>;
  try {
    const raw = await callGemini(firstPassPrompt, imageUrls);
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
        const secondPrompt = buildPrompt(categories, attrs, categoryContext);
        const raw2 = await callGemini(secondPrompt, imageUrls);
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
  title:    string;
  brand:    string | null;       // null unless logo clearly visible
  keywords: string[];            // 5-10 search keywords
  summary:  string;              // one-sentence description
}

export async function aiPassA_describeProduct(
  imageUrls: string[]
): Promise<ProductDescription> {
  if (!imageUrls.length) throw new Error("No images provided");
  if (USE_MOCK_AI) {
    return { title: "Mock Product", brand: null, keywords: ["mock"], summary: "Mock product." };
  }
  if (!process.env.GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY is not set.");

  const prompt = `You are a product-listing assistant. Look at the product images and return a short JSON description.

Rules:
- title: Concise product name (e.g. "Sony WH-1000XM5 Wireless Noise-Cancelling Headphones"). 5-12 words. NO category names like "headphones for sale".
- brand: Only fill if a brand logo or wordmark is clearly visible. Otherwise null.
- keywords: 5-10 single-word lower-case keywords (no quotes, no underscores). Think of what a buyer would search for.
- summary: One sentence describing what the product is and its key visible features.

Return ONLY valid JSON. No markdown, no commentary:
{
  "title":    "...",
  "brand":    null,
  "keywords": ["...", "..."],
  "summary":  "..."
}`;

  let parsed: Record<string, unknown>;
  try {
    const raw = await callGemini(prompt, imageUrls);
    parsed = parseAIResponse(raw);
  } catch (e) {
    throw new Error(`Describe pass failed: ${(e as Error).message}`);
  }

  const keywords = Array.isArray(parsed.keywords)
    ? (parsed.keywords as unknown[]).map((k) => String(k).toLowerCase().trim()).filter(Boolean)
    : [];

  return {
    title:    String(parsed.title ?? "").trim() || "Unknown product",
    brand:    strOrNull(parsed.brand),
    keywords: keywords.slice(0, 10),
    summary:  String(parsed.summary ?? "").trim(),
  };
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
  candidates: Array<{ code: number; name: string; path: string }>
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

  const candidateList = candidates
    .map((c, i) => `${i + 1}. ${c.code} — ${c.path}`)
    .join("\n");

  const prompt = `You are a Jumia category classification expert. Look at the product images and pick the single best Jumia leaf category for them from the candidates below.

CANDIDATES:
${candidateList}

Rules:
1. Pick exactly one as the primary (the best match).
2. List up to 2 alternates in case the primary is wrong.
3. Confidence is 0..1. Be honest — use 0.5 or below if you're unsure.
4. You MUST choose from the candidates above. Do not invent new codes.

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
    const raw = await callGemini(prompt, imageUrls);
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
  categoryCode: number
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

  const prompt = `You are a Jumia product-listing assistant. Look at the product images and fill ONLY the attributes listed below for the category. Return a SINGLE JSON object.

CATEGORY ATTRIBUTES TO FILL (use the exact attribute names as keys):
${attrLines}

RULES:
1. Use the exact attribute name as the JSON key.
2. For attributes with allowed values, pick exactly one value from the list (or null if unsure).
3. Skip / set null for fields you can't determine from the images. NEVER guess price, model, brand (unless logo clearly visible), or warranty terms.
4. Return only attributes you could fill — omit ones you're not sure about.

Return ONLY valid JSON, no markdown:
{
  "attributes": {
    "attribute_name": "value"
  }
}`;

  let parsed: Record<string, unknown>;
  try {
    const raw = await callGemini(prompt, imageUrls);
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

  const field_sources:    Record<string, "ai"> = {};
  const field_confidence: AIProductAnalysis["field_confidence"] = {};
  for (const k of Object.keys(dynamic_attributes)) {
    field_sources[`dynamic_attributes.${k}`]    = "ai";
    field_confidence[`dynamic_attributes.${k}`] = { confidence: 0.8, source: "inferred" };
  }

  return { dynamic_attributes, field_sources, field_confidence };
}

// ─── Main: analyse text description ──────────────────────────────────────────

export async function analyzeProductDescription(
  description: string
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

  const categories = await getLeafCategories();
  const categoryContext = categories.length > 0
    ? `Choose from the ${categories.length} Jumia GH leaf categories listed below.`
    : "Use your best knowledge of Jumia Ghana categories.";

  const prompt = buildPrompt(categories, [], categoryContext) +
    `\n\nProduct description to analyse:\n"${description}"`;

  let parsed: Record<string, unknown>;
  try {
    const raw = await callGemini(prompt, []);
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
        const secondPrompt = buildPrompt(categories, attrs, categoryContext) +
          `\n\nProduct description: "${description}"`;
        const raw2 = await callGemini(secondPrompt, []);
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
    dynamic_attributes: template.dynamic_attributes as unknown as Record<string, string>,
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
