/**
 * Pack features (lib/billing/features.ts): a feature comes with the
 * highest pack a seller has ever bought; admins and everyone while billing
 * is off have them all.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));

let billingOn = true;
jest.mock("@/lib/billing/mode", () => ({ isBillingEnabled: async () => billingOn }));
jest.mock("@/lib/auth/is-admin", () => ({ isAdmin: (id: string) => id === "admin" }));

import { featureMinPackName, hasFeature, highestPackBought } from "@/lib/billing/features";
import { packFeatures } from "@/lib/billing/credit-packs";

const bought = (...credits: number[]) => {
  db.tables.extension_credit_transactions = credits.map((amount) => ({ user_id: "seller", type: "purchase", amount }));
};

beforeEach(() => {
  billingOn = true;
  db.tables.extension_credit_transactions = [];
});

describe("QC fixes (Standard and up)", () => {
  it("aren't included without a pack, or with only Starter", async () => {
    expect(await hasFeature("seller", "qc_fix")).toBe(false);
    bought(100);
    expect(await hasFeature("seller", "qc_fix")).toBe(false);
  });

  it("come with Standard, Pro or Business", async () => {
    for (const credits of [210, 440, 940]) {
      bought(credits);
      expect(await hasFeature("seller", "qc_fix")).toBe(true);
    }
  });

  it("stay with the highest pack ever bought, whatever came after", async () => {
    bought(210, 100, 100);
    expect((await highestPackBought("seller"))?.id).toBe("standard");
    expect(await hasFeature("seller", "qc_fix")).toBe(true);
  });

  it("count an earlier pack by its nearest pack today", async () => {
    bought(200); // the old GHS 50 pack
    expect(await hasFeature("seller", "qc_fix")).toBe(true);
  });

  it("ignore grants and deductions", async () => {
    db.tables.extension_credit_transactions = [{ user_id: "seller", type: "grant", amount: 940 }];
    expect(await hasFeature("seller", "qc_fix")).toBe(false);
  });

  it("are everyone's while billing is off, and always an admin's", async () => {
    expect(await hasFeature("admin", "qc_fix")).toBe(true);
    billingOn = false;
    expect(await hasFeature("seller", "qc_fix")).toBe(true);
  });

  it("name the pack they start at", () => {
    expect(featureMinPackName("qc_fix")).toBe("Standard");
  });
});

describe("what each pack lists", () => {
  it("adds QC fixes from Standard and the coming-soon five from Pro", () => {
    expect(packFeatures("starter")).toEqual([]);
    expect(packFeatures("standard").map((f) => f.id)).toEqual(["qc_fix"]);
    const pro = packFeatures("pro");
    expect(pro.filter((f) => f.comingSoon).map((f) => f.label)).toEqual([
      "Order alerts on WhatsApp",
      "Shipping labels on WhatsApp",
      "Jumia fee calculator on WhatsApp",
      "Jumia fee calculator on the extension panel",
      "Jumia image polish on the Chrome extension",
    ]);
    expect(packFeatures("business")).toEqual(pro);
  });
});
