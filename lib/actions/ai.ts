"use server";

import { mockCategories } from "@/lib/mock/categories";

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

// ─── Mock product templates ───────────────────────────────────────────────────
// Used when NEXT_PUBLIC_MOCK_AI=true (no API key required).
// Swap to real AI by setting OPENAI_API_KEY or GOOGLE_API_KEY in .env.local.

const MOCK_PRODUCTS: Omit<
  AIProductAnalysis,
  "category_id" | "category_path" | "category_code" | "commission_rate"
>[] = [
  {
    title: "Samsung Galaxy A55 5G Smartphone – 128GB – Awesome Navy",
    description:
      "The Samsung Galaxy A55 5G delivers a premium experience with its 6.6-inch Super AMOLED display and 50MP triple camera system. Built with a sleek aluminium frame and IP67 water resistance for everyday durability.",
    highlights:
      "• 6.6-inch Super AMOLED 120Hz display\n• 50MP OIS main camera + 12MP ultra-wide\n• 5000mAh battery with 25W fast charging\n• IP67 water and dust resistance\n• 5G connectivity for ultra-fast speeds",
    brand: "Samsung",
    color: "Navy Blue",
    color_family: "Navy Blue",
    weight_kg: 0.213,
    selling_price: 2199,
    model: "SM-A556E",
    main_material: "Aluminium",
    material_family: "Metal",
  },
  {
    title: "Sony WH-1000XM5 Wireless Noise-Cancelling Headphones – Black",
    description:
      "Industry-leading noise cancellation with the Sony WH-1000XM5 over-ear headphones. Enjoy up to 30 hours of battery life and crystal-clear hands-free calling with the integrated microphone system.",
    highlights:
      "• Industry-leading noise cancellation technology\n• 30-hour battery life with quick charge (3 min = 3 hrs)\n• Multi-device pairing via Bluetooth 5.2\n• Lightweight folding design at 250g\n• Hi-Res Audio and LDAC support",
    brand: "Sony",
    color: "Black",
    color_family: "Black",
    weight_kg: 0.25,
    selling_price: 1850,
    model: "WH-1000XM5",
    main_material: "Plastic",
    material_family: "Plastic",
  },
  {
    title: "Nike Air Max 270 Men's Running Shoes – White/Black – Size 42",
    description:
      "The Nike Air Max 270 features Nike's biggest heel Air unit yet for a super-soft ride. The breathable mesh upper and foam midsole deliver all-day comfort for casual wear and light training.",
    highlights:
      "• Largest heel Air unit for maximum cushioning\n• Breathable engineered mesh upper\n• Foam midsole for lightweight comfort\n• Rubber outsole for durable traction\n• Available in multiple colourways",
    brand: "Nike",
    color: "White",
    color_family: "White",
    weight_kg: 0.31,
    selling_price: 650,
    model: "AH8050-100",
    main_material: "Fabric",
    material_family: "Fabric",
  },
  {
    title: "Philips 1000W Stand Mixer – 5L Bowl – Silver",
    description:
      "The Philips Stand Mixer combines powerful 1000W motor performance with a generous 5-litre stainless steel bowl. Perfect for kneading dough, whipping cream, and mixing cake batter effortlessly.",
    highlights:
      "• 1000W powerful motor for heavy dough\n• 5-litre stainless steel mixing bowl\n• 6 speed settings + pulse function\n• Includes dough hook, whisk and beater\n• Non-slip base for stable operation",
    brand: "Philips",
    color: "Silver",
    color_family: "Silver",
    weight_kg: 4.8,
    selling_price: 890,
    model: "HR3745/00",
    main_material: "Metal",
    material_family: "Metal",
  },
  {
    title: "Polo Ralph Lauren Men's Classic Fit Polo Shirt – Navy – Size L",
    description:
      "The iconic Polo Ralph Lauren Classic Fit polo shirt in premium soft-touch piqué cotton. Features the embroidered Polo pony logo and a two-button placket for a timeless smart-casual look.",
    highlights:
      "• 100% soft-touch piqué cotton\n• Embroidered Polo pony logo at chest\n• Ribbed polo collar and sleeve cuffs\n• Classic fit with a clean, modern silhouette\n• Machine washable",
    brand: "Polo Ralph Lauren",
    color: "Navy Blue",
    color_family: "Navy Blue",
    weight_kg: 0.22,
    selling_price: 420,
    model: "710795080",
    main_material: "Fabric",
    material_family: "Fabric",
  },
];

/** Return a random mock template with a real category attached */
function buildMockAnalysis(): AIProductAnalysis {
  const template =
    MOCK_PRODUCTS[Math.floor(Math.random() * MOCK_PRODUCTS.length)];
  const cat =
    mockCategories[Math.floor(Math.random() * mockCategories.length)];

  return {
    ...template,
    category_id: cat.id,
    category_path: cat.path,
    category_code: cat.code,
    commission_rate: cat.commissionRate / 100,
  };
}

// ─── Attach category to a parsed result ──────────────────────────────────────

function attachCategory(parsed: AIProductAnalysis): AIProductAnalysis {
  const matched = mockCategories.find((c) => c.id === parsed.category_id);
  if (!matched) {
    const fallback = mockCategories[0];
    return {
      ...parsed,
      category_id: fallback.id,
      category_path: fallback.path,
      category_code: fallback.code,
      commission_rate: fallback.commissionRate / 100,
    };
  }
  return {
    ...parsed,
    commission_rate: matched.commissionRate / 100,
    category_path: matched.path,
    category_code: matched.code,
  };
}

// ─── AI provider (swap here when API credits are ready) ──────────────────────

async function callAI(prompt: string, imageUrls?: string[]): Promise<string> {
  // ── OpenAI (re-enable when credits are purchased) ─────────────────────────
  // import OpenAI from "openai";
  // const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  // const imageContent = (imageUrls ?? []).slice(0, 4).map((url) => ({
  //   type: "image_url" as const,
  //   image_url: { url, detail: "high" as const },
  // }));
  // const res = await openai.chat.completions.create({
  //   model: "gpt-4o", max_tokens: 1000,
  //   messages: [{ role: "user", content: [{ type: "text", text: prompt }, ...imageContent] }],
  // });
  // return res.choices[0]?.message?.content ?? "{}";

  // ── Google Gemini (re-enable when project quota is active) ────────────────
  // import { GoogleGenerativeAI } from "@google/generative-ai";
  // const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY!);
  // const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
  // ... (fetch image parts, call model.generateContent)

  // ── Mock mode — remove this block when switching to real AI ───────────────
  void prompt;
  void imageUrls;
  throw new Error("MOCK_MODE");
}

// ─── Public functions ─────────────────────────────────────────────────────────

/**
 * Analyse product image URLs.
 * Falls back to a realistic mock when no AI provider is configured.
 */
export async function analyzeProductImages(
  imageUrls: string[]
): Promise<AIProductAnalysis> {
  if (!imageUrls.length) throw new Error("No images provided");

  try {
    const raw = await callAI("Analyse this product.", imageUrls);
    const cleaned = raw.replace(/```json|```/g, "").trim();
    return attachCategory(JSON.parse(cleaned));
  } catch {
    // Mock fallback — realistic demo data while AI provider is being set up
    return buildMockAnalysis();
  }
}

/**
 * Generate listing content from a text description.
 * Falls back to a realistic mock when no AI provider is configured.
 */
export async function analyzeProductDescription(
  description: string
): Promise<AIProductAnalysis> {
  try {
    const raw = await callAI(
      `Generate a Jumia listing for: "${description}"`,
    );
    const cleaned = raw.replace(/```json|```/g, "").trim();
    return attachCategory(JSON.parse(cleaned));
  } catch {
    // Mock fallback
    return buildMockAnalysis();
  }
}
