import { createHmac } from "node:crypto";
import { verifyWhatsAppSignature, extractLinkCode } from "@/lib/whatsapp/webhook-verify";

describe("verifyWhatsAppSignature", () => {
  const secret = "test-app-secret";
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });

  function sign(payload: string, key: string): string {
    return `sha256=${createHmac("sha256", key).update(payload).digest("hex")}`;
  }

  it("accepts a correctly-signed body", () => {
    expect(verifyWhatsAppSignature(body, sign(body, secret), secret)).toBe(true);
  });

  it("rejects a body signed with the wrong secret", () => {
    expect(verifyWhatsAppSignature(body, sign(body, "wrong-secret"), secret)).toBe(false);
  });

  it("rejects a tampered body (signature no longer matches)", () => {
    const tampered = JSON.stringify({ object: "whatsapp_business_account", entry: [{ tampered: true }] });
    expect(verifyWhatsAppSignature(tampered, sign(body, secret), secret)).toBe(false);
  });

  it("rejects when the signature header is missing", () => {
    expect(verifyWhatsAppSignature(body, null, secret)).toBe(false);
  });

  it("rejects when the app secret isn't configured", () => {
    expect(verifyWhatsAppSignature(body, sign(body, secret), undefined)).toBe(false);
  });

  it("rejects a malformed (non-hex) signature header without throwing", () => {
    expect(verifyWhatsAppSignature(body, "sha256=not-valid-hex!!", secret)).toBe(false);
  });
});

describe("extractLinkCode", () => {
  it("matches the canonical format", () => {
    expect(extractLinkCode("LINK-A1B2C3D4")).toBe("A1B2C3D4");
  });

  it("is case-insensitive and tolerates no dash or a space", () => {
    expect(extractLinkCode("link a1b2c3d4")).toBe("A1B2C3D4");
    expect(extractLinkCode("LINKA1B2C3D4")).toBe("A1B2C3D4");
  });

  it("tolerates surrounding whitespace", () => {
    expect(extractLinkCode("  LINK-A1B2C3D4  ")).toBe("A1B2C3D4");
  });

  it("returns null for ordinary messages", () => {
    expect(extractLinkCode("hello, here's my product")).toBeNull();
    expect(extractLinkCode("")).toBeNull();
    expect(extractLinkCode(undefined)).toBeNull();
    expect(extractLinkCode(null)).toBeNull();
  });

  it("returns null for a code of the wrong length", () => {
    expect(extractLinkCode("LINK-A1B2C3")).toBeNull();
    expect(extractLinkCode("LINK-A1B2C3D4E5")).toBeNull();
  });

  it("finds the code inside the wa.me deep link's pre-filled greeting", () => {
    expect(
      extractLinkCode(
        "Hi! I want to link my PandaWorld account to the WhatsApp Bot, here is my connection code: LINK-A1B2C3D4",
      ),
    ).toBe("A1B2C3D4");
  });

  it("finds the code when a seller adds their own words around it", () => {
    expect(extractLinkCode("hey it's me, LINK-A1B2C3D4 thanks!")).toBe("A1B2C3D4");
  });
});
