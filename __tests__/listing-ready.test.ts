import { assertListingReady } from "@/lib/jumia/listing-ready";
import type { ListingRow } from "@/lib/supabase/types";

function listing(patch: Partial<ListingRow>): ListingRow {
  return {
    id: "l1", title: "", description: "", category_path: null, brand: null,
    ...patch,
  } as ListingRow;
}

function product(name: string, description: string) {
  return {
    name: { value: name },
    description: { value: description },
    attributes: [],
  };
}

// Real 2026-09-19 batch: an Air Fryer and a Blender were both blocked
// outright as "Meat" — Jumia's own sheet lists the bare word "Meat" as a
// Blocked GH product type, and it matched their descriptions' ordinary
// "cook meat, fish or vegetables" style marketing copy, not the product
// itself being a meat product.
describe("assertListingReady — prohibited-category false positives", () => {
  it("does not block an appliance whose DESCRIPTION merely mentions a prohibited word", () => {
    const air_fryer = listing({
      title: "Air Fryer - 1800W, 5.5L Capacity, Digital Display",
      description: "Cook meat, fish, or vegetables with little to no oil. Digital display, 5.5L capacity.",
      category_path: "Home & Kitchen / Small Appliances / Air Fryers",
    });
    const result = assertListingReady(
      air_fryer, "GH",
      [product("Air Fryer - 1800W, 5.5L Capacity, Digital Display", air_fryer.description!)],
    );
    expect(result.ok).toBe(true);
    expect(result.blockers).toHaveLength(0);
  });

  it("still blocks a product whose TITLE genuinely names a prohibited type", () => {
    const bad = listing({
      title: "Frozen Beef Meat Pack 1kg",
      description: "Fresh frozen beef, vacuum sealed.",
      category_path: "Groceries / Meat, Poultry & Seafood",
    });
    const result = assertListingReady(bad, "GH", [product(bad.title!, bad.description!)]);
    expect(result.ok).toBe(false);
    expect(result.blockers.join(" ")).toMatch(/Meat/);
  });
});
