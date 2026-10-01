/**
 * A credit-pack purchase only counts when the money matches the pack: a
 * transaction a browser starts with the public key can carry any metadata.
 */
import { createHmac } from "node:crypto";
import { creditsPaidFor, verifyPaystackSignature } from "@/lib/billing/paystack-purchase";
import { getCreditPack } from "@/lib/billing/credit-packs";

const standard = getCreditPack("standard")!;
const paid = (over: Record<string, unknown> = {}, meta: Record<string, unknown> = {}) => ({
  amount: standard.amountGhs * 100,
  currency: "GHS",
  metadata: { type: "extension_credits", user_id: "user_1", credits: standard.credits, pack: "standard", ...meta },
  ...over,
});

describe("creditsPaidFor", () => {
  it("credits a pack paid in full", () => {
    expect(creditsPaidFor(paid())).toEqual({ ok: true, credits: standard.credits, packId: "standard" });
  });

  it("refuses a charge for less than the pack's price", () => {
    expect(creditsPaidFor(paid({ amount: 100 })).ok).toBe(false);
  });

  it("refuses more credits than the pack holds", () => {
    expect(creditsPaidFor(paid({}, { credits: 100000 })).ok).toBe(false);
  });

  it("refuses another currency, an unknown pack, or no credits", () => {
    expect(creditsPaidFor(paid({ currency: "NGN" })).ok).toBe(false);
    expect(creditsPaidFor(paid({}, { pack: "mega" })).ok).toBe(false);
    expect(creditsPaidFor(paid({}, { credits: 0 })).ok).toBe(false);
    expect(creditsPaidFor({ amount: 7000, currency: "GHS", metadata: null }).ok).toBe(false);
  });
});

describe("verifyPaystackSignature", () => {
  const body = JSON.stringify({ event: "charge.success" });
  const sign = (b: string) => createHmac("sha512", "sk_test_x").update(b).digest("hex");

  it("accepts Paystack's signature and nothing else", () => {
    expect(verifyPaystackSignature(body, sign(body), "sk_test_x")).toBe(true);
    expect(verifyPaystackSignature(body + " ", sign(body), "sk_test_x")).toBe(false);
    expect(verifyPaystackSignature(body, "abc", "sk_test_x")).toBe(false);
    expect(verifyPaystackSignature(body, null, "sk_test_x")).toBe(false);
  });
});
