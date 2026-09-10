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
import { stripRestrictedWords } from "@/lib/ai/restricted-words";
import { buildStyleGuideBlock, buildSearchGroundingInstruction } from "@/lib/ai/content-style-rules";
import { isDegenerateName, type HarvestedField } from "@/lib/extension/fill";

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
  if (l.includes("manufacturer")) {
    return " — DO fill this: 1–2 short sentences in the manufacturer's own voice about how the product is made and what it's made of (materials, construction, quality standards). It is NOT a duplicate of the product description, so don't skip it as redundant — write it from the same facts with a maker's focus.";
  }
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
      ? " — default to whichever of \"N/A\"/\"None\" is LITERALLY PRESENT in THIS field's own option list above (some categories offer neither — check before writing it, and omit instead if neither is there), UNLESS the seller's notes state a warranty period (including any \"Warranty duration\" note) matching one of the OTHER options above — then pick that instead."
      : " — default to \"N/A\", UNLESS the seller's notes state a warranty period or terms (including any \"Warranty duration\" note) — then describe that SAME period here, consistent with whatever you picked for a Warranty Duration field if the page has one.";
  }
  // "Color family"/"Material family" are their own fields, distinct from
  // "Color"/"Main material" — confirmed live: giving them the same generic
  // hint as the base attribute made the AI fill the base field from an
  // explicit seller note (e.g. "color family is black") and then treat the
  // "family" field as a separate, less-certain attribute it left blank,
  // even though here it's the same value. Point it at both the base
  // attribute and the notes explicitly.
  if (l.includes("family")) {
    return " — the broader category for the more specific attribute elsewhere on this page (e.g. if Color is \"Navy Blue\", Color family is \"Blue\"; if Main material is \"Stainless Steel\", Material family is \"Metal\"). Often the same value as that attribute for a simple case (e.g. Color \"Black\" → Color family \"Black\"). Check the seller's notes for an explicit mention of this exact field first (e.g. \"color family is black\") and use that if given, even if it just repeats the base attribute.";
  }
  if (l.includes("color") || l.includes("colour")) return " — the product's visible colour.";
  if (l.includes("variation")) return " — the specific variant identifier for this listing (e.g. colour + material/size, like \"Brown Leather\" or \"Red - Large\"), your best read from the image. If the seller's notes explicitly state the variation, use that instead — it always overrides your own guess.";
  return " — infer from the image; keep it short and accurate, or omit if unknown.";
}

function fieldLine(f: HarvestedField): string {
  // Matches content.js's harvest-side cap (250) — confirmed live: a lower
  // cap here (previously 40) silently hid most of a long option list (e.g.
  // Production country's ~195 real countries) from the AI even when
  // content.js had already harvested them all, so it could never pick one
  // outside the first 40.
  // A multi-select widget (checkbox rows — Color family, Material family,
  // Certifications) genuinely accepts several values; saying "choose ONE of"
  // there is what kept Color family and Material family permanently empty
  // whenever more than one option applied.
  const choose = f.multi
    ? "choose one or MORE of (comma-separate several only when they genuinely all apply)"
    : "choose ONE of";
  // Generic, per-field enforcement — applies to EVERY constrained field
  // regardless of what it's called, since the exact set of options (and
  // whether a filler choice like "N/A"/"None" is even offered) differs by
  // Jumia category and by field. Stated right next to THIS field's own list
  // rather than only once globally, so it can't get lost across a long
  // FIELDS TO FILL block. Confirmed live: the model wrote "N/A" for a
  // "Warranty Type" whose real options didn't include any N/A-like choice —
  // it gets silently dropped downstream (finalizeAiValues' snapToOption),
  // so a guessed filler is strictly worse than omitting: same end result
  // (blank field) but sometimes it accidentally overwrites a value the
  // fuzzy matcher WOULD have accepted (a close real option).
  const opts = f.options?.length
    ? `; ${choose}: ${f.options.slice(0, 250).join(" | ")}. Copy your answer EXACTLY as printed in THIS list (same spelling/punctuation) or omit the field — never write "N/A"/"None"/"Not Applicable"/"Other" or any other filler UNLESS that exact text is itself one of the options printed above for this field.`
    : "";
  const current = f.currentValue ? `; CURRENT CONTENT: "${f.currentValue.replace(/"/g, "'")}"` : "";
  return `- "${f.label}" [${f.type}${opts}]${current}${hintFor(f)}`;
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
  images:      { base64: string; mimeType: string }[]; // one or more angles of the same product
  fields:      HarvestedField[];
  notes?:      string;
  market?:     string;
}): Promise<AiFillResult> {
  const { images, notes, market = "GH" } = args;
  const warnings: string[] = [];

  // A field's currentValue that's already degenerate (a stale "Generic"
  // name, most likely written by an earlier bug or an earlier AI slip)
  // must never be shown to the AI as "current content" to weigh keeping —
  // confirmed live: doing so made the AI echo the same "Generic" straight
  // back instead of writing a real title, because the EXISTING CONTENT
  // instruction to "keep it if it's already good" won out over the
  // CONTENT STYLE rule banning that exact word. Strip it so the field
  // reads as blank instead, with nothing for the AI to anchor on.
  const fields = args.fields.map((f) => {
    const l = norm(f.label);
    if (f.currentValue && l.includes("name") && !l.includes("brand") && isDegenerateName(f.currentValue)) {
      return { ...f, currentValue: undefined };
    }
    return f;
  });

  // buildContentPolicyInstructions() already embeds the restricted-words
  // block internally (it calls buildRestrictedWordsInstruction() itself) —
  // don't add a second copy here, that was ~1,000 wasted characters on
  // every single call for zero extra instruction value.
  const policy = buildContentPolicyInstructions({ categoryPath: null, includeImageRules: false });
  // Bundles the free-text notes box AND every Advanced Option the panel
  // exposes (Writing style, Refund policy, Warranty duration, Warranty
  // address — see panel.js's extraNotes array) into one string before this
  // function ever sees it. Framed as unconditional top priority, not just
  // "fills factual gaps": a seller who explicitly picked a Writing style is
  // giving a direct instruction, not a soft preference, and it must win
  // over CONTENT STYLE's own default tone/structure below when the two
  // disagree — that default exists for when the seller didn't specify one
  // (SEO Optimized, the pre-selected option), not as a rule that overrides
  // an explicit seller choice.
  const notesBlock = notes && notes.trim()
    ? `\n\nSELLER NOTES — HIGHEST PRIORITY, OVERRIDES ANY OTHER INSTRUCTION IN THIS PROMPT IF THEY CONFLICT:\n"${notes.trim()}"\nThis is the seller's own free text plus every Advanced Option they set (Writing style, Refund policy, Warranty duration, Warranty address, if present) — treat each one as a direct instruction, not a soft suggestion. If a "Writing style" is given (e.g. Storytelling, Fun & Playful, Professional & Clean, Friendly & Conversational), let it govern the tone and voice of Description/Highlights — CONTENT STYLE's own structural suggestions below (the hook, bold micro-headings, "Perfect for:" list) are the strong default for "SEO Optimized" or when no writing style is given, not a rule that overrides the seller's explicit choice.\n`
    : "";

  const notesOnlyFields = fields.filter((f) => isNotesOnlyField(f.label)).map((f) => f.label);
  const notesOnlyBlock = notesOnlyFields.length
    ? `\n\nSELLER-CONTROLLED FIELDS — ${notesOnlyFields.map((l) => `"${l}"`).join(", ")}: fill these ONLY if the seller notes above state them explicitly. Never infer or guess these from the photo. No seller notes (or the notes don't mention it) → omit the field.\n`
    : "";

  // See lib/ai/content-style-rules.ts — the file to edit when reviewing
  // real listings, not here.
  const styleGuideBlock = buildStyleGuideBlock(fields);
  // Unconditional — see buildSearchGroundingInstruction's own doc comment
  // for why this isn't gated to fields the way styleGuideBlock is.
  const searchGroundingBlock = buildSearchGroundingInstruction();

  // Set only for Name/Description/Highlights on an Edit-Product page that
  // already carry real seller content — see isNarrativeLabel in content.js.
  // Product photos are never part of this: the extension never harvests or
  // writes to image fields at all, so they're always left exactly as-is.
  const hasExistingContent = fields.some((f) => f.currentValue);
  const existingContentBlock = hasExistingContent
    ? `\n\nEXISTING CONTENT: This is an already-published Jumia listing being re-filled, not a blank form — some fields below are marked CURRENT CONTENT with what the seller already has there. For each one: if it's already good (accurate, complete, well-written), return it back unchanged — light polish only. If it's weak, generic, incomplete, or has real facts worth keeping buried in bad writing, rewrite it following CONTENT STYLE below, preserving those genuine facts. If it's placeholder junk or nonsense, treat it as blank and write fresh content. If you omit one of these fields entirely, its current content is left exactly as it is — fine when you're genuinely unsure, but don't omit just to dodge the decision.\n`
    : "";

  // A multi-variant listing repeats the same per-variant fields once per
  // variant, so content.js suffixes each with " (Variant N)" to keep them
  // distinct. Without this block the AI sees several near-identical field
  // names and has no idea they're meant to differ.
  const variantCount = fields.reduce((max, f) => Math.max(max, f.variantIndex ?? 0), 0);
  const variantsBlock = variantCount > 1
    ? `\n\nVARIANTS: This listing has ${variantCount} variants. Fields ending in "(Variant N)" belong to variant N — they are SEPARATE products sharing one listing, so give each its own DISTINCT values, never the same answer repeated. If the seller's notes name the variants (e.g. "two variations black and brown"), assign them in the order given: the first named goes to Variant 1, the second to Variant 2, and so on. Each variant's "Variation" field is its distinguishing attribute (its colour/size/material), and its "Seller SKU" must be unique — derive it from the shared product code plus that variant's own attribute (e.g. "WIG-ST18-BLK" and "WIG-ST18-BRN"). Every field WITHOUT a "(Variant N)" suffix is shared by the whole listing — fill it once, describing the product as a whole rather than any single variant.\n`
    : "";

  // Told explicitly when there's more than one photo — otherwise nothing
  // here tells the model these images are several angles of the SAME item
  // rather than unrelated pictures, which matters for it to actually use a
  // second/third angle (a back-of-pack label, a size chart, a close-up)
  // instead of just reading the first and ignoring the rest.
  const imagesNote = images.length > 1
    ? ` You are shown ${images.length} photos of the SAME product from different angles — use all of them together (a back label, a size chart, or a close-up may show details the main photo doesn't) rather than just the first.`
    : "";

  const prompt = `You are a product-listing assistant for Jumia (market: ${market}). Look at the product image${images.length > 1 ? "s" : ""} and fill the EXACT form fields listed below so the listing is accurate, SEO-friendly, and passes Jumia QC.${imagesNote}

${policy}

${notesBlock}${notesOnlyBlock}${searchGroundingBlock}${styleGuideBlock}${existingContentBlock}${variantsBlock}
FIELDS TO FILL (return a value only for the ones you can confidently fill; omit the rest):
${fields.map(fieldLine).join("\n")}

RULES:
${notes && notes.trim() ? "- SELLER NOTES above beats every other instruction in this prompt when they conflict — that includes CONTENT STYLE's default tone/structure, not just factual details.\n" : ""}- Return ONLY a JSON object mapping each field label EXACTLY as written above (including punctuation and capitalisation) to a string value.
- Rich-text fields: return HTML, well-structured (see CONTENT STYLE above) — not a single flat paragraph.
- Fields listing options: copy your answer EXACTLY as printed in THAT field's own list (same spelling/punctuation), or omit. Never write "N/A"/"None"/"Not Applicable"/"Other" as a safe-looking default — only write it when that exact text is itself one of the options listed for that specific field, which varies by field and by category.
- Numbers: digits only, no units or words.
- NEVER invent price or stock.
- For the seller-controlled fields listed above (if any): only from the seller's notes, never from the photo.
- Omit any other field you cannot fill confidently — do not guess.
- Jumia shows every attribute its category template defines, and some simply do not apply to this product. If an attribute is meaningless for what's in the photo (e.g. "Skin Type" or "Volume" on a wig, "Hair Type" on a saucepan), OMIT it — leave it for the seller. Never reach for a catch-all like "All", "Other", "Not Applicable" or "N/A" just to put something in the box; a blank irrelevant field is better than a filled meaningless one. This does NOT apply to the warranty fields, whose N/A default is deliberate and described above.

Return ONLY the JSON object, no markdown, no commentary.`;

  const parts: GeminiPart[] = [
    { text: prompt },
    ...images.map((img): GeminiPart => ({ inlineData: { data: img.base64, mimeType: img.mimeType } })),
  ];

  // Sep 3 2026: gemini-3.1-flash-lite via AI STUDIO — see
  // MODEL_EXTENSION_FILL's comment in lib/billing/ai-models.ts for the full
  // history. This is NOT a repeat of the earlier 3.1-on-Vertex attempt: that
  // one 404'd because Vertex's Publisher Model catalogue for this project
  // doesn't carry the 3.x line at all (confirmed live, twice) — AI Studio's
  // catalogue does, so preferBackend is switched to match. If GOOGLE_API_KEY
  // is ever unset in the Vercel env, callGeminiBackend silently falls back
  // to Vertex and this exact model 404s again — check the `[gemini]
  // backend=` log line after deploying a change here, don't assume.
  const model = pickModelForExtensionFill();
  const t0 = Date.now();
  const { text, backend } = await callGeminiBackend(model, parts, {
    preferBackend: "ai-studio",
    groundWithSearch: true,
  });
  console.info(`[ext/ai-fill] model=${model} backend=${backend} ms=${Date.now() - t0} images=${images.length} fields=${fields.length}`);

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
