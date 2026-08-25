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
import { pickModelForExtensionFill } from "@/lib/billing/ai-models";
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

/** Fields whose value must come ONLY from the seller's notes, never guessed
 *  or inferred from the image — see the SELLER-CONTROLLED block in the
 *  prompt built below. */
function isNotesOnlyField(label: string): boolean {
  const l = norm(label);
  return (
    l.includes("quantity") ||
    l.includes("sku") ||
    l.includes("gtin") ||
    l.includes("barcode") ||
    (l.includes("price") && !l.includes("sale")) ||
    (l.includes("sale") && (l.includes("start") || l.includes("end")))
  );
}

/** Per-field guidance appended to the prompt for common labels. */
function hintFor(f: HarvestedField): string {
  const l = norm(f.label);
  const constrained = Boolean(f.options?.length); // a select/combobox with a fixed choice list
  if (l.includes("name") && !l.includes("brand")) {
    return " — see CONTENT STYLE below for the exact title format. NEVER a single generic word (e.g. \"Generic\", \"Product\") — that has happened in production and is worse than leaving it blank.";
  }
  if (l.includes("brand")) return " — ONLY if a logo/wordmark is clearly visible; otherwise omit.";
  if (l.includes("description")) return " — see CONTENT STYLE below for the exact structure and tone.";
  if (l.includes("highlight")) return " — see CONTENT STYLE below for the exact bullet format.";
  if (l.includes("box")) return " — one item per line as <p>1x Item<br>1x Item</p> — a real line break between each item, never all on one line (Jumia's format).";
  if (l.includes("manufacturer")) return " — a short manufacturer blurb about the product.";
  if (l.includes("weight")) return " — your best estimate in kg (e.g. 0.2) for a product like this, even if you can't be exact from the photo alone — only omit if the category makes weight meaningless.";
  if (l.includes("quantity")) return " — ONLY if the seller's notes state an exact quantity; otherwise omit (never guess a stock count from the image).";
  if (l.includes("sku")) return " — ONLY if the seller's notes give one; otherwise a short plausible SKU code (uppercase letters + digits, 6–10 chars).";
  if (l.includes("gtin") || l.includes("barcode")) return " — ONLY if the seller's notes give a real GTIN/barcode; otherwise omit entirely. NEVER invent one — unlike SKU this is a real-world product identifier, and a fabricated one can conflict with Jumia's catalog.";
  if (l.includes("price") && !l.includes("sale")) return " — ONLY if the seller's notes state an exact price figure; otherwise omit (never guess a price from the image). Digits only — no currency symbol, commas, or words (e.g. \"210\", not \"GHS 210\").";
  if (l.includes("sale") && (l.includes("start") || l.includes("end"))) {
    return " — ONLY if the seller's notes explicitly give this date; otherwise omit entirely.";
  }
  // Default every warranty-related field to N/A — only depart from that when
  // the seller's notes actually say something about warranty (including a
  // "Warranty duration"/"Warranty address" note from the extension's
  // Advanced Options, which rides along in these same notes). When they do,
  // keep the Warranty Duration dropdown, the free-text Product warranty
  // terms, and the Warranty Address all consistent with that SAME
  // information, not independently guessed. "N/A" isn't automatically a
  // real choice in a constrained dropdown — only pick it (or "None") if the
  // options listed above actually offer one; some sellers' catalogs do,
  // some don't.
  if (l.includes("warranty") && l.includes("address")) {
    return constrained
      ? " — pick the option matching the seller's notes (including any \"Warranty address\" note), or omit if none fit."
      : " — the seller's warranty address if their notes give one (including any \"Warranty address\" note); otherwise \"N/A\".";
  }
  if (l.includes("warranty")) {
    return constrained
      ? " — default to \"N/A\"/\"None\" if the options above offer one, UNLESS the seller's notes state a warranty period (including any \"Warranty duration\" note) matching one of the OTHER options above — then pick that instead. If neither fits, omit."
      : " — default to \"N/A\", UNLESS the seller's notes state a warranty period or terms (including any \"Warranty duration\" note) — then describe that SAME period here, consistent with whatever you picked for a Warranty Duration field if the page has one.";
  }
  if (l.includes("color") || l.includes("colour")) return " — the product's visible colour.";
  if (l.includes("variation")) return " — the specific variant identifier for this listing (e.g. colour + material/size, like \"Brown Leather\" or \"Red - Large\"), your best read from the image. If the seller's notes explicitly state the variation, use that instead — it always overrides your own guess.";
  return " — infer from the image; keep it short and accurate, or omit if unknown.";
}

function fieldLine(f: HarvestedField): string {
  const opts = f.options?.length ? `; choose ONE of: ${f.options.slice(0, 40).join(" | ")}` : "";
  return `- "${f.label}" [${f.type}${opts}]${hintFor(f)}`;
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

  const notesOnlyFields = fields.filter((f) => isNotesOnlyField(f.label)).map((f) => f.label);
  const notesOnlyBlock = notesOnlyFields.length
    ? `\n\nSELLER-CONTROLLED FIELDS — ${notesOnlyFields.map((l) => `"${l}"`).join(", ")}: fill these ONLY if the seller notes above state them explicitly. Never infer or guess these from the photo. No seller notes (or the notes don't mention it) → omit the field.\n`
    : "";

  // Modeled on real high-performing Jumia listings (Kelvin's own examples,
  // Aug 2026) — only included when the fields that need it are on the page.
  const hasName = fields.some((f) => { const l = norm(f.label); return l.includes("name") && !l.includes("brand"); });
  const hasDescription = fields.some((f) => norm(f.label).includes("description"));
  const hasHighlights = fields.some((f) => norm(f.label).includes("highlight"));
  const styleGuideBlock = hasName || hasDescription || hasHighlights
    ? `\n\nCONTENT STYLE:\n${[
        hasName &&
          `- Name/title: genuinely descriptive and SEO-rich — TYPE + the specific, real details a buyer would search for (material, colour, size, pack count/quantity, capacity, a key feature), roughly 6–12 words long (e.g. "Wholesale Pack of 30 Gold Award Medals with Ribbons", not "Medals"). NEVER a single generic word or phrase ("Generic", "Product", "Item") — if the image genuinely doesn't give you enough to write a real title, omit the field entirely rather than writing something vague; a blank field the seller fills in is far better than a title that says nothing. No ALL CAPS, no keyword repetition/stuffing, no brand name (Jumia rejects titles containing the brand).`,
        hasDescription &&
          `- Description: 2–4 short <p> paragraphs, not one dense block. Open with a one-sentence hook naming the product (you may bold it inline). Weave <strong>key spec/feature phrases</strong> naturally into the sentences as you go — including as a bold micro-heading directly followed by more prose in the same paragraph (e.g. "<strong>Effortless Slicing.</strong> The large, smooth-rolling wheel glides through..."). If the product clearly suits distinct use-cases or buyer types, you may close with a short "Perfect for:" <ul> where each <li> starts with a bold audience/use-case and a colon.`,
        hasHighlights &&
          `- Highlights: a <ul><li>, 4–6 items, EVERY item shaped exactly like <li><strong>Short Feature Label</strong>: one clear sentence on the benefit.</li> (label 2–4 words). When the product has clear technical specs (dimensions, ingredients, materials, capacity, servings), lead with a 2-column <table> (<tr><td>Spec</td><td>Value</td></tr> per row) before the bullets.`,
      ].filter(Boolean).join("\n")}\n- Never end description or highlights with a request for reviews/feedback/ratings — keep the content to the product itself.\n`
    : "";

  const prompt = `You are a product-listing assistant for Jumia (market: ${market}). Look at the product image and fill the EXACT form fields listed below so the listing is accurate, SEO-friendly, and passes Jumia QC.

${policy}

${restricted}
${notesBlock}${notesOnlyBlock}${styleGuideBlock}
FIELDS TO FILL (return a value only for the ones you can confidently fill; omit the rest):
${fields.map(fieldLine).join("\n")}

RULES:
- Return ONLY a JSON object mapping each field label EXACTLY as written above (including punctuation and capitalisation) to a string value.
- Rich-text fields: return HTML, well-structured (see CONTENT STYLE above) — not a single flat paragraph.
- Fields listing options: return exactly one of the given options, or omit.
- Numbers: digits only, no units or words.
- NEVER invent price or stock.
- For the seller-controlled fields listed above (if any): only from the seller's notes, never from the photo.
- Omit any other field you cannot fill confidently — do not guess.

Return ONLY the JSON object, no markdown, no commentary.`;

  const parts: GeminiPart[] = [
    { text: prompt },
    { inlineData: { data: imageBase64, mimeType } },
  ];

  const model = pickModelForExtensionFill();
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
