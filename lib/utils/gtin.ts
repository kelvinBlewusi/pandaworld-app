/**
 * GTIN checksum validation (EAN-8/13, UPC-12, GTIN-14).
 * Pure function — no imports, fully testable.
 */
export function isValidGTIN(value: string): boolean {
  const s = value.replace(/\D/g, "");
  if (![8, 12, 13, 14].includes(s.length)) return false;
  const digits = s.split("").map(Number);
  const check = digits.pop()!;
  let sum = 0;
  // Rightmost remaining digit is position 1 (odd) → multiplier 3
  for (let i = digits.length - 1; i >= 0; i--) {
    const posFromRight = digits.length - i; // 1-indexed
    sum += digits[i] * (posFromRight % 2 === 1 ? 3 : 1);
  }
  return check === (10 - (sum % 10)) % 10;
}
