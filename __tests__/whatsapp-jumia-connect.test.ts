import { splitCredentialTokens, identifyCredentials, isResendCommand, buildConnectInstructions, jumiaConnectLink } from "@/lib/whatsapp/jumia-connect";

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

  it("strips invisible unicode characters a mobile keyboard or copy source can inject", () => {
    const dirtyId = "b827fe1b-72c7-4851-83b8-a1c8508dd967" + "\u200B";
    const dirtySecret = "\uFEFF" + "YmLqm5GVeMCQWhwK4pxm0i-Q7vNSGXN2SVV5IqRKxGQ=";
    expect(splitCredentialTokens(`${dirtyId} ${dirtySecret}`)).toEqual([
      "b827fe1b-72c7-4851-83b8-a1c8508dd967",
      "YmLqm5GVeMCQWhwK4pxm0i-Q7vNSGXN2SVV5IqRKxGQ=",
    ]);
  });
});

describe("identifyCredentials", () => {
  const uuid = "b827fe1b-72c7-4851-83b8-a1c8508dd967";
  const secret = "YmLqm5GVeMCQWhwK4pxm0i-Q7vNSGXN2SVV5IqRKxGQ=";

  it("keeps (appId, secretKey) as given when pasted in the documented order", () => {
    expect(identifyCredentials(uuid, secret)).toEqual({ appId: uuid, secretKey: secret });
  });

  it("re-sorts by shape when pasted in reverse order — confirmed live failure", () => {
    // Same two values as above, pasted Secret-then-ID: a purely
    // positional assignment would swap them and send the wrong pair to
    // Jumia ("Invalid App ID or Secret Key") even though they're correct.
    expect(identifyCredentials(secret, uuid)).toEqual({ appId: uuid, secretKey: secret });
  });

  it("falls back to the given order when neither token looks like a UUID", () => {
    expect(identifyCredentials("foo", "bar")).toEqual({ appId: "foo", secretKey: "bar" });
  });

  it("falls back to the given order when both tokens look like a UUID", () => {
    const other = "11111111-2222-3333-4444-555555555555";
    expect(identifyCredentials(uuid, other)).toEqual({ appId: uuid, secretKey: other });
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
