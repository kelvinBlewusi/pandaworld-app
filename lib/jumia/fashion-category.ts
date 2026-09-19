/**
 * Is this category (or product) a Fashion one, for the purposes of brand
 * fallback and content-policy wording?
 *
 * Shared by resolveBrand (lib/jumia/api.ts) and buildContentPolicyInstructions
 * (lib/ai/jumia-content-policy.ts) so the two don't drift — before this they
 * each ran their own narrower "fashion" substring check independently.
 *
 * Deliberately keyword-based rather than a lookup against the category tree:
 * both call sites sometimes only have a free-text category path/name, not a
 * resolved code, and a plain-string check is good enough for "should this
 * fall back to Fashion instead of Generic" — a wrong guess here costs
 * nothing worse than the brand fallback name shown to a human reviewer.
 */
const FASHION_KEYWORDS = [
  "fashion",
  "clothing",
  "clothes",
  "apparel",
  "shoe",
  "sneaker",
  "sandal",
  "boot",
  "footwear",
  "bag",
  "purse",
  "handbag",
  "backpack",
  "wallet",
  "belt",
  "watch",
  "jewel", // covers jewelry/jewellery
  "sunglass",
  "eyewear",
  "dress",
  "skirt",
  "trouser",
  "jean",
  "shirt",
  "underwear",
  "lingerie",
];

export function isFashionCategory(pathOrName: string | null | undefined): boolean {
  if (!pathOrName) return false;
  const lower = pathOrName.toLowerCase();
  return FASHION_KEYWORDS.some((k) => lower.includes(k));
}
