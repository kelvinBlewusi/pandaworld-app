/**
 * Jumia's own prohibited-product-types and restricted-brand reference data,
 * converted from the vendor workbook Jumia shares with sellers/support
 * ("Vendor Version - Blacklisted Words, Restricted Brands, Prohibited &
 * Sensitive Categories Reference.xlsx") into versioned JSON checked into
 * the repo — see data/jumia/*.json for the generated files and their
 * `version`/`source` fields.
 *
 * Two sheets carried real, current data (the rest were superseded "Old -"
 * copies, a support-ticket log with placeholder rows, or an empty header):
 *
 *   " LEGALLY PROHIBITED PRODUCT TYPES" — a keyword/category listed against
 *   NG/EG/MA/DZ/IC/SN/KE/UG/GH, each cell one of Jumia's own status strings
 *   ("Blocked", "Open to Local", "Registered - Open to Local", ...). Only
 *   non-"Open" cells were kept (data/jumia/prohibited-product-types.json) —
 *   an absent keyword for a country means no restriction there.
 *
 *   "QC - Restricted Brands x Category" — a brand against Jumia's QC
 *   category buckets (CLOTHING, SHOES, WATCHES & JEWELRY, ...), each cell
 *   FORBIDDEN / ALLOWED / ALLOWED WITH QC FOR FAKES. This sheet has no real
 *   per-country split (the per-country columns there are a QC priority
 *   weight, not allow/forbid), so the gate below applies uniformly.
 *
 * Deliberately pure and synchronous, like lib/jumia/preflight.ts — no
 * database, no network. The data is small enough (a few hundred KB) to ship
 * as a JSON import and searched in memory on every push.
 */

import prohibitedProductTypes from "@/data/jumia/prohibited-product-types.json";
import restrictedBrandsData from "@/data/jumia/restricted-brands.json";

interface ProhibitedEntry {
  keyword:  string;
  category: string | null;
  status:   string;
}

const BY_COUNTRY = prohibitedProductTypes.byCountry as Record<string, ProhibitedEntry[]>;

export interface ProhibitedCategoryCheck {
  /** "Blocked" for this country — never push. */
  blocked:  { keyword: string; category: string | null } | null;
  /** Any other non-"Open" status (licensed, registered, verified-sellers-
   *  only, ...) — surfaced to the seller, does not block the push, since
   *  the workbook doesn't tell us whether THIS seller holds what's needed. */
  warnings: { keyword: string; status: string }[];
}

/**
 * Scan listing text (title/description/category path) for a keyword this
 * country's sheet flags. Substring match against each row's own keyword —
 * most rows are short product-type names ("Camouflage Clothing / Items",
 * "Weapons", "Ivory"), a few are long explanatory clauses that will rarely
 * match free text verbatim; that's a property of the source data, not a bug
 * here — it still catches the common short-keyword rows.
 */
export function checkProhibitedCategory(countryCode: string, texts: (string | null | undefined)[]): ProhibitedCategoryCheck {
  const haystack = texts.filter(Boolean).join(" \n ").toLowerCase();
  const entries = BY_COUNTRY[countryCode.toUpperCase()] ?? [];
  if (!haystack || entries.length === 0) return { blocked: null, warnings: [] };

  let blocked: ProhibitedCategoryCheck["blocked"] = null;
  const warnings: ProhibitedCategoryCheck["warnings"] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    // Only the first line of a keyword cell — some rows carry a long
    // explanatory clause after a newline that was never meant to be
    // matched verbatim, only the short keyword before it.
    const keyword = entry.keyword.split("\n")[0].trim().toLowerCase();
    if (keyword.length < 4 || !haystack.includes(keyword)) continue;
    if (seen.has(keyword)) continue;
    seen.add(keyword);

    if (entry.status.toLowerCase() === "blocked") {
      blocked = blocked ?? { keyword: entry.keyword.split("\n")[0].trim(), category: entry.category };
    } else {
      warnings.push({ keyword: entry.keyword.split("\n")[0].trim(), status: entry.status });
    }
  }

  return { blocked, warnings };
}

interface BrandEntry {
  brand:          string;
  classification: string | null;
  categories:     Record<string, string>;
}

const BRANDS = restrictedBrandsData.brands as BrandEntry[];
const BRAND_INDEX = new Map<string, BrandEntry>(
  BRANDS.map((b) => [normalizeBrandName(b.brand), b]),
);

function normalizeBrandName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, " ") // strip "(brand)" / "(Watches)" style annotations
    .replace(/\s+/g, " ")
    .trim();
}

/** Best-effort mapping from a free-text category path to one of the QC
 *  sheet's fixed category buckets. Returns null when nothing matches —
 *  callers must not guess a brand's status for a category they can't map. */
const CATEGORY_KEYWORD_MAP: Array<{ test: RegExp; column: string }> = [
  { test: /perfume|fragrance|deodorant|cologne|eau de/i, column: "PERFUMES & DEODORANTS" },
  { test: /cosmetic|makeup|make-up|skincare|toiletr|lotion|beauty/i, column: "COSMETICS/TOILETRIES" },
  { test: /shoe|sneaker|sandal|boot|footwear/i, column: "SHOES" },
  { test: /\bbag\b|purse|handbag|wallet|\bbelt\b/i, column: "PURSES/BAGS/BELTS" },
  { test: /watch|jewel|bracelet|necklace|earring/i, column: "WATCHES & JEWELRY" },
  { test: /sunglass|eyewear/i, column: "SUNGLASSES" },
  { test: /phone case|gadget/i, column: "PHONE CASES & SMALL GADGETS" },
  { test: /\bkid\b|\bbaby\b|infant|toddler|children/i, column: "KIDS" },
  { test: /beverage|\bdrink\b|grocery|\bfood\b/i, column: "BEVERAGES  + OTHER" },
  { test: /electronic|home & living|appliance/i, column: "ELECTRONICS + HOME & LIVING" },
  { test: /cloth|fashion|apparel|dress|shirt|wear/i, column: "CLOTHING" },
];

function mapCategoryToColumn(categoryPath: string | null | undefined): string | null {
  if (!categoryPath) return null;
  const hit = CATEGORY_KEYWORD_MAP.find((m) => m.test.test(categoryPath));
  return hit?.column ?? null;
}

export interface RestrictedBrandCheck {
  status: "forbidden" | "qc" | "allowed" | "unknown";
  detail: string | null;
}

/** Look up a brand against the QC restricted-brands sheet for the mapped
 *  category. Returns "unknown" (no gate action) whenever the brand isn't in
 *  the sheet, or the category can't be confidently mapped to one of its
 *  columns — this never invents a restriction the source data doesn't
 *  actually state for that pairing. */
export function checkRestrictedBrand(brand: string | null | undefined, categoryPath: string | null | undefined): RestrictedBrandCheck {
  if (!brand) return { status: "unknown", detail: null };
  const entry = BRAND_INDEX.get(normalizeBrandName(brand));
  if (!entry) return { status: "unknown", detail: null };

  const column = mapCategoryToColumn(categoryPath);
  const value  = column ? entry.categories[column] : undefined;
  if (!value) return { status: "unknown", detail: null };

  if (value === "FORBIDDEN") {
    return { status: "forbidden", detail: `${brand} is on Jumia's restricted-brand list as forbidden in ${column}` };
  }
  if (value.startsWith("ALLOWED WITH QC")) {
    return { status: "qc", detail: `${brand} is allowed in ${column} but Jumia QCs it closely for counterfeits — make sure this listing is genuine` };
  }
  return { status: "allowed", detail: null };
}
