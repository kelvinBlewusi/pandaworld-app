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
