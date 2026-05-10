"use server";

import { GoogleGenerativeAI } from "@google/generative-ai";
import { getLeafCategories, getCategoryAttributes } from "@/lib/jumia/categories";
import { mockCategories } from "@/lib/mock/categories";
import type { JumiaCategoryRow, JumiaCategoryAttribute } from "@/lib/jumia/categories";

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

  // Category-specific attributes (varies by category)
  // Stored as a flat key→value map. Only keys where the AI is confident are set.
  // Unknown / undetectable values are OMITTED (not fabricated).
  dynamic_attributes: Record<string, string>;

  // Tracks which fields were set by AI (all fields in this object are "ai" at creation time)
  field_sources: Record<string, "ai">;
}

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
2. Set a realistic GHS selling price for the Ghanaian market.
3. NEVER fabricate or guess values. If a field cannot be determined with reasonable confidence, set it to null.
4. For dynamic_attributes: include ONLY fields you can determine from the product. Omit fields you cannot determine — do NOT guess.
5. Description MUST be between 80 and 500 characters — Jumia rejects anything under 50. Write 2–3 full sentences.
6. Title MUST be 15–70 characters. Include the brand, model and 1–2 key specs.
7. Highlights MUST be at least 4 bullet points starting with "•" (the bullet character). Each on its own line.${attributeSection}

Return ONLY valid JSON. No markdown fences, no explanation, no trailing text:
{
  "title": "Full product name including brand, model and 1-2 key specs (15-70 chars)",
  "description": "2-3 sentences for a Jumia listing (min 80 chars)",
  "highlights": "• bullet1\\n• bullet2\\n• bullet3\\n• bullet4 (min 4 bullets, start each with •)",
  "brand": "Brand name, or null if not visible",
  "color": "Specific color e.g. Midnight Black, or null",
  "color_family": "Base color e.g. Black, or null",
  "weight_kg": 0.5,
  "selling_price": 1200,
  "model": "Model number or null",
  "main_material": "e.g. Plastic, Metal, Fabric, or null",
  "material_family": "e.g. Metal, Fabric, Plastic, or null",
  "category_code": "EXACT numeric code from category list above",
  "category_path": "Matching path from category list above",
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
  parsed:    Record<string, unknown>,
  cat:       { code: number; path: string; commission_rate: number },
  dynAttrs:  Record<string, string>
): AIProductAnalysis {
  // Strip null / empty-string entries from dynamic attributes
  const cleanDyn: Record<string, string> = {};
  for (const [k, v] of Object.entries(dynAttrs)) {
    if (v != null && String(v).trim() !== "" && String(v).toLowerCase() !== "null") {
      cleanDyn[k] = String(v).trim();
    }
  }

  // Build field_sources: every field set here is "ai"
  const field_sources: Record<string, "ai"> = {};
  const coreFields = ["title","description","highlights","brand","color","color_family",
                      "weight_kg","selling_price","model","main_material","material_family"];
  for (const f of coreFields) {
    if (parsed[f] != null && parsed[f] !== "" && parsed[f] !== "null") {
      field_sources[f] = "ai";
    }
  }
  for (const k of Object.keys(cleanDyn)) {
    field_sources[`dynamic_attributes.${k}`] = "ai";
  }

  return {
    title:              String(parsed.title       ?? ""),
    description:        String(parsed.description ?? ""),
    highlights:         String(parsed.highlights  ?? ""),
    brand:              strOrNull(parsed.brand),
    color:              strOrNull(parsed.color),
    color_family:       strOrNull(parsed.color_family),
    weight_kg:          parsed.weight_kg != null && parsed.weight_kg !== "null"
                          ? Number(parsed.weight_kg)
                          : null,
    selling_price:      parsed.selling_price != null && parsed.selling_price !== "null"
                          ? Number(parsed.selling_price)
                          : null,
    model:              strOrNull(parsed.model),
    main_material:      strOrNull(parsed.main_material),
    material_family:    strOrNull(parsed.material_family),
    category_id:        String(cat.code),
    category_code:      String(cat.code),
    category_path:      cat.path,
    commission_rate:    cat.commission_rate,
    dynamic_attributes: cleanDyn,
    field_sources,
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

  const coreResult = buildCoreResult(parsed, cat, dynamicAttributes);
  return coreResult;
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

  return buildCoreResult(parsed, cat, dynamicAttributes);
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
    field_sources,
  };
}
