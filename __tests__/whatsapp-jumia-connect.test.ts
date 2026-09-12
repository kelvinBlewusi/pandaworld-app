import { splitCredentialTokens, isResendCommand, buildConnectInstructions, jumiaConnectLink } from "@/lib/whatsapp/jumia-connect";

describe("splitCredentialTokens", () => {
  it("splits on whitespace", () => {
    expect(splitCredentialTokens("092f83a8-c4ae-4d57-a13f-26e4f47b07c3 mXTNC33WFlKak2XfLFwmihiOOrZ5O1itDQ7djAStTwc=")).toEqual([
      "092f83a8-c4ae-4d57-a13f-26e4f47b07c3",
      "mXTNC33WFlKak2XfLFwmihiOOrZ5O1itDQ7djAStTwc=",
    ]);
  });

  it("splits across newlines and collapses extra whitespace", () => {
    expect(splitCredentialTokens("abc\n\n  def  ")).toEqual(["abc", "def"]);
  });

  it("returns a single-element array for one token", () => {
    expect(splitCredentialTokens("just-one-token")).toEqual(["just-one-token"]);
  });

  it("returns an empty array for blank text", () => {
    expect(splitCredentialTokens("   ")).toEqual([]);
  });
});

describe("isResendCommand", () => {
  it("matches 'resend' case-insensitively with optional punctuation", () => {
    expect(isResendCommand("resend")).toBe(true);
    expect(isResendCommand("Resend!")).toBe(true);
    expect(isResendCommand("  RESEND.  ")).toBe(true);
  });

  it("does not match other text", () => {
    expect(isResendCommand("resend it please")).toBe(false);
    expect(isResendCommand("hello")).toBe(false);
  });
});

describe("buildConnectInstructions", () => {
  it("includes the redirect URI the seller must paste into Jumia", () => {
    const text = buildConnectInstructions("https://pandaworld.gh/api/jumia/callback");
    expect(text).toContain("https://pandaworld.gh/api/jumia/callback");
    expect(text).toContain("vendorcenter.jumia.com");
  });
});

describe("jumiaConnectLink", () => {
  it("builds a wa_token-bearing link to the connect route", () => {
    const link = jumiaConnectLink("abc-123");
    expect(link).toContain("/api/jumia/connect?wa_token=abc-123");
  });
});
