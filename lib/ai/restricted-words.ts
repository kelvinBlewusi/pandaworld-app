/**
 * Jumia restricted words — these MUST NOT appear in any listing content
 * (title, description, highlights, attributes). Source: Jumia vendor
 * content guidelines.
 *
 * Used in two places:
 *   1. AI prompts include this list with "never use these words" instructions
 *   2. Post-generation: every AI string is scanned; matching words are
 *      stripped before persisting.
 */

// Canonical list — case-insensitive matching, whole-word boundaries.
export const JUMIA_RESTRICTED_WORDS: string[] = [
  // Marketing / commercial restrictions
  "original",
  "next day delivery",
  "next day shipment",
  "free installation",
  "follow come",
  "konga",
  "shop konga",
  "imported",
  "express delivery",
  "indestructable",
  "indestructible",
  "no returns",
  "fairly used",
  "brand new",
  "deal dey",
  "key features",
  "sku",
  "product line",
  "where to use",
  "preowned",
  "pre-owned",
  "rooted",
  "uk used",
  "uk neatly used",
  "neatly used",
  "london used",
  "unboxed",
  "100% human hair",
  "unlocked",
  "unlocked mifi",
  "unlocked mtn mifi",
  "refurbished",
  "reconditioned",
  // Confirmed live 2026-09-19: "DIY Wall Clock" description rejected with
  // "The Attribute [description] contains the restricted words : second hand"
  "second hand",
  // Confirmed live 2026-09-17: "FreePods Pro ANC Wireless Headphones"
  // description rejected with "The Attribute [description] contains the
  // restricted words : supreme" — a superlative marketing claim, same
  // class as "key features" above, not a brand name Jumia sells.
  "supreme",

  // Vulgar / profanity
  "5h1t", "5hit", "a55", "ar5e", "arrse", "arse", "ass", "ass-fucker", "asses",
  "assfucker", "assfukka", "asshole", "assholes", "asswhole", "a_s_s",
  "b!tch", "b00bs", "b17ch", "b1tch", "ballbag", "ballsack", "bastard",
  "beastial", "beastiality", "bellend", "bestial", "bestiality", "bi+ch",
  "biatch", "bitch", "bitcher", "bitchers", "bitches", "bitching",
  "boiolas", "bollock", "bollok", "boner", "boobs", "boob", "buceta",
  "bugger", "bum", "bunny fucker", "butt", "butthole", "buttmuch", "buttplug",
  "c0ck", "c0cksucker", "carpet muncher", "cawk", "chink", "cipa", "cl1t",
  "clit", "clits", "cnut", "cock", "cock-sucker", "cockface", "cockhead",
  "cockmunch", "cockmuncher", "cocks", "cocksuck", "cocksucked", "cocksucker",
  "cocksucking", "cocksucks", "cocksuka", "cocksukka", "cok", "cokmuncher",
  "coksucka", "coon", "cox", "crap", "cum", "cummer", "cumming", "cums",
  "cumshot", "cunt", "cuntlick", "cuntlicker", "cuntlicking", "cunts",
  "cyalis", "cyberfuc", "cyberfuck", "cyberfucked", "cyberfucker",
  "cyberfuckers", "cyberfucking", "d1ck", "damn", "dick", "dickhead",
  "dink", "dinks", "dirsa", "dlck", "dog-fucker", "doggin", "dogging",
  "donkeyribber", "doosh", "duche", "dyke", "fuck", "shit", "pussy",

  // Restricted brands / look-alikes
  // "allure" confirmed live 2026-09-15: a production listing's jumia_error
  // paired "The Attribute [description] contains the restricted words :
  // allure" with "You have referred to a trademark that is protected, but
  // you have not accurately specified the corresponding brand" — Chanel's
  // Allure fragrance line, used generically in the description text.
  "allure",
  "chanel", "hermes", "guerlain", "saint laurent", "berluti", "louis vuitton",
  "acne studios", "balmain", "isabel marant", "bio-oil", "bio oil",
  "urban decay", "urbandecay", "wahl", "gucci", "my ride 65", "ride 65",
  "tag heuer", "tom ford", "tomford", "mac", "bobbi brown",
  "rubik cube", "rubiks cube", "rubiks", "rubic", "rubics", "rubic's",
  "rubic cube", "rubics cube", "rubic's cube", "rubik's", "rubik's cube", "rubik",
  "ben nye", "ban nye", "soundlink", "sound link", "beoplay", "beo play",
  "sollatek", "yeezy", "sebamed", "seba med", "rolex", "ray ban", "rayban",
  "g-shock", "armani", "anya hindmarch", "spy", "speedo", "bose", "hublot",
  "swatch", "givenchy", "versace", "vigrx", "vigrx plus", "tobaco", "tobacco",
  "shisha", "hookah", "oriflame", "yezzy", "tissot", "lighter",

  // Restricted product claims
  "http://www.aliexpress.com",

  // Inflated mAh claims (battery scam pattern)
  "60000mah", "60,000mah", "60000 mah", "60,000 mah",
  "70000mah", "70,000mah", "70000 mah", "70,000 mah",
  "80000mah", "80,000mah", "80000 mah", "80,000 mah",
  "90000mah", "90,000mah", "90000 mah", "90,000 mah",
  "100000mah", "100,000mah", "100000 mah", "100,000 mah",
  "110000mah", "110,000mah", "110000 mah", "110,000 mah",
  "120000mah", "120,000mah", "120000 mah", "120,000 mah",
  "65000mah", "65,000mah", "65000 mah", "65,000 mah",
  "72000mah", "72,000mah", "72000 mah", "72,000 mah",
  "85000mah", "85,000mah", "85000 mah", "85,000 mah",
  "95000mah", "95,000mah", "95000 mah", "95,000 mah",
];

/**
 * Returns a compact bulleted instruction we can append to AI prompts to
 * ensure the model never writes any of these words.
 *
 * Kept short on purpose — we don't dump the full list into every prompt
 * because that would bloat token usage. Instead we give clear rules and
 * post-filter the output server-side.
 */
export function buildRestrictedWordsInstruction(): string {
  return `IMPORTANT — Jumia content guidelines forbid these terms; you MUST NOT use any of them, in any combination, in any field:
- Marketing claims: "original", "brand new", "imported", "fairly used", "second hand", "preowned", "London used", "UK used", "neatly used", "refurbished", "reconditioned", "express delivery", "next day delivery", "free installation", "indestructible", "no returns", "key features", "supreme", "product line", "where to use", "100% human hair".
- Branded names (unless this product is actually that brand confirmed by visible logo): Chanel, Allure, Gucci, Louis Vuitton, Rolex, Ray-Ban, Hermes, Versace, Armani, Tag Heuer, Bose, MAC, Bobbi Brown, Urban Decay, Yeezy, Tissot, Givenchy, Saint Laurent, Balmain, Hublot, Tom Ford, Swatch, Bio-Oil, Sebamed, Soundlink, Beoplay, Lighter, Speedo, Spy, Tobacco, Shisha, Hookah, Oriflame, Bio Oil.
- Inflated battery claims: any mAh number above 50,000 (60,000mah, 100,000mah etc.).
- All profanity and vulgar language.
- SKU and Konga references.
If a restricted term seems to fit, find a generic alternative or omit that field.`;
}

/**
 * Strip restricted words from a generated string. Replaces matches with
 * empty string and collapses double spaces.
 *
 * Uses whole-word matching (word boundaries) to avoid eating partial
 * matches like "ass" inside "class".
 */
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const RESTRICTED_REGEX = new RegExp(
  "\\b(" +
    JUMIA_RESTRICTED_WORDS
      .filter((w) => w.length > 0)
      .map(escapeRegex)
      .join("|") +
  ")\\b",
  "gi"
);

export function stripRestrictedWords(text: string): string {
  if (!text) return text;
  return text
    .replace(RESTRICTED_REGEX, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Returns the list of restricted words that DO appear in the given text.
 * Useful for surfacing what was stripped to logs.
 */
export function findRestrictedWords(text: string): string[] {
  if (!text) return [];
  const matches = text.match(RESTRICTED_REGEX);
  return matches ? Array.from(new Set(matches.map((m) => m.toLowerCase()))) : [];
}
