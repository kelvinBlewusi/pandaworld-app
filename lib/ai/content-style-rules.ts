/**
 * Content-style rules for AI-generated listing copy (Name, Description,
 * Highlights) — the "what does a genuinely good Jumia listing read like"
 * rules fed into the extension's fill prompt.
 *
 * This is the file to edit after reviewing real listings (Kelvin's own
 * best-performing ones, or strong competitor listings) — not
 * lib/ai/extension-fill.ts, which only assembles the prompt around
 * whatever `buildStyleGuideBlock` returns here.
 *
 * Modeled on real high-performing Jumia listings (Kelvin's own examples,
 * Aug 2026).
 */

import type { HarvestedField } from "@/lib/extension/fill";

const norm = (s: string) => s.toLowerCase().replace(/\*/g, "").replace(/\s+/g, " ").trim();

export interface ContentStyleRule {
  /** Matches a normalized harvested field label (e.g. "name", "product description"). */
  appliesTo: (normalizedLabel: string) => boolean;
  rule: string;
}

export const CONTENT_STYLE_RULES: ContentStyleRule[] = [
  {
    appliesTo: (l) => l.includes("name") && !l.includes("brand"),
    rule: `Name/title: genuinely descriptive and SEO-rich — TYPE + the specific, real details a buyer would search for (material, colour, size, pack count/quantity, capacity, a key feature), roughly 6–12 words long (e.g. "Wholesale Pack of 30 Gold Award Medals with Ribbons", not "Medals"). NEVER a single generic word or phrase ("Generic", "Product", "Item") — if the image genuinely doesn't give you enough to write a real title, omit the field entirely rather than writing something vague; a blank field the seller fills in is far better than a title that says nothing. No ALL CAPS, no keyword repetition/stuffing, no brand name (Jumia rejects titles containing the brand).`,
  },
  {
    appliesTo: (l) => l.includes("description"),
    rule: `Description: free-form — prose paragraphs, a <table>, a <ul>, or any mix, whichever combination best showcases THIS specific product. Not locked to a fixed paragraph count or a single format: a story-led product may read best as flowing prose, a spec-heavy one may lead with a <table> before any prose, and most products benefit from a mix. Tables aren't capped at a 2-column Spec/Value layout — use as many columns and rows as the content genuinely calls for (e.g. a size chart, a multi-variant comparison, a nutrition/ingredients breakdown), whichever shape actually fits what you're presenting. Write as much genuine, specific detail as the product actually earns — real materials, dimensions, use-cases, construction, care instructions, whatever the image and notes actually support — rather than capping yourself at a short blurb when there's real substance to explain. Never pad with filler sentences just to run longer; length should come from genuine detail, not repetition or vague marketing phrases — but "don't pad" is not license to stop after four sentences: a single short paragraph (roughly under 120 words) is TOO SHORT for any real product, including a simple one — even "just a medal" has real things to say once you look past the obvious (what it's made of, how it's finished, who buys it and why, how it compares to a cheaper version, how it's meant to be used or displayed). Aim for roughly 150–350 words on a straightforward product, and meaningfully more when the product actually has more to say (multiple use-cases, technical specs, connected features) — find that substance rather than settling for the first four sentences that come to mind.
  Open with a one-sentence hook naming the product (may bold it inline). Weave <strong>key spec/feature phrases</strong> naturally into the prose as you go — including as a bold micro-heading directly followed by more prose in the same paragraph (e.g. "<strong>Effortless Slicing.</strong> The large, smooth-rolling wheel glides through..."). Nearly every product has at least one or two genuine buyer/use-case angles (occasion, recipient, setting) — close with a "Perfect for:" <ul> where each <li> starts with a bold audience/use-case and a colon, unless the product is truly single-purpose with nothing real to say there.
  ONLY if the product genuinely needs it (a connected/app-paired device, anything charged/battery-powered, or anything with a real first-use step a buyer could get wrong) — append:
    - A "Getting Started" <ul> of the ACTUAL steps for THIS product (e.g. charge before first use, pair via Bluetooth, download a named companion app if the image/notes show one) — never invented steps for a feature the product doesn't have.
    - A "Common Questions" section (a <table> or a <ul> of <li><strong>Q: ...</strong> A: ...</li>) covering 2–3 questions a buyer would ACTUALLY ask about this specific product (charging, connectivity, first-use behavior) — genuine and specific to what's shown, never generic filler.
  NEVER include store-promotional filler unrelated to this specific product — "welcome to our store," "follow us for updates," or similar. That's not product information and has no place in the description regardless of what competitor listings do.`,
  },
  {
    appliesTo: (l) => l.includes("highlight"),
    rule: `Highlights: free-form, like Description above — a <ul><li> list, prose paragraphs, a <table>, or any mix, whichever combination best fits what THIS product actually has to say. NOT locked to a fixed bullet format or a fixed item count. A bulleted list (each item like <li><strong>Short Feature Label</strong>: one or more sentences of real, specific benefit</li>) is a strong common default, especially for feature-dense products — but when the product has clear technical specs (dimensions, ingredients, materials, capacity, servings), lead with a <table> — not capped at 2 columns, use however many the specs actually need — and a story-led or premium product may read better as two short prose paragraphs than five clipped bullets. Write as much genuine, specific detail per point as the product warrants — don't cut yourself off at one short sentence if there's real substance to explain — but never pad with filler just to sound longer or more thorough. NEVER write a highlight as a single short clause restating the label (e.g. "Durable Design: Built to last as a lasting memento") — that's too thin to be useful. Every item needs the actual WHY or HOW behind it: what it's made of, how it achieves the benefit, or what makes this product's version of that feature genuinely good — if a highlight could be copy-pasted onto any competing product unchanged, it isn't specific enough yet.`,
  },
];

/** Always-on closing rule, appended once whenever any rule above applies. */
const CLOSING_RULE =
  "Never end description or highlights with a request for reviews/feedback/ratings — keep the content to the product itself.";

/**
 * Builds the CONTENT STYLE prompt block for whichever of the rules above
 * are relevant to this page's harvested fields. Empty string when none
 * apply (e.g. a page with no Name/Description/Highlights field at all).
 */
export function buildStyleGuideBlock(fields: HarvestedField[]): string {
  const labels = fields.map((f) => norm(f.label));
  const applicable = CONTENT_STYLE_RULES.filter((r) => labels.some((l) => r.appliesTo(l)));
  if (!applicable.length) return "";
  const lines = applicable.map((r) => `- ${r.rule}`).join("\n");
  return `\n\nCONTENT STYLE:\n${lines}\n- ${CLOSING_RULE}\n`;
}

/**
 * Always-on search-grounding instruction — covers structured attributes
 * (Model, Main material, Country of origin, Certifications, and similar
 * exact-value fields) as well as Description/Highlights. Previously this
 * lived as one of the CONTENT_STYLE_RULES above, gated to only show up when
 * a Description/Highlights field was present — but that gating only ever
 * restricted the PROMPT INSTRUCTION telling the model to search; the
 * `google_search` tool itself (see gemini-client.ts's `groundWithSearch`) is
 * already enabled for the whole call regardless of which fields exist, so a
 * category with, say, "Model" and "Country of origin" but no free-text
 * Description was getting zero benefit from a tool it already had access to.
 * Unconditional now — not filtered through buildStyleGuideBlock, since this
 * isn't a narrative-writing style choice, it's a factual-accuracy aid that
 * applies to any field.
 */
export function buildSearchGroundingInstruction(): string {
  return `\n\nWEB SEARCH: You have web search available for every field below, not just Description/Highlights. When you can identify the specific brand/model with real confidence from the image, use it: for Description/Highlights, look up and use genuine facts (verified specs, materials, certifications, typical dimensions/capacity, how it compares to similar products) instead of guessing from the photo alone — real, specific, searched-up facts make for a noticeably stronger listing than vague description. For structured attributes (Model, Main material, Country of origin, Certifications, and similar exact-value fields), search to confirm the precise real value rather than guessing a plausible-sounding one. Only use a searched-up fact when you're genuinely confident the result is about THIS exact product, not a similar-looking or differently-specced one — when unsure, rely on what's visibly true or omit the field per the normal rules, rather than inventing or misattributing detail. For Description/Highlights specifically: never surface the search itself in the copy — no source links, "according to [site]," citation markers, or anything that reads as a research summary; the listing should read as the seller's own confident description, with the sourcing invisible. For a structured field, the value itself must be a real value in Jumia's own format for that field — never a citation, URL, or a phrase like "according to the manufacturer."\n`;
}
