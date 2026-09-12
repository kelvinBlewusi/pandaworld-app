import { generateCode } from "@/lib/whatsapp/link";

// Regression test for a bug where generateCode() drew a single fixed-size
// batch of random bytes, base64url-encoded it, then stripped `-`/`_`
// without topping back up — ~23% of codes came out shorter than 8 chars
// and silently failed to match LINK_CODE_RE (which requires exactly 8),
// so real "LINK-<code>" messages were never recognized.
describe("generateCode", () => {
  it("always returns exactly 8 uppercase alphanumeric characters", () => {
    for (let i = 0; i < 2000; i++) {
      const code = generateCode();
      expect(code).toMatch(/^[A-Z0-9]{8}$/);
    }
  });
});
