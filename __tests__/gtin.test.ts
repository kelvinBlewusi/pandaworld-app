import { isValidGTIN } from "@/lib/utils/gtin";

describe("isValidGTIN", () => {
  // Valid EAN-13 (standard barcode)
  it("accepts valid EAN-13", () => {
    expect(isValidGTIN("4006381333931")).toBe(true);
    expect(isValidGTIN("5901234123457")).toBe(true);
  });

  // Valid UPC-12
  it("accepts valid UPC-12", () => {
    expect(isValidGTIN("012345678905")).toBe(true);
  });

  // Valid EAN-8
  it("accepts valid EAN-8", () => {
    expect(isValidGTIN("96385074")).toBe(true);
  });

  // Invalid check digit
  it("rejects wrong check digit", () => {
    expect(isValidGTIN("4006381333930")).toBe(false);
    expect(isValidGTIN("5901234123456")).toBe(false);
  });

  // Wrong length
  it("rejects wrong-length strings", () => {
    expect(isValidGTIN("123456789")).toBe(false);   // 9 digits
    expect(isValidGTIN("12345678901")).toBe(false);  // 11 digits
  });

  // Strips non-digits from input
  it("strips non-digit characters before validating", () => {
    expect(isValidGTIN("4-006381-33393-1")).toBe(true);
    expect(isValidGTIN(" 4006381333931 ")).toBe(true);
  });

  // Empty / invalid
  it("rejects empty string", () => {
    expect(isValidGTIN("")).toBe(false);
  });
});
