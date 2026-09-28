/**
 * Credits and the billing switch (lib/billing/extension-credits.ts,
 * lib/billing/mode.ts): nothing moves while billing is off, credits are
 * spent once it's on, and purchases always land in the stored balance.
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
let dbBroken = false;
jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => {
    if (dbBroken) throw new Error("database unreachable");
    return db;
  },
}));

import {
  getOrCreateCreditBalance,
  deductCredits,
  creditPurchase,
  topUpBalancesTo,
  availableCredits,
  creditsDueForSubmission,
  chargeLiveListing,
} from "@/lib/billing/extension-credits";
import { isBillingEnabled, setBillingEnabled, _resetBillingModeCache } from "@/lib/billing/mode";
import { CREDIT_PACKS, FREE_SIGNUP_CREDITS, LISTING_CREDIT_COST, LIVE_LISTING_CREDIT_COST, packReach } from "@/lib/billing/credit-packs";
import { summarizeCosts, searchOverageUsd } from "@/lib/billing/costs";

const ADMIN = "user_admin";
const SELLER = "user_seller";

const balances = () => db.tables.extension_credits ?? [];
const ledger = () => db.tables.extension_credit_transactions ?? [];

function setSwitch(on: boolean) {
  db.tables.app_settings = [{ key: "billing_enabled", value: on }];
  _resetBillingModeCache();
}

beforeEach(() => {
  db = new FakeDb();
  dbBroken = false;
  process.env.ADMIN_USER_IDS = ADMIN;
  _resetBillingModeCache();
});

describe("billing off", () => {
  beforeEach(() => setSwitch(false));

  it("gives every seller an unlimited balance without creating a ledger row", async () => {
    expect(await getOrCreateCreditBalance(SELLER)).toBe(Infinity);
    expect(balances()).toHaveLength(0);
  });

  it("charges nothing", async () => {
    expect(await deductCredits(SELLER, LISTING_CREDIT_COST, "Extension autofill")).toEqual({ ok: true, balance: Infinity });
    expect(ledger()).toHaveLength(0);
  });

  it("still stores a purchase as real credits, waiting for when billing starts", async () => {
    const result = await creditPurchase({ userId: SELLER, credits: 120, reference: "pwcr_1", description: "Purchased 120 credits" });
    expect(result).toEqual({ ok: true, balance: FREE_SIGNUP_CREDITS + 120 });
    expect(balances()[0]).toMatchObject({ user_id: SELLER, balance: FREE_SIGNUP_CREDITS + 120 });
  });
});

describe("billing on", () => {
  beforeEach(() => setSwitch(true));

  it("starts a new seller on the free sign-up credits", async () => {
    expect(await getOrCreateCreditBalance(SELLER)).toBe(FREE_SIGNUP_CREDITS);
    expect(ledger()).toEqual([expect.objectContaining({ type: "grant", amount: FREE_SIGNUP_CREDITS })]);
  });

  it("spends credits per autofill", async () => {
    const result = await deductCredits(SELLER, LISTING_CREDIT_COST, "Extension autofill");
    expect(result).toEqual({ ok: true, balance: FREE_SIGNUP_CREDITS - LISTING_CREDIT_COST });
    expect(ledger().at(-1)).toMatchObject({ type: "deduction", amount: -LISTING_CREDIT_COST });
  });

  it("refuses when the balance is too low", async () => {
    db.tables.extension_credits = [{ user_id: SELLER, balance: 1 }];
    expect(await deductCredits(SELLER, LISTING_CREDIT_COST, "Extension autofill")).toMatchObject({ ok: false, error: "insufficient_credits" });
    expect(balances()[0].balance).toBe(1);
  });

  it("never charges an admin", async () => {
    expect(await deductCredits(ADMIN, LISTING_CREDIT_COST, "Extension autofill")).toEqual({ ok: true, balance: Infinity });
    expect(balances()).toHaveLength(0);
  });

  it("adds a purchase to the balance once, however many times Paystack reports it", async () => {
    db.tables.extension_credits = [{ user_id: SELLER, balance: 4 }];
    const args = { userId: SELLER, credits: 200, reference: "pwcr_2", description: "Purchased 200 credits" };

    expect(await creditPurchase(args)).toEqual({ ok: true, balance: 204 });
    expect(await creditPurchase(args)).toEqual({ ok: true, balance: 204, alreadyProcessed: true });
    expect(ledger().filter((t) => t.type === "purchase")).toEqual([expect.objectContaining({ balance_after: 204 })]);
  });
});

describe("pay when live", () => {
  const COST = LIVE_LISTING_CREDIT_COST;
  const pending = (id: string, due: number | null, status = "pending_approval") =>
    ({ id, user_id: SELLER, status, credits_due: due, title: `Product ${id}` });

  beforeEach(() => setSwitch(true));

  it("holds credits for listings waiting on Jumia", async () => {
    db.tables.extension_credits = [{ user_id: SELLER, balance: 10 }];
    db.tables.listings = [pending("a", COST), pending("b", COST), pending("c", null), pending("d", COST, "live")];
    expect(await availableCredits(SELLER)).toBe(10 - 2 * COST);
  });

  it("lets a seller submit only what they can pay for once it's live", async () => {
    db.tables.extension_credits = [{ user_id: SELLER, balance: 5 }];
    db.tables.listings = [pending("a", COST), pending("b", COST)];
    expect(await creditsDueForSubmission(SELLER, "new", COST)).toEqual({ ok: false, available: 5 - 2 * COST });

    db.tables.listings = [pending("a", COST)];
    expect(await creditsDueForSubmission(SELLER, "new", COST)).toEqual({ ok: true, due: COST });
  });

  it("doesn't count a listing's own hold against resubmitting it", async () => {
    db.tables.extension_credits = [{ user_id: SELLER, balance: COST }];
    db.tables.listings = [pending("a", COST)];
    expect(await creditsDueForSubmission(SELLER, "a", COST)).toEqual({ ok: true, due: COST });
  });

  it("charges a listing once, when it goes live", async () => {
    db.tables.extension_credits = [{ user_id: SELLER, balance: 10 }];
    db.tables.listings = [pending("a", COST, "live")];

    expect(await chargeLiveListing("a")).toEqual({ charged: COST });
    expect(balances()[0].balance).toBe(10 - COST);
    expect(db.tables.listings[0].credits_due).toBeNull();
    expect(ledger()).toEqual([expect.objectContaining({ type: "deduction", amount: -COST, reference: "live:a", balance_after: 10 - COST })]);

    // A re-check, or a resubmission after an edit, never charges again.
    db.tables.listings[0].credits_due = COST;
    expect(await chargeLiveListing("a")).toEqual({ charged: 0 });
    expect(balances()[0].balance).toBe(10 - COST);
    expect(await creditsDueForSubmission(SELLER, "a", COST)).toEqual({ ok: true, due: null });
  });

  it("charges nothing for a listing submitted while billing was off", async () => {
    db.tables.extension_credits = [{ user_id: SELLER, balance: 10 }];
    db.tables.listings = [pending("a", null, "live")];
    expect(await chargeLiveListing("a")).toEqual({ charged: 0 });
    expect(ledger()).toHaveLength(0);
  });

  it("charges nothing if billing was switched off before it went live", async () => {
    db.tables.extension_credits = [{ user_id: SELLER, balance: 10 }];
    db.tables.listings = [pending("a", COST, "live")];
    setSwitch(false);
    expect(await chargeLiveListing("a")).toEqual({ charged: 0 });
    expect(balances()[0].balance).toBe(10);
    expect(db.tables.listings[0].credits_due).toBeNull();
  });

  it("holds nothing while billing is off", async () => {
    setSwitch(false);
    expect(await creditsDueForSubmission(SELLER, "a", COST)).toEqual({ ok: true, due: null });
  });
});

describe("topUpBalancesTo", () => {
  it("brings balances below the target up to it, once", async () => {
    db.tables.extension_credits = [
      { user_id: "a", balance: 10 },
      { user_id: "b", balance: 0 },
      { user_id: "c", balance: 40 },
      { user_id: ADMIN, balance: 0 },
    ];

    expect(await topUpBalancesTo(25)).toEqual({ toppedUp: 2 });
    expect(balances().map((r) => r.balance)).toEqual([25, 25, 40, 0]);
    expect(ledger()).toEqual([
      expect.objectContaining({ user_id: "a", type: "grant", amount: 15, balance_after: 25 }),
      expect.objectContaining({ user_id: "b", type: "grant", amount: 25, balance_after: 25 }),
    ]);

    expect(await topUpBalancesTo(25)).toEqual({ toppedUp: 0 });
  });
});

describe("the billing switch", () => {
  it("is off until an admin turns it on", async () => {
    expect(await isBillingEnabled()).toBe(false);
    await setBillingEnabled(true, ADMIN);
    expect(await isBillingEnabled()).toBe(true);
    expect(db.tables.app_settings[0]).toMatchObject({ key: "billing_enabled", value: true, updated_by: ADMIN });
  });

  it("keeps the last value it read when the database is unreachable", async () => {
    setSwitch(true);
    expect(await isBillingEnabled()).toBe(true);
    dbBroken = true;
    expect(await isBillingEnabled()).toBe(true); // cached

    _resetBillingModeCache();
    expect(await isBillingEnabled()).toBe(false); // never read: stays free
  });
});

describe("costs", () => {
  it("averages token cost per run and counts search queries", () => {
    const summary = summarizeCosts([
      { feature: "listing_draft", run_id: "r1", cost_usd: "0.001", search_queries: 0 },
      { feature: "listing_draft", run_id: "r1", cost_usd: "0.002", search_queries: 0 },
      { feature: "listing_draft", run_id: "r2", cost_usd: "0.003", search_queries: 0 },
      { feature: "extension_fill", run_id: "r3", cost_usd: 0.004, search_queries: 2 },
    ]);
    expect(summary[0]).toMatchObject({ feature: "listing_draft", runs: 2, calls: 3 });
    expect(summary[0].usdPerRun).toBeCloseTo(0.003, 10);
    expect(summary[1]).toMatchObject({ feature: "extension_fill", runs: 1, searchQueries: 2 });
  });

  it("charges for search only past the free monthly allowance", () => {
    expect(searchOverageUsd(4_999)).toBe(0);
    expect(searchOverageUsd(5_100)).toBeCloseTo(1.4, 10);
  });

  it("prices a live listing at GHS 0.50 in every pack", () => {
    for (const p of CREDIT_PACKS) expect((p.amountGhs / p.credits) * LIVE_LISTING_CREDIT_COST).toBeCloseTo(0.5, 10);
    expect(Math.min(...CREDIT_PACKS.map((p) => p.amountGhs))).toBe(30);
    expect(Math.max(...CREDIT_PACKS.map((p) => p.amountGhs))).toBe(100);
  });

  it("says how far a pack goes", () => {
    expect(packReach(200)).toEqual({ autofills: 133, listings: 100 });
  });
});
