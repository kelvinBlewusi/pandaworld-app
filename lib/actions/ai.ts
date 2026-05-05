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
4. For dynamic_attributes: include ONLY fields you can determine from the product. Omit fields you cannot determine — do NOT guess.${attributeSection}

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

async function callGemini(
  prompt: string,
  imageUrls: string[]
): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY not set");

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  // Fetch images and convert to inline data
  const imageParts = await Promise.all(
    imageUrls.slice(0, 4).map(async (url) => {
      try {
        const res = await fetch(url);
        const buffer = await res.arrayBuffer();
        const base64 = Buffer.from(buffer).toString("base64");
        const mimeType = (res.headers.get("content-type") ?? "image/jpeg") as string;
        return { inlineData: { data: base64, mimeType } };
      } catch {
        return null;
      }
    })
  );

  const validImageParts = imageParts.filter(Boolean) as { inlineData: { data: string; mimeType: string } }[];

  const result = await model.generateContent([
    prompt,
    ...validImageParts,
  ]);

  return result.response.text();
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

export async function analyzeProductImages(
  imageUrls: string[]
): Promise<AIProductAnalysis> {
  if (!imageUrls.length) throw new Error("No images provided");

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
    console.warn("[AI] Gemini failed, using mock:", e);
    return buildMockAnalysis();
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
    console.warn("[AI] Gemini failed, using mock:", e);
    return buildMockAnalysis();
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
