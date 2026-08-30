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
    rule: `Description: free-form, up to Jumia's 3000-character limit — prose paragraphs, a <table>, a <ul>, or any mix, whichever combination best showcases THIS specific product. Not locked to a fixed paragraph count or a single format: a story-led product may read best as flowing prose, a spec-heavy one may lead with a <table> before any prose, and most products benefit from a mix. Tables aren't capped at a 2-column Spec/Value layout — use as many columns and rows as the content genuinely calls for (e.g. a size chart, a multi-variant comparison, a nutrition/ingredients breakdown), whichever shape actually fits what you're presenting. Write as much genuine, specific detail as the product actually earns — real materials, dimensions, use-cases, construction, care instructions, whatever the image and notes actually support — rather than capping yourself at a short blurb when there's real substance to explain. Never pad with filler sentences just to run longer; length should come from genuine detail, not repetition or vague marketing phrases.
  Open with a one-sentence hook naming the product (may bold it inline). Weave <strong>key spec/feature phrases</strong> naturally into the prose as you go — including as a bold micro-heading directly followed by more prose in the same paragraph (e.g. "<strong>Effortless Slicing.</strong> The large, smooth-rolling wheel glides through..."). If the product clearly suits distinct use-cases or buyer types, you may close with a "Perfect for:" <ul> where each <li> starts with a bold audience/use-case and a colon.
  ONLY if the product genuinely needs it (a connected/app-paired device, anything charged/battery-powered, or anything with a real first-use step a buyer could get wrong) — append:
    - A "Getting Started" <ul> of the ACTUAL steps for THIS product (e.g. charge before first use, pair via Bluetooth, download a named companion app if the image/notes show one) — never invented steps for a feature the product doesn't have.
    - A "Common Questions" section (a <table> or a <ul> of <li><strong>Q: ...</strong> A: ...</li>) covering 2–3 questions a buyer would ACTUALLY ask about this specific product (charging, connectivity, first-use behavior) — genuine and specific to what's shown, never generic filler.
  NEVER include store-promotional filler unrelated to this specific product — "welcome to our store," "follow us for updates," or similar. That's not product information and has no place in the description regardless of what competitor listings do.`,
  },
  {
    appliesTo: (l) => l.includes("highlight"),
    rule: `Highlights: free-form, like Description above — a <ul><li> list, prose paragraphs, a <table>, or any mix, whichever combination best fits what THIS product actually has to say. NOT locked to a fixed bullet format or a fixed item count. A bulleted list (each item like <li><strong>Short Feature Label</strong>: one or more sentences of real, specific benefit</li>) is a strong common default, especially for feature-dense products — but when the product has clear technical specs (dimensions, ingredients, materials, capacity, servings), lead with a <table> — not capped at 2 columns, use however many the specs actually need — and a story-led or premium product may read better as two short prose paragraphs than five clipped bullets. Write as much genuine, specific detail per point as the product warrants — don't cut yourself off at one short sentence if there's real substance to explain — but never pad with filler just to sound longer or more thorough.`,
  },
  {
    appliesTo: (l) => l.includes("description") || l.includes("highlight"),
    rule: `You have web search available — use it. When you can identify the specific brand/model with real confidence from the image, look up and use genuine facts about it (verified specs, materials, certifications, typical dimensions/capacity, how it compares to similar products) instead of guessing from the photo alone; real, specific, searched-up facts make for a noticeably stronger listing than vague description. Only state something as fact if you're actually confident the search result is about THIS exact product, not a similar-looking or differently-specced one — when unsure, describe only what's visibly true rather than inventing or misattributing detail. Never surface the search itself in the copy — no source links, "according to [site]," citation markers, or anything that reads as a research summary; the listing should read as the seller's own confident description, with the sourcing invisible.`,
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
