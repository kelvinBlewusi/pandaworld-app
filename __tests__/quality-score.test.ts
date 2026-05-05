import { calculateQualityScore, DEFAULT_THRESHOLD } from "@/lib/quality-score";
import type { ListingRow } from "@/lib/supabase/types";

// Minimal mock listing factory
function makeListing(overrides: Partial<ListingRow> = {}): Partial<ListingRow> {
  return {
    title:         "Samsung Galaxy A55 5G – 128GB – Navy",
    description:   "The Samsung Galaxy A55 5G delivers a premium experience with its 6.6-inch display and 50MP triple camera system. Great for everyday use in Ghana.",
    highlights:    "• 6.6-inch Super AMOLED 120Hz display\n• 50MP OIS main camera\n• 5000mAh battery\n• IP67 water resistance\n• 5G connectivity",
    brand:         "Samsung",
    color:         "Navy Blue",
    selling_price: 2199,
    category_code: "1000000",
    images:        ["https://example.com/img1.jpg", "https://example.com/img2.jpg", "https://example.com/img3.jpg"],
    weight_kg:     0.213,
    main_material: "Aluminium",
    warranty_duration: "1 year",
    dynamic_attributes: { ram: "8GB", operating_system: "Android" },
    ...overrides,
  };
}

const noAttrs = [] as never[];
const variantWithPrice = [{ globalPrice: "2199", quantity: "5" }];

describe("calculateQualityScore", () => {
  it("scores a complete listing above the default threshold", () => {
    const result = calculateQualityScore(makeListing(), noAttrs, variantWithPrice);
    expect(result.score).toBeGreaterThanOrEqual(DEFAULT_THRESHOLD);
  });

  it("gives 0 for a completely empty listing", () => {
    const result = calculateQualityScore({}, noAttrs, []);
    expect(result.score).toBe(0);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("deducts points for missing description", () => {
    const full = calculateQualityScore(makeListing(), noAttrs, variantWithPrice);
    const noDesc = calculateQualityScore(makeListing({ description: null }), noAttrs, variantWithPrice);
    expect(noDesc.score).toBeLessThan(full.score);
    expect(noDesc.issues.some((i) => i.toLowerCase().includes("description"))).toBe(true);
  });

  it("deducts points for missing highlights", () => {
    const noHL = calculateQualityScore(makeListing({ highlights: null }), noAttrs, variantWithPrice);
    expect(noHL.issues.some((i) => i.toLowerCase().includes("bullet"))).toBe(true);
  });

  it("deducts points when no images", () => {
    const noImg = calculateQualityScore(makeListing({ images: [] }), noAttrs, variantWithPrice);
    expect(noImg.imageCount).toBe(0);
  });

  it("awards full image points for 6+ images", () => {
    const manyImg = calculateQualityScore(
      makeListing({ images: Array(6).fill("https://example.com/img.jpg") }),
      noAttrs,
      variantWithPrice
    );
    expect(manyImg.imageCount).toBe(20);
  });

  it("flags missing required category attrs", () => {
    const attrs = [
      { name: "ram", label: "RAM", type: "enum" as const, allowed_values: ["8GB"], required: true, is_variant: true },
    ];
    const result = calculateQualityScore(
      makeListing({ dynamic_attributes: {} }),
      attrs,
      variantWithPrice
    );
    expect(result.issues.some((i) => i.includes("RAM"))).toBe(true);
  });

  it("score components sum approximately to total", () => {
    const r = calculateQualityScore(makeListing(), noAttrs, variantWithPrice);
    const sum = r.requiredFields + r.contentLength + r.imageCount + r.variantCoverage + r.specifications;
    expect(r.score).toBe(Math.min(100, sum));
  });
});
