import { checkProhibitedCategory } from "@/lib/jumia/prohibited-catalog";

// Real 2026-09-19 batch: an Air Fryer and a Blender were both blocked
// outright ("This looks like 'Meat' — Jumia blocks that product type in
// GH"), and "Battery"/"Food" warned on nearly every push in a 20-product
// batch. Both from ordinary appliance description prose mentioning the
// word ("cook meat, fish or vegetables", "1x Battery"), not the product
// itself being that type. GH's own sheet rows used below are the real
// ones (data/jumia/prohibited-product-types.json): "Meat" (Blocked),
// "Food" (warning), "Battery" (warning).
describe("checkProhibitedCategory", () => {
  it("blocks a product whose title genuinely names a prohibited type", () => {
    const result = checkProhibitedCategory("GH", ["Frozen Beef Meat Pack 1kg", "Groceries / Meat"]);
    expect(result.blocked?.keyword).toBe("Meat");
  });

  it("does not match the keyword as a substring of a longer word", () => {
    // "meatpacking" contains "meat" as a substring but is a different word.
    const result = checkProhibitedCategory("GH", ["Industrial Meatpacking Equipment Manual", null]);
    expect(result.blocked).toBeNull();
  });

  it("does not warn on a battery-adjacent word that isn't 'battery' itself", () => {
    const result = checkProhibitedCategory("GH", ["Batteryless Solar Garden Light", null]);
    expect(result.warnings).toHaveLength(0);
  });

  it("still blocks/warns when the keyword is a genuine standalone word", () => {
    const result = checkProhibitedCategory("GH", ["Cordless Drill Driver - 48V Lithium Battery", null]);
    expect(result.warnings.map((w) => w.keyword)).toContain("Battery");
  });
});

// Real 2026-09-29 batch: a collagen supplement drafted into Jumia's own
// "Health & Beauty > ... > Supplements > Hyaluronic Acid" category was held
// as "Acid", a GH row that means lab chemicals ("Industrial & Scientific /
// Lab & Scientific Products / Lab Chemicals / Acids").
describe("checkProhibitedCategory, rows scoped to one department", () => {
  const supplement = [
    "Collagen With Burn Dietary Supplement - Metabolism Support, Skin Health",
    "Health & Beauty > Vitamins & Dietary Supplements > Supplements > Hyaluronic Acid",
  ];

  it("doesn't apply a row outside its department", () => {
    const result = checkProhibitedCategory("GH", supplement, "Health & Beauty");
    expect(result.blocked).toBeNull();
  });

  it("still applies it inside its department", () => {
    const result = checkProhibitedCategory(
      "GH",
      ["Hydrochloric Acid 1L", "Industrial & Scientific > Lab & Scientific Products > Lab Chemicals > Acids"],
      "Industrial & Scientific",
    );
    expect(result.blocked?.keyword).toBe("Acid");
  });

  it("still applies it when the listing has no category yet", () => {
    expect(checkProhibitedCategory("GH", [supplement[0] + " with Acid", null], null).blocked?.keyword).toBe("Acid");
  });

  it("keeps applying rows whose label isn't a Jumia department everywhere", () => {
    // "Home / Health & Beauty / ..." — "Home" isn't a department, so the
    // row can't be scoped and keeps blocking in any department.
    const result = checkProhibitedCategory("GH", ["Pansement Adhesive Bandage", "Health & Beauty > Health Care"], "Health & Beauty");
    expect(result.blocked?.keyword).toBe("Pansement");
  });

  it("blocks Meat inside Grocery, as before", () => {
    const result = checkProhibitedCategory("GH", ["Frozen Beef Meat Pack 1kg", "Grocery > Meat"], "Grocery");
    expect(result.blocked?.keyword).toBe("Meat");
  });
});
