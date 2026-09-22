/**
 * assessListingPushReadiness — the single "would this push succeed?" brain
 * behind finalizeBatch's Ready/Held decision (lib/whatsapp/intake.ts).
 *
 * Fixtures below mirror the staging E2E canary (2026-09-21) that exposed
 * the bug this closes: three products that a real push would have
 * rejected or silently corrupted all came back "✅ Ready", because
 * finalizeBatch only ever checked missing fields, never
 * previewListingPayload/buildJumiaPayload/preflightAttributes.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => db,
}));

type PreviewMock =
  | {
      ok: true;
      products: unknown[];
      adjustments: string[];
      missingRequired: string[];
      blockers: string[];
      preflightNotes: { attribute: string; label: string; reason: string; detail: string }[];
    }
  | { ok: false; code: "not_found" | "not_connected" | "build_failed"; message: string };

let previewResult: PreviewMock = {
  ok: true, products: [{ brand: { code: 1, name: "Panasonic" } }],
  adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
};

jest.mock("@/lib/jumia/push-listing", () => ({
  ...jest.requireActual("@/lib/jumia/push-listing"),
  previewListingPayload: async () => previewResult,
}));

import { assessListingPushReadiness } from "@/lib/whatsapp/readiness";

const FULL_FIELDS = {
  description: "A long enough description to clear the fifty-character minimum check.",
  category_code: "1234",
  brand: "Panasonic",
  images: ["https://cdn.test/a.jpg"],
  selling_price: 150,
  title: "A Perfectly Ordinary Product Title",
};

function seedListing(patch: Record<string, unknown> = {}) {
  db.tables.listings = [{ id: "listing-1", user_id: "user_1", category_path: "Home & Kitchen > Small Appliances", ...FULL_FIELDS, ...patch }];
}

beforeEach(() => {
  previewResult = {
    ok: true, products: [{ brand: { code: 1, name: "Panasonic" } }],
    adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
  };
});

describe("assessListingPushReadiness — cheap field checks short-circuit", () => {
  it("is Held on missing fields without ever calling the dry-run", async () => {
    seedListing({ selling_price: null });
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(["needs price"]);
  });

  it("is Ready when every field is present and the dry-run comes back clean", async () => {
    seedListing();
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("reports listing not found without touching the dry-run", async () => {
    db.tables.listings = [];
    const result = await assessListingPushReadiness("user_1", "missing-id");
    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(["listing not found"]);
  });
});

describe("assessListingPushReadiness — canary 1: kettle capacity must be a whole number", () => {
  it("holds when preflight dropped a decimal_mismatch_blocked attribute", async () => {
    seedListing({ title: "Electric Kettle - Stainless Steel", category_path: "Home & Office > Appliances > Small Appliances > Kettles" });
    previewResult = {
      ok: true, products: [{ brand: { code: 1, name: "Generic" } }],
      adjustments: [`Capacity (L): "1.8" isn't a whole number — this category needs one, so set it yourself before submitting`],
      missingRequired: [], blockers: [],
      preflightNotes: [{
        attribute: "capacity_litres", label: "Capacity (L)", reason: "decimal_mismatch_blocked",
        detail: `"1.8" isn't a whole number — this category needs one, so set it yourself before submitting`,
      }],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(false);
    expect(result.reasons.join(" ")).toContain("Capacity (L)");
    expect(result.reasons.join(" ")).toContain("isn't a whole number");
  });

  // The actual staging canary root cause (2026-09-21, listing 5b9b1f52,
  // category 1022979 "Coffee, Tea & Espresso Appliances"), confirmed
  // directly against the live rows: the category's schema declares SIX
  // capacity-shaped fields (capacity, capacity_liter, capacity_litres,
  // capacity_kg, capacity_kva, capacity_slices) but auto-analyze's
  // dynamic_attributes for this listing carried none of them — "1.8L"
  // only ever existed as prose in the title/description. There was
  // nothing for decimal_mismatch_blocked to catch because no capacity
  // attribute was ever built in the first place — this is the gap one
  // step upstream of that check.
  it("holds when a stated decimal capacity never made it into any built attribute at all", async () => {
    seedListing({
      title: "Electric Kettle - 1.8L Capacity",
      description: "Boil water quickly and efficiently for your favorite hot beverages with this sleek electric kettle. With a generous 1.8L capacity, it's perfect for making tea, coffee, or other hot drinks for the whole family.",
      category_path: "Home & Office > Home & Kitchen > Kitchen & Dining > Small Appliances > Coffee, Tea & Espresso Appliances",
    });
    previewResult = {
      ok: true, products: [{
        brand: { code: 1045133, name: "Generic" },
        // The real built attribute list for this listing — color,
        // color_family, product_weight, manufacturer_txt, package_content,
        // variation — and genuinely nothing capacity-shaped, matching what
        // was actually observed in production.
        attributes: [
          { name: "color", value: "Silver" },
          { name: "color_family", value: "Silver" },
          { name: "product_weight", value: "1.2 kg" },
          { name: "manufacturer_txt", value: "N/A" },
          { name: "package_content", value: "1x Electric Kettle - 1.8L Capacity" },
          { name: "variation", value: "Electric Kettle" },
        ],
      }],
      adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(false);
    expect(result.reasons.join(" ")).toContain("capacity");
    expect(result.reasons.join(" ")).toContain("1.8L");
  });

  it("holds when capacity-shaped attrs exist but are empty/zero placeholders (not a real capture)", async () => {
    seedListing({
      title: "Electric Kettle - Stainless Steel, 1.8L Capacity",
      category_path: "Home & Office > Home & Kitchen > Kitchen & Dining > Small Appliances > Coffee, Tea & Espresso Appliances",
    });
    previewResult = {
      ok: true, products: [{
        brand: { code: 1045133, name: "Generic" },
        attributes: [
          { name: "color", value: "Silver" },
          { name: "capacity_slices", value: 0 },
          { name: "capacity_kg", value: "" },
          { name: "capacity", value: "N/A" },
        ],
      }],
      adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(false);
    expect(result.reasons.join(" ")).toContain("capacity");
    expect(result.reasons.join(" ")).toContain("1.8L");
  });

  it("does not hold when a capacity WAS captured, even if the title also mentions the volume", async () => {
    seedListing({ title: "Electric Kettle - 1.8L Capacity", category_path: "Home & Office > Appliances > Small Appliances > Kettles" });
    previewResult = {
      ok: true, products: [{
        brand: { code: 1, name: "Generic" },
        attributes: [{ name: "capacity_liter", value: "2" }],
      }],
      adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(true);
  });

  // Round 2 of the same canary, read directly off a live POST
  // /api/jumia/preview: capacity_litres for this category is cached as
  // type "string", so checkNumericConstraint (gated on type === "number")
  // never runs on it — a decimal value that DOES land in the attribute
  // sails through preflightAttributes with no decimal_mismatch_blocked
  // note at all. Round 1's "never made it in" test above doesn't cover
  // this — the attribute IS present, just still fractional.
  it("holds when a capacity attribute is present but still fractional (schema-mistyped field bypassing the numeric gate)", async () => {
    seedListing({
      title: "Electric Kettle - 1.8L Capacity",
      category_path: "Home & Office > Home & Kitchen > Kitchen & Dining > Small Appliances > Coffee, Tea & Espresso Appliances",
    });
    previewResult = {
      ok: true, products: [{
        brand: { code: 1045133, name: "Generic" },
        attributes: [{ name: "capacity_litres", value: "1.8" }],
      }],
      adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(false);
    expect(result.reasons.join(" ")).toContain("capacity");
    expect(result.reasons.join(" ")).toContain("1.8L");
  });
});

describe("assessListingPushReadiness — canary 2 root cause: a stale attribute duplicated across variants", () => {
  // The tee's actual defect, confirmed live off POST /api/jumia/preview
  // (category 1012714): 3 variants (M/L/XL) each carried the correct
  // per-variant `variation`, but every one of them ALSO carried a static
  // "size" attribute stuck at "M" — right for the M variant, silently
  // wrong for L and XL. No invalid_enum note, because "M" is itself a
  // valid stocked size; only which variant it's attached to is wrong.
  it("holds when a non-variation attribute is frozen at one value across variants that disagree with it", async () => {
    seedListing({ title: "Navy Blue Cotton Crew Neck Tee", category_path: "Fashion > Men's Wear > Shirts" });
    previewResult = {
      ok: true,
      products: [
        { brand: { code: 1, name: "Fashion" }, variation: "M", attributes: [{ name: "size", value: "M" }] },
        { brand: { code: 1, name: "Fashion" }, variation: "L", attributes: [{ name: "size", value: "M" }] },
        { brand: { code: 1, name: "Fashion" }, variation: "XL", attributes: [{ name: "size", value: "M" }] },
      ],
      adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(false);
    expect(result.reasons.join(" ")).toContain("size");
    expect(result.reasons.join(" ")).toContain("stuck at the same value");
  });

  it("does not hold when the duplicated attribute genuinely tracks each variant", async () => {
    seedListing({ title: "Navy Blue Cotton Crew Neck Tee", category_path: "Fashion > Men's Wear > Shirts" });
    previewResult = {
      ok: true,
      products: [
        { brand: { code: 1, name: "Fashion" }, variation: "M", attributes: [{ name: "size", value: "M" }] },
        { brand: { code: 1, name: "Fashion" }, variation: "L", attributes: [{ name: "size", value: "L" }] },
        { brand: { code: 1, name: "Fashion" }, variation: "XL", attributes: [{ name: "size", value: "XL" }] },
      ],
      adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(true);
  });

  it("does not hold a single-product (zero-variant) listing — nothing to disagree with", async () => {
    seedListing({ title: "Digital Air Fryer 5L", category_path: "Home & Kitchen > Small Appliances" });
    previewResult = {
      ok: true,
      products: [{ brand: { code: 1, name: "Panasonic" }, variation: "Black", attributes: [{ name: "color", value: "Black" }] }],
      adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(true);
  });

  it("does not hold an unrelated attribute that merely happens to repeat a non-variation value", async () => {
    // "Cotton" isn't one of the listing's own variation labels (M/L/XL),
    // so it must never be mistaken for the stale-duplicate pattern.
    seedListing({ title: "Navy Blue Cotton Crew Neck Tee", category_path: "Fashion > Men's Wear > Shirts" });
    previewResult = {
      ok: true,
      products: [
        { brand: { code: 1, name: "Fashion" }, variation: "M", attributes: [{ name: "main_material", value: "Cotton" }] },
        { brand: { code: 1, name: "Fashion" }, variation: "L", attributes: [{ name: "main_material", value: "Cotton" }] },
      ],
      adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(true);
  });
});

describe("assessListingPushReadiness — canary 2: variant value outside the category's stocked options", () => {
  it("holds when buildJumiaPayload itself refused (blockers non-empty)", async () => {
    seedListing({ title: "Navy Blue Cotton Tee", category_path: "Fashion > Men's Wear > Shirts" });
    previewResult = {
      ok: false, code: "build_failed",
      message: `Attribute [variation] with invalid value [Xtra Large].`,
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual([`Attribute [variation] with invalid value [Xtra Large].`]);
  });

  it("holds when the size/enum value was dropped as invalid_enum rather than hard-blocked", async () => {
    seedListing({ title: "Navy Blue Cotton Tee", category_path: "Fashion > Men's Wear > Shirts" });
    previewResult = {
      ok: true, products: [{ brand: { code: 1, name: "Fashion" } }],
      adjustments: [], missingRequired: [], blockers: [],
      preflightNotes: [{
        attribute: "size", label: "Size", reason: "invalid_enum",
        detail: `"Xtra Large" isn't one of this category's accepted values, so it wasn't sent`,
      }],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(false);
    expect(result.reasons.join(" ")).toContain("Size");
  });
});

describe("assessListingPushReadiness — canary 3 territory: fashion category still carrying plain Generic brand", () => {
  it("holds a fashion-category listing whose resolved brand is the plain non-fashion Generic", async () => {
    seedListing({ title: "Digital Air Fryer 5L", category_path: "Fashion > Men's Wear > Shoes" });
    previewResult = {
      ok: true, products: [{ brand: { code: 1045133, name: "Generic" } }],
      adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(false);
    expect(result.reasons.join(" ").toLowerCase()).toContain("brand");
  });

  it("does not flag plain Generic outside a fashion category", async () => {
    seedListing({ title: "Digital Air Fryer 5L", category_path: "Home & Kitchen > Small Appliances" });
    previewResult = {
      ok: true, products: [{ brand: { code: 1045133, name: "Generic" } }],
      adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(true);
  });

  it("does not flag the Fashion placeholder brand itself", async () => {
    seedListing({ title: "Classic White Sneakers", category_path: "Fashion > Men's Wear > Shoes" });
    previewResult = {
      ok: true, products: [{ brand: { code: 1039426, name: "Fashion" } }],
      adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(true);
  });
});

describe("assessListingPushReadiness — never a false Ready on an unverifiable dry-run", () => {
  it("holds rather than defaults to Ready when Jumia isn't connected", async () => {
    seedListing();
    previewResult = { ok: false, code: "not_connected", message: "Connect your Jumia account to preview what gets sent." };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(false);
    expect(result.reasons.join(" ")).toMatch(/jumia.*connect/i);
  });

  it("holds on JUMIA_NO_SCHEMA rather than defaulting to Ready", async () => {
    seedListing();
    previewResult = {
      ok: false, code: "build_failed",
      message: "JUMIA_NO_SCHEMA: This category's attribute list hasn't synced yet, so nothing can be validated before sending — try again in a moment, or open the category picker to re-select it and force a re-sync.",
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(false);
    expect(result.reasons.join(" ")).not.toContain("JUMIA_NO_SCHEMA:");
  });

  it("holds when the category still needs schema-required attributes the payload doesn't carry", async () => {
    seedListing();
    previewResult = {
      ok: true, products: [{ brand: { code: 1, name: "Panasonic" } }],
      adjustments: [], missingRequired: ["Weight (kg)"], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(false);
    expect(result.reasons.join(" ")).toContain("Weight (kg)");
  });
});

describe("assessListingPushReadiness — harmless preflight repairs stay Ready", () => {
  it("does not hold on a snapped enum, a rounded number, or a truncated field", async () => {
    seedListing();
    previewResult = {
      ok: true, products: [{ brand: { code: 1, name: "Panasonic" } }],
      adjustments: ["colour: casing corrected", "weight: rounded"], missingRequired: [], blockers: [],
      preflightNotes: [
        { attribute: "color", label: "Colour", reason: "snapped_enum", detail: "casing corrected" },
        { attribute: "weight", label: "Weight", reason: "rounded_number", detail: "rounded to 2 decimal places" },
        { attribute: "description", label: "Description", reason: "truncated", detail: "trimmed to 9000 characters" },
      ],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(true);
    expect(result.reasons).toEqual([]);
  });
});
