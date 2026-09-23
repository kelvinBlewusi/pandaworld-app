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
  db.tables.variants = [];
  db.tables.jumia_category_attributes = [];
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
  it("stays Ready when optional capacity is only stated in free text (blank attrs)", async () => {
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
    expect(result.ready).toBe(true);
    expect(result.reasons.join(" ").toLowerCase()).not.toContain("capacity");
  });

  it("stays Ready when capacity-shaped attrs are empty placeholders and prose states a fraction", async () => {
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
    expect(result.ready).toBe(true);
    expect(result.reasons.join(" ").toLowerCase()).not.toContain("capacity");
  });

  it("stays Ready when a whole-number capacity was parked after the seller stated a fraction", async () => {
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
    expect(result.reasons.join(" ").toLowerCase()).not.toContain("capacity");
  });

  it("stays Ready when a capacity attribute stores the stated fraction (optional field)", async () => {
    seedListing({ title: "Precision Flask - 1.5L", category_path: "Home & Office > Appliances > Small Appliances > Kettles" });
    previewResult = {
      ok: true, products: [{
        brand: { code: 1, name: "Generic" },
        attributes: [{ name: "capacity_liter", value: "1.5" }],
      }],
      adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(true);
    expect(result.reasons.join(" ").toLowerCase()).not.toContain("capacity");
  });

  // Round 2 of the same canary, read directly off a live POST
  // /api/jumia/preview: capacity_litres for this category is cached as
  // type "string", so checkNumericConstraint (gated on type === "number")
  // never runs on it — a decimal value that DOES land in the attribute
  // sails through preflightAttributes with no decimal_mismatch_blocked
  // note at all. Round 1's "never made it in" test above doesn't cover
  // this — the attribute IS present, just still fractional.
  it("stays Ready when an optional capacity attribute is still fractional (no free-text Hold)", async () => {
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
    expect(result.ready).toBe(true);
    expect(result.reasons.join(" ").toLowerCase()).not.toContain("capacity");
  });

  // Round 3 of the same canary, 2026-09-22: the AI-written title/description
  // this time didn't repeat the seller's own "1.8L" at all — it only ever
  // existed in the seller's raw WhatsApp caption, persisted verbatim to
  // listings.user_prompt by applyNotes (lib/whatsapp/intake.ts). A scan
  // limited to title+description missed it entirely.
  it("stays Ready when a decimal capacity claim is only in the seller caption", async () => {
    seedListing({
      title: "Stainless Steel Electric Kettle",
      description: "A long enough description to clear the fifty-character minimum check.",
      user_prompt: "GHS 120. Capacity 1.8L",
      category_path: "Home & Office > Home & Kitchen > Kitchen & Dining > Small Appliances > Coffee, Tea & Espresso Appliances",
    });
    previewResult = {
      ok: true, products: [{
        brand: { code: 1045133, name: "Generic" },
        attributes: [{ name: "color", value: "Silver" }],
      }],
      adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(true);
    expect(result.reasons.join(" ").toLowerCase()).not.toContain("capacity");
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
    // "size" is this category's real is_variant axis (not "variation") —
    // see the doc comment on staleDuplicateVariantAttribute for why that
    // gate has to pass for this to still be flagged.
    db.tables.jumia_category_attributes = [{ category_code: 1234, name: "size", is_variant: true }];
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
    db.tables.jumia_category_attributes = [{ category_code: 1234, name: "size", is_variant: true }];
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

  // Real live case, 2026-09-23 (Backpacks, category 1024302): "color" was
  // frozen at "Grey" for both a Black and a Grey variant — matching the
  // OLD, ungated heuristic's exact trigger shape (a non-"variation"
  // attribute whose value is one of the variation labels, disagreeing on
  // one row). But this category's own schema only flags "variation" as
  // is_variant — "color" isn't, and Jumia's own Vendor Center editor for
  // it has no per-variant color field at all (confirmed against a
  // screenshot of the real Variants tab). This must stay Ready: the
  // listing pushes and Jumia accepts it exactly as drafted, and "open
  // Edit to set it per variant" would send the seller to a field their
  // own Edit page can't set per variant.
  it("does not hold a non-variant attribute that merely happens to share a value with a variation label", async () => {
    seedListing({ title: "3-Piece Backpack Set", category_path: "Home & Office > Backpacks" });
    db.tables.jumia_category_attributes = [{ category_code: 1234, name: "variation", is_variant: true }];
    previewResult = {
      ok: true,
      products: [
        { brand: { code: 1, name: "Fashion" }, variation: "Black", attributes: [{ name: "color", value: "Grey" }] },
        { brand: { code: 1, name: "Fashion" }, variation: "Grey", attributes: [{ name: "color", value: "Grey" }] },
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

describe("assessListingPushReadiness — canary 2 round 3: a multi-size caption with a blank Size field", () => {
  // The same tee, round 3, 2026-09-22: this time the listing-level "size"
  // dynamic attribute was never set at all (round 2 had it frozen at "M" —
  // a different failure shape of the same gap). staleDuplicateVariantAttribute
  // above has nothing to catch when the field is genuinely absent, not
  // merely wrong, so this needs its own check anchored on the seller's own
  // caption ("Sizes Medium Large Xtra Large").
  it("holds when the caption lists several sizes but no product carries a Size value at all", async () => {
    seedListing({
      title: "Navy Blue Cotton Crew Neck Tee",
      user_prompt: "GHS 70. Sizes Medium Large Xtra Large",
      category_path: "Fashion > Men's Wear > Shirts",
    });
    previewResult = {
      ok: true,
      products: [
        { brand: { code: 1, name: "Fashion" }, variation: "M",  attributes: [{ name: "main_material", value: "Cotton" }] },
        { brand: { code: 1, name: "Fashion" }, variation: "L",  attributes: [{ name: "main_material", value: "Cotton" }] },
        { brand: { code: 1, name: "Fashion" }, variation: "XL", attributes: [{ name: "main_material", value: "Cotton" }] },
      ],
      adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(false);
    expect(result.reasons.join(" ")).toContain("size");
    expect(result.reasons.join(" ")).toContain("was never filled");
  });

  // Superseded by soft-snap Hold: Size filled as M/L/XL while the caption
  // still says Medium/Xtra Large must NOT silent-Ready (02:45 canary).
  it("stays Ready when Size is filled as M/L/XL for a Medium/Large/Xtra Large caption", async () => {
    seedListing({
      title: "Navy Blue Cotton Crew Neck Tee",
      user_prompt: "GHS 70. Sizes Medium Large Xtra Large",
      category_path: "Fashion > Men's Wear > Shirts",
    });
    previewResult = {
      ok: true,
      products: [
        { brand: { code: 1, name: "Fashion" }, variation: "M",  attributes: [{ name: "size", value: "M" }] },
        { brand: { code: 1, name: "Fashion" }, variation: "L",  attributes: [{ name: "size", value: "L" }] },
        { brand: { code: 1, name: "Fashion" }, variation: "XL", attributes: [{ name: "size", value: "XL" }] },
      ],
      adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(true);
    expect(result.reasons.join(" ").toLowerCase()).not.toContain("size");
  });

  it("stays Ready when the caption size tokens exact-match the drafted variations", async () => {
    seedListing({
      title: "Navy Blue Cotton Crew Neck Tee",
      user_prompt: "GHS 70. Sizes M L XL",
      category_path: "Fashion > Men's Wear > Shirts",
    });
    previewResult = {
      ok: true,
      products: [
        { brand: { code: 1, name: "Fashion" }, variation: "M",  attributes: [{ name: "size", value: "M" }] },
        { brand: { code: 1, name: "Fashion" }, variation: "L",  attributes: [{ name: "size", value: "L" }] },
        { brand: { code: 1, name: "Fashion" }, variation: "XL", attributes: [{ name: "size", value: "XL" }] },
      ],
      adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(true);
  });

  it("does not hold ordinary prose that mentions two size words but never calls them sizes, even with real variants", async () => {
    seedListing({
      title: "Adjustable Gardening Gloves",
      description: "Stretchy fit — comfortable across a medium to large hand.",
      category_path: "Home & Kitchen > Small Appliances",
    });
    previewResult = {
      ok: true,
      products: [
        { brand: { code: 1, name: "Panasonic" }, variation: "Green", attributes: [{ name: "color", value: "Green" }] },
        { brand: { code: 1, name: "Panasonic" }, variation: "Blue",  attributes: [{ name: "color", value: "Blue" }] },
      ],
      adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(true);
  });

  it("does not hold a single-product listing even if its description happens to list several sizes", async () => {
    seedListing({
      title: "One-Size Beanie",
      user_prompt: "Sizes Medium Large Xtra Large all fit the same, one size only",
      category_path: "Fashion > Men's Wear > Shirts",
    });
    previewResult = {
      ok: true,
      products: [{ brand: { code: 1, name: "Fashion" }, variation: "Default", attributes: [] }],
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

describe("assessListingPushReadiness — canary 02:45 soft-snap sizes + exact kettle preview", () => {
  it("stays Ready when Size M/L/XL soft-snaps a Medium/Xtra Large caption", async () => {
    seedListing({
      title: "Plain T-Shirt - Crew Neck, Short Sleeve",
      user_prompt: "GHS 70. Sizes Medium Large Xtra Large",
      category_path: "Fashion > Men > Clothing > T-Shirts",
    });
    previewResult = {
      ok: true,
      products: [
        { brand: { code: 1, name: "Fashion" }, variation: "M", attributes: [{ name: "size", value: "M" }, { name: "product_weight", value: "0.2" }] },
        { brand: { code: 1, name: "Fashion" }, variation: "L", attributes: [{ name: "size", value: "L" }, { name: "product_weight", value: "0.2" }] },
        { brand: { code: 1, name: "Fashion" }, variation: "XL", attributes: [{ name: "size", value: "XL" }, { name: "product_weight", value: "0.2" }] },
      ],
      adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(true);
    expect(result.reasons.join(" ").toLowerCase()).not.toContain("size");
  });


  it("stays Ready on soft-snap size claims even when preview returns a single product", async () => {
    seedListing({
      title: "Men's Round Neck T-Shirt - Cotton Fabric, Navy Blue",
      user_prompt: "GHS 70. Sizes Medium Large Xtra Large",
      category_path: "Fashion > Men's Fashion > Clothing > Shirts > T-Shirts",
    });
    previewResult = {
      ok: true,
      products: [
        { brand: { code: 1, name: "Fashion" }, variation: "M", attributes: [{ name: "size", value: "M" }, { name: "variation", value: "M" }] },
      ],
      adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(true);
    expect(result.reasons.join(" ").toLowerCase()).not.toContain("size");
  });


  it("stays Ready when variants table has size abbreviations and caption is missing", async () => {
    seedListing({
      title: "Plain Round Neck T-Shirt - Short Sleeve, Casual Wear",
      user_prompt: null,
      category_path: "Fashion > Men's Fashion > Clothing > Shirts > T-Shirts",
    });
    db.tables.variants = [
      { id: "v1", listing_id: "listing-1", variation: "M" },
      { id: "v2", listing_id: "listing-1", variation: "L" },
      { id: "v3", listing_id: "listing-1", variation: "XL" },
    ];
    previewResult = {
      ok: true,
      products: [
        { brand: { code: 1, name: "Fashion" }, variation: "M", attributes: [{ name: "size", value: "M" }] },
      ],
      adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(true);
    expect(result.reasons.join(" ").toLowerCase()).not.toContain("size");
  });

  it("stays Ready on exact 02:45 kettle preview (1.8L prose, blank capacity attrs)", async () => {
    seedListing({
      title: "Electric Kettle - 1.8L Capacity, Stainless Steel",
      description: "Boil water quickly with this 1.8L stainless steel electric kettle.",
      user_prompt: "GHS 120. Capacity 1.8L",
      category_path: "Home & Office > Home & Kitchen > Kitchen & Dining > Small Appliances > Coffee, Tea & Espresso Appliances",
    });
    previewResult = {
      ok: true,
      products: [{
        brand: { code: 1045133, name: "Generic" },
        variation: "Default",
        attributes: [
          { name: "variation", value: "Default" },
          { name: "color", value: "Silver" },
          { name: "color_family", value: "Grey" },
          { name: "main_material", value: "Stainless Steel" },
          { name: "material_family", value: "Metal" },
          { name: "production_country", value: "China" },
          { name: "warranty_duration", value: "None" },
          { name: "warranty_address", value: "N/A" },
          { name: "product_warranty", value: "N/A" },
          { name: "manufacturer_txt", value: "Generic" },
          { name: "product_weight", value: "1.5 kg" },
          { name: "package_content", value: "1x Electric Kettle" },
        ],
      }],
      adjustments: [], missingRequired: [], blockers: [], preflightNotes: [],
    };
    const result = await assessListingPushReadiness("user_1", "listing-1");
    expect(result.ready).toBe(true);
    expect(result.reasons.join(" ").toLowerCase()).not.toContain("capacity");
  });
});
