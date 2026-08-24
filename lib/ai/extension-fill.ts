/**
 * Real-AI fill pass for the Chrome extension.
 *
 * Given the product image (inline base64 — no storage round-trip) plus the
 * EXACT fields the extension harvested from Jumia's rendered form and the
 * seller's notes, ask Gemini for a value per field. Because we send whatever
 * fields the page showed, this fills category-specific attributes on ANY
 * category — the whole point of the extension.
 *
 * Reuses the existing Gemini backend (Vertex/AI Studio), the pinned own-images
 * model, and the Jumia content policy + restricted-words rules — but imports
 * none of the Clerk-bound server actions, so a route with stubbed auth can call
 * it directly.
 */

import { callGeminiBackend, isVertexEnabled, type GeminiPart } from "@/lib/ai/gemini-client";
import { pickModelForOwnImagesFlow } from "@/lib/billing/ai-models";
import { buildContentPolicyInstructions, stripBrandFromTitle } from "@/lib/ai/jumia-content-policy";
import { buildRestrictedWordsInstruction, stripRestrictedWords } from "@/lib/ai/restricted-words";
import type { HarvestedField } from "@/lib/extension/fill";

export interface AiFillResult {
  raw:      Record<string, string>; // value per field label, policy-cleaned
  warnings: string[];
  usedModel: string;
}

/** True when a Gemini backend is configured (Vertex service account or AI Studio key). */
export function aiConfigured(): boolean {
  return isVertexEnabled() || Boolean(process.env.GOOGLE_API_KEY);
}

const norm = (s: string) => s.toLowerCase().replace(/\*/g, "").replace(/\s+/g, " ").trim();

/** Per-field guidance appended to the prompt for common labels. */
function hintFor(label: string): string {
  const l = norm(label);
  if (l.includes("name") && !l.includes("brand")) {
    return " — concise product title (type + key specs). OMIT the brand name; Jumia rejects titles containing the brand.";
  }
  if (l.includes("brand")) return " — ONLY if a logo/wordmark is clearly visible; otherwise omit.";
  if (l.includes("description")) return " — 150–400 words, HTML allowed (<p>, <ul>, <li>, <strong>). Marketing tone OK. No prices, no contact info.";
  if (l.includes("highlight")) return " — at least 4 key features as <ul><li>…</li></ul>.";
  if (l.includes("box")) return " — contents as <p>1x Item<br>1x Item</p> (Jumia's format).";
  if (l.includes("manufacturer")) return " — a short manufacturer blurb about the product.";
  if (l.includes("weight")) return " — a number only, in kg (e.g. 0.2). Omit if unknown.";
  if (l.includes("warranty") && l.includes("address")) return " — a warranty address, or \"N/A\".";
  if (l.includes("warranty")) return " — warranty terms, or \"N/A\".";
  if (l.includes("color") || l.includes("colour")) return " — the product's visible colour.";
  return " — infer from the image; keep it short and accurate, or omit if unknown.";
}

function fieldLine(f: HarvestedField): string {
  const opts = f.options?.length ? `; choose ONE of: ${f.options.slice(0, 40).join(" | ")}` : "";
  return `- "${f.label}" [${f.type}${opts}]${hintFor(f.label)}`;
}

function parseJsonObject(text: string): Record<string, unknown> {
  let t = text.trim();
  // Strip ```json … ``` fences if present.
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) t = t.slice(first, last + 1);
  return JSON.parse(t) as Record<string, unknown>;
}

/**
 * Run the vision fill pass. `fields` should already exclude seller-owned
 * fields (price/stock/etc.) — those are never AI-filled.
 */
export async function aiFillRenderedFields(args: {
  imageBase64: string;   // raw base64 (no data: prefix)
  mimeType:    string;
  fields:      HarvestedField[];
  notes?:      string;
  market?:     string;
}): Promise<AiFillResult> {
  const { imageBase64, mimeType, fields, notes, market = "GH" } = args;
  const warnings: string[] = [];

  const policy = buildContentPolicyInstructions({ categoryPath: null, includeImageRules: false });
  const restricted = buildRestrictedWordsInstruction();
  const notesBlock = notes && notes.trim()
    ? `\n\nSELLER NOTES (authoritative for anything the image doesn't show):\n"${notes.trim()}"\n`
    : "";

  const prompt = `You are a product-listing assistant for Jumia (market: ${market}). Look at the product image and fill the EXACT form fields listed below so the listing is accurate, SEO-friendly, and passes Jumia QC.

${policy}

${restricted}
${notesBlock}
FIELDS TO FILL (return a value only for the ones you can confidently fill; omit the rest):
${fields.map(fieldLine).join("\n")}

RULES:
- Return ONLY a JSON object mapping each field label EXACTLY as written above (including punctuation and capitalisation) to a string value.
- Rich-text fields: return HTML. Bulleted fields use <ul><li>…</li></ul>.
- Fields listing options: return exactly one of the given options, or omit.
- Numbers: digits only, no units or words.
- NEVER invent price, stock, quantity, or SKU.
- Omit any field you cannot fill confidently — do not guess.

Return ONLY the JSON object, no markdown, no commentary.`;

  const parts: GeminiPart[] = [
    { text: prompt },
    { inlineData: { data: imageBase64, mimeType } },
  ];

  const model = pickModelForOwnImagesFlow("vision");
  const t0 = Date.now();
  const { text, backend } = await callGeminiBackend(model, parts);
  console.info(`[ext/ai-fill] model=${model} backend=${backend} ms=${Date.now() - t0} fields=${fields.length}`);

  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonObject(text);
  } catch (e) {
    throw new Error(`AI returned unparseable JSON: ${(e as Error).message}`);
  }

  // Resolve the brand first so we can strip it from the title.
  const brandKey = fields.find((f) => norm(f.label).includes("brand"))?.label;
  const brandVal = brandKey ? String(parsed[brandKey] ?? "").trim() : "";

  const raw: Record<string, string> = {};
  for (const f of fields) {
    const v = parsed[f.label];
    if (v == null) continue;
    let value = String(v).trim();
    if (!value) continue;

    const l = norm(f.label);
    // Clean prose fields against Jumia's banned-word list.
    if (f.type === "richtext" || l.includes("name") || l.includes("description") || l.includes("highlight")) {
      value = stripRestrictedWords(value);
    }
    // Never let the brand appear in the title.
    if (l.includes("name") && !l.includes("brand") && brandVal && brandVal.toLowerCase() !== "generic") {
      value = stripBrandFromTitle(value, brandVal) || value;
    }
    raw[f.label] = value;
  }

  return { raw, warnings, usedModel: model };
}
