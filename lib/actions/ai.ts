"use server";

import { GoogleGenerativeAI } from "@google/generative-ai";
import { mockCategories } from "@/lib/mock/categories";

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);

export interface AIProductAnalysis {
  title: string;
  description: string;
  highlights: string;
  brand: string;
  color: string;
  color_family: string;
  weight_kg: number | null;
  category_id: string;
  category_path: string;
  category_code: string;
  commission_rate: number;
  selling_price: number | null;
  model: string;
  main_material: string;
  material_family: string;
}

const CATEGORY_LIST = mockCategories
  .map((c) => `${c.id} | ${c.name} | ${c.path}`)
  .join("\n");

const PROMPT = `You are an expert Jumia GH marketplace listing assistant.
Analyse the provided product and return a JSON object with the following fields.
Be concise, accurate, and use proper title casing.

Available Jumia GH categories (id | name | path):
${CATEGORY_LIST}

Return ONLY valid JSON — no markdown fences, no explanation.

JSON schema:
{
  "title": "Product name, 15-70 chars, include key spec like size/colour/model",
  "description": "2-3 sentence product description for Jumia listing",
  "highlights": "3-5 bullet points of key features, newline separated, start each with •",
  "brand": "Brand name or empty string if unknown",
  "color": "Primary colour of the product",
  "color_family": "One of: Black, White, Red, Blue, Green, Yellow, Orange, Pink, Purple, Brown, Grey, Silver, Gold, Beige, Multicolor, Transparent, Navy Blue, Rose Gold",
  "weight_kg": estimated weight as a number in kg or null,
  "category_id": "Best matching category id from the list above",
  "category_path": "The full path of the matching category",
  "category_code": "The code of the matching category",
  "commission_rate": commission rate as decimal e.g. 0.07,
  "selling_price": estimated typical retail price in GHS as a number or null,
  "model": "Model number or identifier if visible, else empty string",
  "main_material": "Primary material e.g. Plastic, Metal, Fabric",
  "material_family": "One of: Metal, Plastic, Fabric, Leather, Wood, Glass, Rubber, Ceramic, Silicone, Carbon Fibre, Mixed"
}`;

/** Fetch an image URL and return it as a Gemini inline-data part */
async function urlToInlinePart(url: string) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${url}`);
  const buffer = await res.arrayBuffer();
  const base64 = Buffer.from(buffer).toString("base64");
  const mimeType = (res.headers.get("content-type") ?? "image/jpeg").split(";")[0];
  return { inlineData: { data: base64, mimeType } };
}

/** Parse and validate the raw JSON string from Gemini */
function parseAndValidate(raw: string): AIProductAnalysis {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  const parsed: AIProductAnalysis = JSON.parse(cleaned);

  const matched = mockCategories.find((c) => c.id === parsed.category_id);
  if (!matched) {
    const fallback = mockCategories[0];
    parsed.category_id = fallback.id;
    parsed.category_path = fallback.path;
    parsed.category_code = fallback.code;
    parsed.commission_rate = fallback.commissionRate / 100;
  } else {
    parsed.commission_rate = matched.commissionRate / 100;
    parsed.category_path = matched.path;
    parsed.category_code = matched.code;
  }

  return parsed;
}

/**
 * Analyse product image URLs using Gemini 1.5 Flash (free tier).
 * Fetches each image server-side and sends as inline base64 data.
 */
export async function analyzeProductImages(
  imageUrls: string[]
): Promise<AIProductAnalysis> {
  if (!imageUrls.length) throw new Error("No images provided");

  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  // Fetch up to 4 images and convert to inline parts
  const imageParts = await Promise.all(
    imageUrls.slice(0, 4).map(urlToInlinePart)
  );

  const result = await model.generateContent([
    PROMPT + "\n\nAnalyse the product shown in the image(s) above.",
    ...imageParts,
  ]);

  const raw = result.response.text();

  try {
    return parseAndValidate(raw);
  } catch {
    throw new Error(`Gemini returned invalid JSON: ${raw.slice(0, 200)}`);
  }
}

/**
 * Generate listing content from a text description (AI mode, no image).
 */
export async function analyzeProductDescription(
  description: string
): Promise<AIProductAnalysis> {
  const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

  const result = await model.generateContent(
    PROMPT +
      `\n\nProduct description provided by seller:\n"${description}"\n\nFill in all fields based on this description.`
  );

  const raw = result.response.text();

  try {
    return parseAndValidate(raw);
  } catch {
    throw new Error(`Gemini returned invalid JSON: ${raw.slice(0, 200)}`);
  }
}
