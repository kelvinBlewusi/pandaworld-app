/**
 * A credit-pack purchase end to end, through the real routes: Paystack's
 * signed charge.success webhook (app/api/paystack/webhook) and the
 * redirect-back /verify (app/api/extension/credits/verify), as they ran for
 * the first live purchase (2026-10-02: webhook first, verify 4 s later).
 * The credits land once, on top of whatever the seller already has, and
 * show up where the seller looks: balance, notifications, plan.
 */

import { createHmac } from "node:crypto";
import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
let signedInAs = "user_seller";
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
jest.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: signedInAs }) }));

import { POST as webhook } from "@/app/api/paystack/webhook/route";
import { GET as verify } from "@/app/api/extension/credits/verify/route";
import {
  getOrCreateCreditBalance,
  deductCredits,
  getRecentTransactions,
  getMostRecentCreditPack,
} from "@/lib/billing/extension-credits";
import { hasFeature } from "@/lib/billing/features";
import { _resetBillingModeCache } from "@/lib/billing/mode";
import { FREE_SIGNUP_CREDITS, LISTING_CREDIT_COST, RETIRED_PACKS, getCreditPack } from "@/lib/billing/credit-packs";

const SECRET = "sk_test_flow";
const ADMIN = "user_admin";
const SELLER = "user_seller";
// The smallest pack on sale (Starter was retired 2026-10-08).
const pack = getCreditPack("standard")!;

const ledger = () => db.tables.extension_credit_transactions ?? [];
const purchases = () => ledger().filter((t) => t.type === "purchase");

/** The transaction Paystack reports for a pack bought through our checkout. */
function charge(userId: string, reference = "pwcr_c192d83e8b1e4ec4", bought = pack) {
  return {
    reference,
    status: "success",
    amount: bought.amountGhs * 100,
    currency: "GHS",
    metadata: { type: "extension_credits", user_id: userId, credits: bought.credits, pack: bought.id },
  };
}

function paystackWebhook(tx: ReturnType<typeof charge>) {
  const body = JSON.stringify({ event: "charge.success", data: tx });
  const signature = createHmac("sha512", SECRET).update(body).digest("hex");
  return webhook(new Request("https://pandaworldai.site/api/paystack/webhook", {
    method: "POST",
    headers: { "x-paystack-signature": signature },
    body,
  }));
}

async function verifyRedirect(tx: ReturnType<typeof charge>) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, json: async () => ({ status: true, data: tx }) });
  const res = await verify(new Request(`https://pandaworldai.site/api/extension/credits/verify?reference=${tx.reference}`));
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  db = new FakeDb();
  db.tables.app_settings = [{ key: "billing_enabled", value: true }];
  _resetBillingModeCache();
  signedInAs = SELLER;
  process.env.PAYSTACK_SECRET_KEY = SECRET;
  process.env.ADMIN_USER_IDS = ADMIN;
  global.fetch = jest.fn();
});

describe("a seller buying a pack (Standard)", () => {
  it("adds it to the welcome credits once, whichever of webhook and verify comes first", async () => {
    expect(await getOrCreateCreditBalance(SELLER)).toBe(FREE_SIGNUP_CREDITS); // signed up while billing is on

    expect((await paystackWebhook(charge(SELLER))).status).toBe(200);
    expect(await getOrCreateCreditBalance(SELLER)).toBe(FREE_SIGNUP_CREDITS + pack.credits);

    const back = await verifyRedirect(charge(SELLER));
    expect(back).toEqual({ status: 200, body: { success: true, balance: FREE_SIGNUP_CREDITS + pack.credits, credited: pack.credits } });
    expect((await paystackWebhook(charge(SELLER))).status).toBe(200); // Paystack retrying

    expect(await getOrCreateCreditBalance(SELLER)).toBe(FREE_SIGNUP_CREDITS + pack.credits);
    expect(purchases()).toEqual([
      expect.objectContaining({ user_id: SELLER, amount: pack.credits, balance_after: FREE_SIGNUP_CREDITS + pack.credits, reference: "pwcr_c192d83e8b1e4ec4" }),
    ]);
  });

  it("credits it when the seller's return reaches /verify before Paystack's webhook", async () => {
    await getOrCreateCreditBalance(SELLER);
    expect((await verifyRedirect(charge(SELLER))).body.balance).toBe(FREE_SIGNUP_CREDITS + pack.credits);
    expect((await paystackWebhook(charge(SELLER))).status).toBe(200);
    expect(await getOrCreateCreditBalance(SELLER)).toBe(FREE_SIGNUP_CREDITS + pack.credits);
    expect(purchases()).toHaveLength(1);
  });

  it("adds it to what's left after spending some", async () => {
    await getOrCreateCreditBalance(SELLER);
    for (let i = 0; i < 6; i++) await deductCredits(SELLER, LISTING_CREDIT_COST, "Extension autofill");
    const left = FREE_SIGNUP_CREDITS - 6 * LISTING_CREDIT_COST;

    await paystackWebhook(charge(SELLER));
    expect(await getOrCreateCreditBalance(SELLER)).toBe(left + pack.credits);
  });

  it("gives a seller with no balance yet the welcome credits too, recorded before the purchase", async () => {
    await paystackWebhook(charge(SELLER)); // signed up while billing was off: no ledger row
    expect(await getOrCreateCreditBalance(SELLER)).toBe(FREE_SIGNUP_CREDITS + pack.credits);
    expect(ledger().map((t) => [t.type, t.amount, t.balance_after])).toEqual([
      ["grant", FREE_SIGNUP_CREDITS, FREE_SIGNUP_CREDITS],
      ["purchase", pack.credits, FREE_SIGNUP_CREDITS + pack.credits],
    ]);
  });

  it("shows in their notifications and plan, unlocking what Standard includes", async () => {
    await getOrCreateCreditBalance(SELLER);
    await paystackWebhook(charge(SELLER));

    expect((await getRecentTransactions(SELLER)).map((t) => t.description)).toContain(`Purchased ${pack.credits} credits (standard pack)`);
    expect((await getMostRecentCreditPack(SELLER))?.id).toBe("standard");
    expect(await hasFeature(SELLER, "shipping_labels")).toBe(true); // Standard and up
    expect(await hasFeature(SELLER, "order_alerts")).toBe(false); // Pro and up
  });

  // Owner, 2026-10-08: "let's remove the 35 GHS PACK". A Starter checkout
  // opened before that and paid after still gets its credits.
  it("credits a Starter checkout paid after Starter was retired, with no pack features", async () => {
    const starter = RETIRED_PACKS.find((p) => p.id === "starter")!;
    await getOrCreateCreditBalance(SELLER);
    expect((await paystackWebhook(charge(SELLER, "pwcr_old_starter", starter))).status).toBe(200);
    expect(await getOrCreateCreditBalance(SELLER)).toBe(FREE_SIGNUP_CREDITS + starter.credits);
    expect((await getMostRecentCreditPack(SELLER))?.id).toBe("starter");
    expect(await hasFeature(SELLER, "shipping_labels")).toBe(false);
  });

  it("is spent from like any other credits", async () => {
    await getOrCreateCreditBalance(SELLER);
    await paystackWebhook(charge(SELLER));
    expect(await deductCredits(SELLER, LISTING_CREDIT_COST, "Extension autofill"))
      .toEqual({ ok: true, balance: FREE_SIGNUP_CREDITS + pack.credits - LISTING_CREDIT_COST });
  });
});

describe("refused", () => {
  it("won't let another account claim the purchase through /verify", async () => {
    signedInAs = "user_someone_else";
    expect((await verifyRedirect(charge(SELLER))).status).toBe(400);
    expect(purchases()).toHaveLength(0);
  });

  it("ignores a webhook without Paystack's signature", async () => {
    const res = await webhook(new Request("https://pandaworldai.site/api/paystack/webhook", {
      method: "POST",
      headers: { "x-paystack-signature": "00" },
      body: JSON.stringify({ event: "charge.success", data: charge(SELLER) }),
    }));
    expect(res.status).toBe(401);
    expect(purchases()).toHaveLength(0);
  });
});

describe("an admin buying a pack (the 2026-10-02 test payment)", () => {
  it("stores the credits but keeps the admin unmetered, with nothing in the bell", async () => {
    await paystackWebhook(charge(ADMIN));
    expect(db.tables.extension_credits).toEqual([expect.objectContaining({ user_id: ADMIN, balance: FREE_SIGNUP_CREDITS + pack.credits })]);
    expect(await getOrCreateCreditBalance(ADMIN)).toBe(Infinity);
    expect(await getRecentTransactions(ADMIN)).toEqual([]);
  });
});
