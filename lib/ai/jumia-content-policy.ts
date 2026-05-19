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

// ─── Rejection patterns ──────────────────────────────────────────────────────

export const JUMIA_REJECTION_PATTERNS: ReadonlyArray<{
  reason: string;
  fix:    string;
}> = [
  {
    reason: "Wrong category — listing filed under a leaf that doesn't match the product",
    fix:    "Pick the most specific LISTABLE category. A phone case lives under Mobile Accessories > Phone Cases, NOT under Mobile Phones.",
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
    reason: "Empty required attribute — the AI returned null or guessed instead of leaving the seller to fill",
    fix:    "Return null with a one-line note in field_confidence when the image doesn't show the value. Never invent.",
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
    fix:    "Floor at 80 characters with 2-3 full sentences. The AI's description must read like prose, not bullet points.",
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

  const isFashion = (categoryPath ?? "").toLowerCase().includes("fashion");

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
  Required pattern: <Brand> <Model or Identifier> <Product Type> - <Key Spec 1>, <Key Spec 2>[, <Variant>]

  Good examples:
    "Samsung Galaxy A15 Smartphone - 6GB RAM, 128GB Storage, Blue"
    "Nike Air Max 270 Sneakers - Men's Running Shoes, Size 42, Black/White"
    "Tefal Express Steam Iron - 2400W, Ceramic Soleplate, Anti-Calc"

  Bad examples (never write anything like these):
    "BRAND NEW Samsung Smartphone!!! 🔥 Best Deal Today"
       — caps abuse, banned words, emoji, promo language
    "Original Imported UK Used Sneakers Size 42"
       — three condition descriptors from the banned-words list
    "Indestructible Iron Best Quality"
       — banned quality claims, no brand or model

  Hard rules:
    - ASCII characters only; no emoji or decorative symbols.
    - No ALL-CAPS WORDS (initialisms like USB, OLED, 4K are fine).
    - No price, discount, shipping promise, free-anything, competitor name.
    - No restricted brand name unless the seller can prove authorisation
      (the AI defaults restricted brands to null — see brand rules below).

DESCRIPTION RULES (80-500 characters, 2-3 full sentences, plain prose):
  - Lead with what the product is and its headline feature.
  - Follow with one or two sentences on key materials, benefits, use cases.
  - No bullet points in the description body (bullets belong in highlights).
  - No promotional language: "best", "amazing", "incredible", "you'll
    love", "act fast", "limited time".
  - No URLs, hashtags, social handles, prices, discount mentions.
  - No condition descriptors from the banned-words list.
  - No counterfeit-suggestive claims (\"100% human hair\", \"AAA grade\",
    \"OEM original\", \"1:1 replica\", inflated battery mAh).

HIGHLIGHTS RULES (4-6 bullet points, one per line, each starting with "• "):
  - 5-12 words per bullet. Sentence-fragment style.
  - Each bullet starts with the • character + space + capital letter.
  - Bullet 1: headline feature ("Triple-camera system with optical zoom").
  - Bullets 2-3: key specifications (capacity, materials, dimensions).
  - Bullets 4-5: usability / fit / care.
  - Bullet 6 (optional): warranty or certification only.
  - No emoji, no HTML, no [brackets] or (parentheses).

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
  - Never invent a brand. "Generic" is a valid fallback when no logo is
    visible.

CATEGORY & ATTRIBUTE DISCIPLINE:
  - Always pick the most specific LISTABLE category (the candidate pool
    already filters to listable parents and leaves — pick from those).
  - Fill every REQUIRED attribute Jumia returns for the category. If the
    image doesn't clearly show a value, return null — never guess.
  - For constrained-vocabulary attributes (Color, Material, Size),
    pick exactly one of the allowed_values supplied. Never invent a value.
  - For multi-variant axes (Color × Size), only fabricate combinations the
    images clearly show. Don't pad with unseen sizes/colours.

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
