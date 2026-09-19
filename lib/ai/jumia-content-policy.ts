/**
 * Jumia content policy — the canonical "what Jumia QC accepts and what it
 * rejects" knowledge pack the AI reads on every Pass A / Pass B / Pass C
 * call.
 *
 * Sources (most-to-least authoritative):
 *   1. https://guidescontentjumiang.wordpress.com/blacklisted-words/
 *      (extracted verbatim; lives in lib/ai/restricted-words.ts)
 *   2. The same guides hub's slide-image rules for title shape,
 *      description format, highlights bullets, image specs, brand
 *      permission — codified here based on training knowledge of the
 *      Jumia GH seller-center content policy.
 *   3. Common QC rejection patterns observed in production listings.
 *
 * The verbatim restricted-words list (luxury brands, condition descriptors,
 * counterfeit-flag phrases, profanity, inflated mAh claims) is the source
 * of truth in lib/ai/restricted-words.ts — we re-use its
 * buildRestrictedWordsInstruction() helper from inside this module so we
 * don't duplicate the list and risk drift.
 *
 * Updating the rules: every prompt site (lib/actions/ai.ts buildPrompt +
 * aiPassB_rankCategory) calls buildContentPolicyInstructions() — change a
 * rule here, every Gemini call picks it up on the next request, no
 * redeploy of the prompt strings needed.
 */

import { buildRestrictedWordsInstruction } from "./restricted-words";
import { isFashionCategory } from "@/lib/jumia/fashion-category";

// ─── Restricted-brand quick-glance set ───────────────────────────────────────
//
// Mirrored from the wordpress blacklisted-words page so we have a callable
// set the brand-handling logic can probe directly (lib/actions/ai.ts'
// Pass-A response shaping uses this to force `brand = null` when the model
// returns one of these names without proof of authorisation).
//
// IMPORTANT: this is a subset focused on names that map to real authorised-
// only brands on Jumia GH. The full prohibited-words list (including
// profanity, condition descriptors, etc.) stays in restricted-words.ts.

export const JUMIA_RESTRICTED_BRANDS: ReadonlySet<string> = new Set([
  // Luxury fashion / leather goods
  "chanel", "hermes", "guerlain", "saint laurent", "berluti",
  "louis vuitton", "acne studios", "balmain", "isabel marant",
  "gucci", "tag heuer", "tom ford", "givenchy", "versace", "armani",
  "anya hindmarch",
  // Watches & sunglasses (counterfeit-prone)
  "rolex", "hublot", "swatch", "tissot", "ray ban", "rayban",
  "g-shock", "spy", "speedo",
  // Electronics (counterfeit-prone, brand-permission required)
  "bose", "beoplay", "beo play", "soundlink", "sound link",
  "sollatek",
  // Beauty (counterfeit-prone)
  "mac", "bobbi brown", "urban decay", "urbandecay",
  "bio-oil", "bio oil", "sebamed", "seba med",
  "wahl", "ben nye", "ban nye", "guerlain",
  // Niche / health (regulated)
  "vigrx", "vigrx plus", "oriflame",
  // Apparel (counterfeit-prone)
  "yeezy", "yezzy",
  // Misc (counterfeit-prone)
  "rubik", "rubik's", "rubiks", "rubics", "rubic",
]);

export function isRestrictedBrand(brand: string | null | undefined): boolean {
  if (!brand) return false;
  return JUMIA_RESTRICTED_BRANDS.has(brand.toLowerCase().trim());
}

// ─── Brand-in-title safety net ───────────────────────────────────────────────
//
// Jumia rejects any listing whose title contains the brand name with a
// "Product name contains Brand name [X]" error. Even with the prompt
// telling Gemini to omit the brand, the model occasionally slips up —
// especially when the brand is short (Orium, Bose, MAC) and reads as
// part of a model number. This is the post-AI safety net: take the
// brand the AI confidently picked, strip it from the title, normalise
// whitespace, return.
//
// Case-insensitive whole-word matching. Won't touch the brand inside a
// model code like "ORIUM-1003" (no word boundary between "ORIUM" and
// "-1003"), but WILL strip "ORIUM" / "Orium" when it stands alone.
// "Generic" is treated as a non-brand and never stripped (otherwise
// every generic-brand listing would lose the word "Generic" from
// titles like "Generic Rice Cooker").

const TITLE_SEPARATOR_REGEX = /\s{2,}/g;

/**
 * Remove the brand name from the title if it appears as a standalone
 * word. Safe to call with any combination of inputs.
 */
export function stripBrandFromTitle(
  title: string | null | undefined,
  brand: string | null | undefined,
): string {
  if (!title) return "";
  if (!brand) return title.trim();
  const cleanBrand = brand.trim();
  if (!cleanBrand || cleanBrand.toLowerCase() === "generic") return title.trim();

  // Escape regex meta-chars in the brand so brands like "Tag Heuer"
  // or "Tom Ford" (with spaces) work, and "L'Oréal" (with apostrophes)
  // doesn't blow up the regex.
  const escaped = cleanBrand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const brandRegex = new RegExp(`\\b${escaped}\\b`, "gi");

  return title
    .replace(brandRegex, "")
    .replace(/^[\s\-,–—:|]+/, "")          // strip leading punctuation left behind
    .replace(/[\s\-,–—:|]+$/, "")          // strip trailing punctuation
    .replace(TITLE_SEPARATOR_REGEX, " ")    // collapse multi-space
    .trim();
}

/**
 * Returns true when the title contains the brand as a standalone word.
 * Cheap predicate used to log telemetry when Gemini slipped up despite
 * the policy block.
 */
export function titleContainsBrand(
  title: string | null | undefined,
  brand: string | null | undefined,
): boolean {
  if (!title || !brand) return false;
  if (brand.trim().toLowerCase() === "generic") return false;
  const escaped = brand.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(title);
}

// ─── Rejection patterns ──────────────────────────────────────────────────────

export const JUMIA_REJECTION_PATTERNS: ReadonlyArray<{
  reason: string;
  fix:    string;
}> = [
  {
    reason: "Brand name repeated in the title — Jumia rejects \"Product name contains Brand name [X]\" because brand is stored as its own attribute and Jumia renders it separately on the listing page.",
    fix:    "REMOVE the brand from the title. Lead with the MODEL or product identifier, then the product type. The brand attribute is filled separately and Jumia displays it above the title automatically. E.g. NOT \"Samsung Galaxy A15 Smartphone …\" — instead \"Galaxy A15 Smartphone …\".",
  },
  {
    reason: "Wrong category — listing filed under a leaf that doesn't match the product",
    fix:    "Pick the most specific LISTABLE category. A phone case lives under Mobile Accessories > Phone Cases, NOT under Mobile Phones. Lean on general online knowledge of the product (brand, model, typical use case) to disambiguate visually-similar candidates.",
  },
  {
    reason: "Misleading title — claims a feature (waterproof, wireless, OLED) not visible in the images",
    fix:    "Only state features the images visibly support. If you can't see it, don't claim it.",
  },
  {
    reason: "Restricted-word leak — title / description / highlights contain banned terms (original, brand new, imported, etc.)",
    fix:    "Strip every term in the banned-words list. Use generic alternatives or omit the field.",
  },
  {
    reason: "Counterfeit suspicion — luxury brand visible but the price is unrealistically low",
    fix:    "Set brand = null. Note in description that the seller must hold brand authorisation. Never list known restricted brands without proof.",
  },
  {
    reason: "Image quality — watermark, low resolution, non-white background, multi-product collage, or text overlay (\"Sale!\", \"50% off\")",
    fix:    "White background (#FFFFFF) for non-Fashion; single product centred; no watermarks; no overlay text; 500-2000px square.",
  },
  {
    reason: "Empty required attribute — the AI returned null when it could have inferred a sensible value from general knowledge of the brand / model / product line",
    fix:    "If the image doesn't directly show the value, fall back to general online knowledge of the product. Only return null when you have no reasonable basis (the field truly is unknowable). Mark inferred values with ~0.7 confidence in field_confidence so the seller knows to verify.",
  },
  {
    reason: "Variant mismatch — variation labels in the title don't match the variants table",
    fix:    "If variations are detected, every variant's `variation` label must be the same string Jumia expects in the title's variant slot.",
  },
  {
    reason: "Brand not authorised — listed Rolex, Gucci, Bose, MAC, etc. without seller holding brand permission",
    fix:    "Set brand = null for any name in JUMIA_RESTRICTED_BRANDS. The seller must upload authorisation papers separately.",
  },
  {
    reason: "Description too short — under 50 characters triggers automatic Jumia rejection",
    fix:    "Floor at 80 characters, no upper limit — write as much genuine detail as the product warrants, in prose, bullets, tables, HTML, or embedded images, pick whichever fits the product.",
  },
  {
    reason: "Generic title pattern — \"Quality Product\", \"Best Item\", \"Cool Thing\", no brand or model",
    fix:    "Lead with <Brand> <Model> <Product Type>. The first words must identify the product uniquely.",
  },
];

// ─── The main instruction builder ────────────────────────────────────────────

interface ContentPolicyOptions {
  /**
   * Optional category path so we can switch image-rules tone (Fashion
   * allows lifestyle / model shots; everything else demands white
   * background). Pass when available — both Pass A and Pass C have it
   * by the time they call this for the second pass.
   */
  categoryPath?: string | null;
  /**
   * Image-rules block only makes sense when the AI is looking at images.
   * The description-only entry point (analyzeProductDescription) sets
   * this to false to keep the prompt focused.
   */
  includeImageRules?: boolean;
}

/**
 * Returns the consolidated Jumia content policy as a single block of
 * text to prepend to a Gemini prompt. The AI reads it once per call and
 * applies it to every output field.
 *
 * Keep this readable — Gemini follows prose better than dense JSON.
 */
export function buildContentPolicyInstructions(
  opts: ContentPolicyOptions = {},
): string {
  const { categoryPath, includeImageRules = true } = opts;

  const isFashion = isFashionCategory(categoryPath);

  // The verbatim banned-words block from restricted-words.ts. This is
  // the SAME instruction we already give the AI — including it inside
  // the policy keeps a single touchpoint per prompt.
  const restrictedBlock = buildRestrictedWordsInstruction();

  const rejectionBlock = JUMIA_REJECTION_PATTERNS
    .map((p, i) => `  ${i + 1}. ${p.reason}\n     Fix: ${p.fix}`)
    .join("\n");

  const imageBlock = includeImageRules
    ? `
IMAGE RULES (the AI may reference these in its description but does NOT
generate images — these are constraints the seller's uploaded images must
satisfy, and the AI must not write claims that contradict them):
- Resolution: 500×500 minimum, 2000×2000 maximum, square or near-square.
- Background: ${isFashion
    ? "Lifestyle / studio with the model wearing the item is allowed for the MAIN image only. Subsequent images: clean studio."
    : "Pure white (#FFFFFF). No exceptions outside Fashion."}
- No watermarks, no seller logos, no price tags, no discount stickers.
- No text overlays (\"New!\", \"Sale!\", \"50% off\").
- The whole product centred, ~80% of frame.
- No multi-product collages. No images shot through plastic with glare.
- If the seller's images violate the above, the AI must NOT pretend they do
  (e.g. don't write "as shown on a clean white background" if the image
  has a busy background). Describe what's actually visible.
`
    : "";

  return `JUMIA CONTENT POLICY — READ EVERY RULE BEFORE GENERATING ANY FIELD.

TITLE / NAME RULES (15-200 characters, Title Case, ASCII only):
  Required pattern: <Model or Identifier> <Product Type> - <Key Spec 1>, <Key Spec 2>[, <Variant>]

  CRITICAL — DO NOT INCLUDE THE BRAND NAME IN THE TITLE.
  Jumia stores brand as a separate attribute and renders it above the
  title on the listing page. Repeating the brand in the title triggers
  the rejection: "Product name contains Brand name [X]" — this is the
  most common QC failure for new sellers. The brand belongs in the
  brand field, NOT in the title.

  Good examples (brand omitted from title):
    "Galaxy A15 Smartphone - 6GB RAM, 128GB Storage, Blue"
       (brand "Samsung" goes in the brand field, not the title)
    "Air Max 270 Sneakers - Men's Running Shoes, Size 42, Black/White"
       (brand "Nike" goes in the brand field)
    "Express Steam Iron - 2400W, Ceramic Soleplate, Anti-Calc"
       (brand "Tefal" goes in the brand field)
    "OR-1003 Electric Rice Cooker - 700-900W, 24H Smart Timer"
       (brand "Orium" goes in the brand field)

  Bad examples (never write anything like these):
    "Samsung Galaxy A15 Smartphone - 6GB RAM, 128GB Storage"
       — brand "Samsung" repeated in the title; Jumia rejects this.
    "ORIUM OR-1003 Electric Rice Cooker - 700-900W"
       — brand "ORIUM" in the title; Jumia rejects this.
    "BRAND NEW Samsung Smartphone!!! 🔥 Best Deal Today"
       — caps abuse, banned words, emoji, promo language.
    "Original Imported UK Used Sneakers Size 42"
       — three condition descriptors from the banned-words list.
    "Indestructible Iron Best Quality"
       — banned quality claims, no model.

  Hard rules:
    - NEVER include the brand name in the title — see above. This is
      THE most enforced Jumia QC rule.
    - If the product has no clear model number, lead with the product
      type itself: e.g. "Electric Rice Cooker - 1.8L, Non-Stick Inner Pot".
    - ASCII characters only; no emoji or decorative symbols.
    - No ALL-CAPS WORDS (initialisms like USB, OLED, 4K are fine).
    - No price, discount, shipping promise, free-anything, competitor name.
    - No restricted brand name (even if you were going to put it in the
      brand field — restricted brands need seller authorisation and the
      AI defaults them to null; see brand rules below).

DESCRIPTION RULES (80+ characters, no upper limit, any format that fits the product):
  - May be plain prose, bullet points, tables, or a mix. Use whichever
    format best showcases the product — long-form prose for a story-led
    item (e.g. handmade leather bag), bullets for spec-led tech, tables
    for comparison or spec-sheet style listings, mixed for products with
    both narrative and a feature list.
  - All formatting styles allowed: bold, italics, underline, line breaks,
    bullets, short paragraphs, headings, tables. Use them where they help
    readability.
  - HTML may be used (e.g. <p>, <ul>, <li>, <table>, <tr>, <td>, <br>,
    <strong>, <em>, <u>, <h3>, <h4>, <img>). <h3>/<h4> are for a standalone
    section title (e.g. "Getting Started", "Common Questions") — for a
    feature call-out INSIDE a flowing paragraph, use a bold lead-in
    (<strong>...</strong>) instead of a heading tag, since a heading breaks
    the paragraph into its own block. Stick to safe, semantic tags — no
    <script>, no inline JavaScript, no event handlers.
  - Images may be embedded inline (<img src="...">) when they add value
    — for example a spec diagram, a size chart, or an in-use photo
    alongside the main gallery. Use full URLs that the seller will host.
  - Lead with what the product is and its headline feature.
  - Marketing / promotional language is permitted — write copy that sells.
    "Best-in-class", "premium", "elevate your", "perfect for" etc. are
    fine; the goal is conversion, not bland prose.
  - No URLs to external sites in the prose, no hashtags, no social
    handles, no prices, no discount mentions. (Inline <img> URLs are
    fine — those are media, not navigation.)
  - No condition descriptors from the banned-words list.
  - No counterfeit-suggestive claims (\"100% human hair\", \"AAA grade\",
    \"OEM original\", \"1:1 replica\", inflated battery mAh).

HIGHLIGHTS RULES (free-form, any format that fits the product):
  - May be plain prose, bullet points, tables, or a mix. Bullets are
    common but NOT required — for a luxury / story-led item, two
    short prose paragraphs may sell better than five bullets; for a
    spec-led item a quick comparison table can outperform both.
  - All formatting styles allowed: bold, italics, underline, line breaks,
    bullets, short paragraphs, headings, tables. Use them where they help
    readability.
  - HTML may be used (the same safe-tag whitelist as Description —
    <p>, <ul>, <li>, <table>, <tr>, <td>, <br>, <strong>, <em>, <u>, <h3>,
    <h4>, <img>).
  - Images may be embedded inline (<img src="...">) when they
    illustrate a highlight (e.g. an icon-style feature graphic).
  - No word limit per bullet or per line — write as much or as little as
    the product warrants. A single great sentence beats five forced ones.
  - CRITICAL FORMAT — when bullets are used, EACH bullet MUST be on its
    OWN LINE. Separate bullets with the newline character \\n, or wrap
    them in an HTML <ul><li>…</li><li>…</li></ul> list. NEVER run all
    bullets together into one paragraph; the review-page editor and
    Jumia both render them as a single line of text otherwise, which
    looks unprofessional.
      CORRECT (line-separated): "• Item 1\\n• Item 2\\n• Item 3"
      CORRECT (HTML list):       "<ul><li>Item 1</li><li>Item 2</li></ul>"
      WRONG (one paragraph):     "• Item 1 • Item 2 • Item 3"
  - Order bullets / paragraphs by buyer importance: headline feature
    first, then specs, then usability / fit / care, then warranty.
  - No inline emoji rows, no decorative symbols outside the bullet
    character itself.

BRAND & ANTI-COUNTERFEIT RULES:
  - Pick brand verbatim from the JUMIA BRAND LIST passed in this prompt.
  - If the visible logo matches one of these restricted brands (luxury /
    restricted electronics / restricted beauty), set brand = null and
    note in the description that the seller must hold brand authorisation:
      Luxury fashion: Chanel, Hermes, Guerlain, Louis Vuitton, Gucci,
        Saint Laurent, Versace, Armani, Tag Heuer, Tom Ford, Givenchy,
        Balmain, Acne Studios, Isabel Marant, Anya Hindmarch.
      Watches & sunglasses: Rolex, Hublot, Swatch, Tissot, Ray-Ban,
        G-Shock, Spy, Speedo.
      Electronics: Bose, Beoplay, Soundlink, Sollatek.
      Beauty: MAC, Bobbi Brown, Urban Decay, Bio-Oil, Sebamed, Wahl,
        Ben Nye.
      Apparel: Yeezy.
      Misc: Rubik's, VigRX, Oriflame.
  - Never invent a brand. When no logo is visible: ${isFashion
      ? "use \"Fashion\" as the fallback for this category, NOT \"Generic\" — Jumia rejects \"Generic\" as a brand on Fashion categories."
      : "\"Generic\" is a valid fallback."}

NUMERIC FIELDS — STRICTLY NUMBERS, NEVER STRINGS:
  - weight_kg, weight, size_l/w/h, screen_size, battery_capacity, ram_size,
    storage_capacity (when expressed numerically), and any other field that
    represents a quantity → MUST be a plain number, NOT a string. NEVER write
    "(estimated)", "approx", "about", "~", "kg", "GB", or any unit/comment
    inside a numeric field. The downstream form is a number input — text
    will be stripped or break the field.
  - If you cannot determine a confident number, return null. Do NOT guess
    a number and wrap it in "(estimated)" to flag uncertainty — the seller
    interprets that as a real value, and it breaks the form.

ALWAYS-INCLUDED DYNAMIC ATTRIBUTES (never omit, write a real product-specific value):
  - product_note: A buyer-feedback nudge (the standard "thanks, please leave
    a review when you receive your order" message). The default is fine
    unless the seller has a more specific message to convey.
  - what_is_in_the_box: A real item list based on the images, formatted
    as a MULTI-LINE list with each item on its OWN line, starting with
    a count like "1x" or "2x". This is the format Jumia displays on the
    product page — a comma-joined paragraph or just a digit do NOT
    render correctly. Examples (each item on its own line, \\n between):
      Phone:   "1x Smartphone\\n1x USB-C Charger\\n1x USB Cable\\n1x User Manual"
      Drone:   "1x Drone\\n1x Remote Controller\\n2x Batteries\\n1x Charger\\n4x Spare Propellers\\n1x Carrying Case"
      Kettle:  "1x Electric Kettle\\n1x User Manual"
    NEVER omit this. If only the product is visible with no accessories,
    default to:
      "1x [Product Name]\\n1x User Manual (if applicable)\\n1x Original Packaging"
    NEVER write just "1" or a count number alone — that's a parse error,
    not a value.

CATEGORY & ATTRIBUTE DISCIPLINE:
  - Always pick the most specific LISTABLE category (the candidate pool
    already filters to listable parents and leaves — pick from those).
  - Fill every REQUIRED attribute Jumia returns for the category. For
    attributes the image doesn't directly show, you MAY draw on general
    online knowledge of this product / brand / model to infer a
    confident value (e.g. inferring the typical material of a known
    product line, or the standard warranty length for a known brand).
    Only return null when you have no reasonable basis at all — don't
    sandbag a field you genuinely know the answer to. Mark inferred
    values with a moderate confidence (~0.7) so the seller knows to
    double-check.
  - For constrained-vocabulary attributes (Color, Material, Size),
    pick exactly one of the allowed_values supplied. Never invent a
    value outside that list.
  - For multi-variant axes (Color × Size), only fabricate combinations
    the images clearly show. Don't pad with unseen sizes/colours.

${restrictedBlock}
${imageBlock}
COMMON QC REJECTION PATTERNS — the AI must actively avoid these. For each,
the listed Fix is non-negotiable:
${rejectionBlock}

IF A SELLER-PROVIDED CONTEXT CONFLICTS WITH ANY OF THE ABOVE, FOLLOW THE
POLICY. The seller's hint is authoritative for facts the images don't
show (pack size, exact variant, intended use) — it is NOT authoritative
for rules around restricted words, restricted brands, or image claims.
The above policy is THE LAW of Jumia QC; violating it costs the seller a
rejected listing.`;
}
