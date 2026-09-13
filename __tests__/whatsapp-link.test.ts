import { generateCode, buildLinkMessage } from "@/lib/whatsapp/link";

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

describe("buildLinkMessage", () => {
  it("wraps the code in a friendly greeting rather than sending it bare", () => {
    const message = buildLinkMessage("A1B2C3D4");
    expect(message).toContain("LINK-A1B2C3D4");
    expect(message).toContain("Hi!");
  });

  it("produces a message extractLinkCode can still pull the code out of", () => {
    // Guards against the two staying in sync: if the greeting's wording
    // ever changes to omit "LINK-<code>" or breaks it across characters
    // LINK_CODE_RE doesn't allow, linking would silently stop working.
    const message = buildLinkMessage("A1B2C3D4");
    expect(message).toMatch(/\bLINK[-\s]?[A-Z0-9]{8}\b/i);
  });
});
