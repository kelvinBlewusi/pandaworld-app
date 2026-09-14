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
  /** True for the free-text fields whose value is HTML (Description,
   *  Highlights) — these get HTML_SHAPE_RULE appended. A title is a plain
   *  string and must never be told to emit tags. */
  narrative?: true;
}

export const CONTENT_STYLE_RULES: ContentStyleRule[] = [
  {
    appliesTo: (l) => l.includes("name") && !l.includes("brand"),
    rule: `Name/title: genuinely descriptive and SEO-rich — TYPE + the specific, real details a buyer would search for (material, colour, size, pack count/quantity, capacity, a key feature), roughly 6–12 words long (e.g. "Wholesale Pack of 30 Gold Award Medals with Ribbons", not "Medals"). NEVER a single generic word or phrase ("Generic", "Product", "Item") — if the image genuinely doesn't give you enough to write a real title, omit the field entirely rather than writing something vague; a blank field the seller fills in is far better than a title that says nothing. No ALL CAPS, no keyword repetition/stuffing, no brand name (Jumia rejects titles containing the brand).`,
  },
  {
    appliesTo: (l) => l.includes("description"),
    narrative: true,
    rule: `Description: free-form — prose paragraphs, a <table>, a <ul>, or any mix, whichever combination best showcases THIS specific product. ALL formatting styles are allowed (bold, italics, underline, headings, bullets, tables) and NONE are required — whether to use a table at all is entirely your own call for THIS product, never a fixed requirement. Not locked to a fixed paragraph count or a single format: a story-led product may read best as flowing prose, a spec-heavy one may lead with a <table> before any prose, and most products benefit from a mix. The actual structure should genuinely vary from one listing to the next — two different products should never read as if poured from the same template; pick whatever shape fits THIS product, not a habit. Tables aren't capped at a 2-column Spec/Value layout — use as many columns and rows as the content genuinely calls for (e.g. a size chart, a multi-variant comparison, a nutrition/ingredients breakdown), whichever shape actually fits what you're presenting.
  MINIMUM LENGTH: at least 1500 characters of actual written prose/bullet content — not counting HTML markup, and not counting anything inside a <table>...</table> (a table is a bonus on top of this floor if you use one, never a substitute for it). Write as much genuine, specific detail as the product actually earns — real materials, dimensions, use-cases, construction, care instructions, whatever the image and notes actually support — to comfortably clear that floor with real substance, not padding. Never pad with filler sentences just to run longer; length should come from genuine detail, not repetition or vague marketing phrases — but "don't pad" is not license to stop short: even "just a medal" has real things to say once you look past the obvious (what it's made of, how it's finished, who buys it and why, how it compares to a cheaper version, how it's meant to be used or displayed). Find that substance rather than settling for the first few sentences that come to mind.
  Open with a one-sentence hook naming the product (may bold it inline). Weave <strong>key spec/feature phrases</strong> naturally into the prose as you go — including as a bold micro-heading directly followed by more prose in the same paragraph (e.g. "<strong>Effortless Slicing.</strong> The large, smooth-rolling wheel glides through..."). Nearly every product has at least one or two genuine buyer/use-case angles (occasion, recipient, setting) — close with a "Perfect for:" <ul> where each <li> starts with a bold audience/use-case and a colon, unless the product is truly single-purpose with nothing real to say there.
  ONLY if the product genuinely needs it (a connected/app-paired device, anything charged/battery-powered, or anything with a real first-use step a buyer could get wrong) — append:
    - A "Getting Started" <ul> of the ACTUAL steps for THIS product (e.g. charge before first use, pair via Bluetooth, download a named companion app if the image/notes show one) — never invented steps for a feature the product doesn't have.
    - A "Common Questions" section (a <table> or a <ul> of <li><strong>Q: ...</strong> A: ...</li>) covering 2–3 questions a buyer would ACTUALLY ask about this specific product (charging, connectivity, first-use behavior) — genuine and specific to what's shown, never generic filler.
  NEVER include store-promotional filler unrelated to this specific product — "welcome to our store," "follow us for updates," or similar. That's not product information and has no place in the description regardless of what competitor listings do.`,
  },
  {
    appliesTo: (l) => l.includes("highlight"),
    narrative: true,
    rule: `Highlights: free-form, like Description above — a <ul><li> list, prose paragraphs, a <table>, or any mix, whichever combination best fits what THIS product actually has to say. ALL formatting styles are allowed here too (bold, italics, underline, headings, bullets, tables) and NONE are required — whether to use a table at all is your own call for THIS product. NOT locked to a fixed bullet format or a fixed item count, and the actual structure should genuinely vary from one listing to the next rather than defaulting to the same shape every time. A bulleted list (each item like <li><strong>Short Feature Label</strong>: one or more sentences of real, specific benefit</li>) is a strong common default, especially for feature-dense products — but when the product has clear technical specs (dimensions, ingredients, materials, capacity, servings), lead with a <table> — not capped at 2 columns, use however many the specs actually need — and a story-led or premium product may read better as two short prose paragraphs than five clipped bullets.
  MINIMUM LENGTH: at least 800 characters of actual written content across all items — not counting HTML markup, and not counting anything inside a <table>...</table> (a table is a bonus on top of this floor if you use one, never a substitute for it). Write as much genuine, specific detail per point as the product warrants to comfortably clear that floor with real substance — don't cut yourself off at one short sentence if there's real substance to explain — but never pad with filler just to sound longer or more thorough. NEVER write a highlight as a single short clause restating the label (e.g. "Durable Design: Built to last as a lasting memento") — that's too thin to be useful. Every item needs the actual WHY or HOW behind it: what it's made of, how it achieves the benefit, or what makes this product's version of that feature genuinely good — if a highlight could be copy-pasted onto any competing product unchanged, it isn't specific enough yet.`,
  },
];

/** Always-on closing rule, appended once whenever any rule above applies. */
const CLOSING_RULE =
  "Never end description or highlights with a request for reviews/feedback/ratings — keep the content to the product itself.";

/**
 * Appended whenever a narrative (HTML-valued) rule applies.
 *
 * The rules above ask for "prose paragraphs" and the model took that
 * literally: measured on live listings, descriptions opened with hundreds
 * of characters of BARE text before the first tag (319, 373, 609) while
 * highlights, asked for a <ul>, always started at character 1. A value
 * that is half raw text and half markup is not HTML, and every consumer
 * downstream has to guess which it is — which is exactly how the editor
 * came to display real <strong> and <ul> tags to sellers as literal text.
 *
 * Also bans the empty bold heading the model emitted when it had no label
 * to put in one (a live description contained a bare "<strong>:</strong>",
 * which renders on Jumia as a stray bold colon).
 */
const HTML_SHAPE_RULE =
  "WELL-FORMED HTML: the value of description and highlights is HTML, so it must start with a tag and every piece of text must sit inside one — wrap each prose paragraph in <p>...</p> rather than leaving it as bare text before or between your tags. Never emit an element with no real text in it (no empty <p></p>, no <strong>:</strong> or <strong></strong> placeholder where a label was meant to go): if you have nothing to put in a heading, leave the heading out entirely. Close every tag you open, and nest lists properly (<li> only ever inside <ul> or <ol>).";

/**
 * Appended alongside HTML_SHAPE_RULE for narrative fields.
 *
 * THE FAILURE THIS EXISTS FOR, verbatim from a live listing (a pink
 * combination cable lock photographed in its blister pack):
 *
 *   "The 'NEW TO GO' branding suggests a modern and updated design, while
 *    the 'KAISHENG YOUPIN' logo indicates a focus on quality hardware
 *    tools. The packaging also highlights 'Your car guard, new generation
 *    explosion-proof series,' emphasizing its protective capabilities."
 *
 * Three separate faults, and all three are habits of an image captioner
 * rather than a copywriter:
 *
 *   1. It describes the PACKAGING, not the product. A buyer is not
 *      purchasing a blister pack.
 *   2. It hedges like an observer — "suggests", "indicates", "appears
 *      to" — because the model is reporting what it can see rather than
 *      asserting what the product is.
 *   3. It quotes and literally translates the Chinese packaging slogan.
 *      "Your car guard, new generation explosion-proof series" is
 *      marketing copy that does not survive translation; reproduced in an
 *      English Jumia listing it reads as nonsense and undermines trust in
 *      the whole page.
 *
 * Meanwhile it never told the buyer the one thing they want to know: that
 * they can lock a bike in seconds and never carry a key.
 */
const BUYER_FOCUS_RULE =
  "WRITE TO THE BUYER, ABOUT THE PRODUCT — never about the photograph, the packaging, or the branding. " +
  "The buyer is purchasing the item, not the blister pack it is photographed in, and they cannot see your image while reading. " +
  "NEVER write phrases like \"the image shows\", \"pictured here\", \"the packaging highlights\", \"the label reads\", " +
  "\"the branding suggests\", \"the logo indicates\", \"appears to be\" or \"seems to\": every one of them reports an observation " +
  "instead of stating a product fact, and hedging tells a shopper you are guessing. Say \"The steel cable resists cutting\", never " +
  "\"the packaging suggests it is cut-resistant\". " +
  "Text printed on the box is a SOURCE of facts, never content to reproduce: read a spec off it and state it plainly (\"4-digit combination\", " +
  "\"1.2m steel cable\"), but NEVER quote a slogan and NEVER translate foreign marketing copy literally — a phrase like " +
  "\"your car guard, new generation explosion-proof series\" is meaningless to a buyer and makes the listing look machine-made. " +
  "Brand names belong in the brand field, not narrated in the prose. " +
  "Every sentence must answer \"why does this matter to me?\" rather than \"what can I see?\" — lead with what the buyer gets " +
  "(locks a bike in seconds, no key to lose, fits through most wheel spokes), and use the visible details only as the evidence for it.";

/** The block both builders below produce, given the rules that apply. */
function assembleBlock(applicable: ContentStyleRule[]): string {
  if (!applicable.length) return "";
  const lines = applicable.map((r) => `- ${r.rule}`).join("\n");
  const narrative = applicable.some((r) => r.narrative);
  const extras = narrative ? `\n- ${BUYER_FOCUS_RULE}\n- ${HTML_SHAPE_RULE}` : "";
  return `\n\nCONTENT STYLE:\n${lines}\n- ${CLOSING_RULE}${extras}\n`;
}

/**
 * Builds the CONTENT STYLE prompt block for whichever of the rules above
 * are relevant to this page's harvested fields. Empty string when none
 * apply (e.g. a page with no Name/Description/Highlights field at all).
 */
export function buildStyleGuideBlock(fields: HarvestedField[]): string {
  const labels = fields.map((f) => norm(f.label));
  return assembleBlock(CONTENT_STYLE_RULES.filter((r) => labels.some((l) => r.appliesTo(l))));
}

/** Shared by the two exports below — same shape as buildStyleGuideBlock's
 *  own filter, but against a fixed label list instead of harvested fields. */
function buildBlockForLabels(labels: string[]): string {
  return assembleBlock(CONTENT_STYLE_RULES.filter((r) => labels.some((l) => r.appliesTo(l))));
}

/**
 * Same Description + Highlights rules as buildStyleGuideBlock above, for
 * callers that don't harvest fields off a live Jumia form — the main
 * analyze pipeline (lib/actions/ai.ts) always generates both together, so
 * there's no field list to filter against. Excludes the Name rule: a title
 * is a plain string, not a "rich text and tables" narrative field, and the
 * analyze pipeline already enforces its own title length/format rules.
 */
export function buildDescriptionAndHighlightsStyleBlock(): string {
  return buildBlockForLabels(["description", "highlights"]);
}

/**
 * Description-only variant of the above, for a rewrite pass that only
 * touches the description field (e.g. aiExpandDescription) — including the
 * Highlights rule there would reference a field the call never writes.
 */
export function buildDescriptionStyleBlock(): string {
  return buildBlockForLabels(["description"]);
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

/**
 * Phrases that mark copy as describing a photo rather than selling a
 * product. Used to MEASURE whether BUYER_FOCUS_RULE is landing — a prompt
 * rule with no feedback loop is a guess.
 *
 * Detection only. Deliberately not auto-stripped: these appear
 * mid-sentence, and cutting them leaves mangled prose, which is a worse
 * listing than the one that needed fixing.
 */
const PHOTO_NARRATION_PATTERNS: RegExp[] = [
  /\bthe (image|photo|picture)s? (show|shows|depict|depicts|features)\b/i,
  /\bpictured (here|above|below)\b/i,
  /\bas (shown|seen) in the (image|photo|picture)\b/i,
  /\bthe packaging (also )?(highlights|shows|states|reads|indicates|suggests)\b/i,
  /\bthe (label|box|packaging) (reads|says|states)\b/i,
  // No leading "the": real copy interposes the brand name — the live
  // failure read "the 'KAISHENG YOUPIN' logo indicates a focus on…".
  /\b(branding|logo|label) (suggests|indicates|implies)\b/i,
  /\b(appears|seems) to be\b/i,
];

/** The photo-narration phrases present in a piece of generated copy, if
 *  any. Empty means the copy reads as product writing. */
export function detectPhotoNarration(text: string | null | undefined): string[] {
  if (!text) return [];
  const hits: string[] = [];
  for (const pattern of PHOTO_NARRATION_PATTERNS) {
    const match = pattern.exec(text);
    if (match) hits.push(match[0].toLowerCase());
  }
  return hits;
}
