"use server";

import OpenAI from "openai";
import { mockCategories } from "@/lib/mock/categories";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

const SYSTEM_PROMPT = `You are an expert Jumia GH marketplace listing assistant.
Analyse the provided product image(s) and return a JSON object with the following fields.
Be concise, accurate, and use proper title casing.

Available Jumia GH categories (id | name | path):
${CATEGORY_LIST}

Return ONLY valid JSON — no markdown fences, no explanation.`;

const USER_PROMPT = `Analyse this product and return a JSON object with these exact keys:
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

/**
 * Analyse product image URLs using GPT-4o Vision.
 * Returns structured listing data ready to pre-fill the Jumia form.
 */
export async function analyzeProductImages(
  imageUrls: string[]
): Promise<AIProductAnalysis> {
  if (!imageUrls.length) throw new Error("No images provided");

  // Use up to 4 images for analysis (keep token cost reasonable)
  const imageContent = imageUrls.slice(0, 4).map((url) => ({
    type: "image_url" as const,
    image_url: { url, detail: "high" as const },
  }));

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 1000,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: [{ type: "text", text: USER_PROMPT }, ...imageContent],
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";

  let parsed: AIProductAnalysis;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Strip any accidental markdown fences and retry
    const cleaned = raw.replace(/```json|```/g, "").trim();
    parsed = JSON.parse(cleaned);
  }

  // Validate category against known list, fallback to first if unknown
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
 * Generate listing content from a text description (AI mode, no image).
 */
export async function analyzeProductDescription(
  description: string
): Promise<AIProductAnalysis> {
  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 1000,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `${USER_PROMPT}\n\nProduct description provided by seller:\n"${description}"`,
      },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? "{}";
  let parsed: AIProductAnalysis;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  }

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
