/**
 * Pack features (lib/billing/features.ts), the owner's rules of 2026-10-06:
 * a feature comes with the pack the seller last bought (a smaller pack
 * bought later means the smaller pack's features), and none works at 0
 * credits until they top up. The QC check that refunds a rejected listing
 * keeps running at 0 (ignoreBalance). Admins and everyone while billing is
 * off have them all.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));

let billingOn = true;
jest.mock("@/lib/billing/mode", () => ({ isBillingEnabled: async () => billingOn }));
jest.mock("@/lib/auth/is-admin", () => ({ isAdmin: (id: string) => id === "admin" }));

import { currentPack, featureAccess, featureMinPackName, hasFeature } from "@/lib/billing/features";
import { packFeatures } from "@/lib/billing/credit-packs";

/** Purchases in the order made, a minute apart. */
const bought = (...credits: number[]) => {
  db.tables.extension_credit_transactions = credits.map((amount, n) => ({
    user_id: "seller", type: "purchase", amount, created_at: `2026-10-0${1 + Math.floor(n / 50)}T10:${String(n).padStart(2, "0")}:00Z`,
  }));
};
const balance = (n: number) => { db.tables.extension_credits = [{ user_id: "seller", balance: n }]; };

beforeEach(() => {
  billingOn = true;
  db.tables.extension_credit_transactions = [];
  db.tables.feature_grants = [];
  balance(50);
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

  it("follow the pack bought last: a smaller pack after a bigger one means the smaller one's features", async () => {
    bought(440, 100);
    expect((await currentPack("seller"))?.id).toBe("starter");
    expect(await hasFeature("seller", "qc_fix")).toBe(false);
    expect(await hasFeature("seller", "image_polish_extension")).toBe(false);

    bought(100, 440);
    expect((await currentPack("seller"))?.id).toBe("pro");
    expect(await hasFeature("seller", "image_polish_extension")).toBe(true);
  });

  it("count an earlier pack by its nearest pack today", async () => {
    bought(200); // the old GHS 50 pack
    expect(await hasFeature("seller", "qc_fix")).toBe(true);
  });

  it("ignore grants of credits and deductions", async () => {
    db.tables.extension_credit_transactions = [{ user_id: "seller", type: "grant", amount: 940 }];
    expect(await hasFeature("seller", "qc_fix")).toBe(false);
  });

  it("are everyone's while billing is off, and always an admin's, at any balance", async () => {
    balance(0);
    expect(await hasFeature("admin", "qc_fix")).toBe(true);
    billingOn = false;
    expect(await hasFeature("seller", "qc_fix")).toBe(true);
  });

  it("name the pack they start at", () => {
    expect(featureMinPackName("qc_fix")).toBe("Standard");
  });
});

describe("at 0 credits", () => {
  it("every pack feature pauses, and says it's the credits, not the pack", async () => {
    bought(940);
    balance(0);
    for (const f of ["qc_fix", "image_polish_extension", "fee_calc_extension", "order_alerts", "shipping_labels"] as const) {
      expect(await featureAccess("seller", f)).toEqual({ ok: false, blockedBy: "credits" });
    }
    balance(-1);
    expect(await hasFeature("seller", "qc_fix")).toBe(false);
  });

  it("comes back as soon as the balance is above 0", async () => {
    bought(210);
    balance(0);
    expect(await hasFeature("seller", "qc_fix")).toBe(false);
    balance(2); // a refund from Jumia's quality check
    expect(await hasFeature("seller", "qc_fix")).toBe(true);
  });

  it("a seller without the pack is told it's the pack, whatever the balance", async () => {
    bought(100);
    balance(0);
    expect(await featureAccess("seller", "qc_fix")).toEqual({ ok: false, blockedBy: "pack" });
  });

  it("a grant pauses too", async () => {
    db.tables.feature_grants = [{ id: "g1", user_id: "seller", feature: "image_polish_extension", free_use: true, created_at: "2026-10-06T00:00:00Z" }];
    expect(await hasFeature("seller", "image_polish_extension")).toBe(true);
    balance(0);
    expect(await hasFeature("seller", "image_polish_extension")).toBe(false);
  });

  it("the QC check that refunds a rejected listing keeps running (ignoreBalance)", async () => {
    bought(210);
    balance(0);
    expect(await hasFeature("seller", "qc_fix", { ignoreBalance: true })).toBe(true);
  });
});

describe("what each pack lists", () => {
  // The extension's two went live 2026-10-02; the WhatsApp three are still to come.
  it("adds QC fixes from Standard, and from Pro the extension's two tools and three to come", () => {
    expect(packFeatures("starter")).toEqual([]);
    expect(packFeatures("standard").map((f) => f.id)).toEqual(["qc_fix"]);
    const pro = packFeatures("pro");
    expect(pro.filter((f) => !f.comingSoon).map((f) => f.id)).toEqual(["qc_fix", "fee_calc_extension", "image_polish_extension"]);
    expect(pro.filter((f) => f.comingSoon).map((f) => f.label)).toEqual([
      "Order alerts on WhatsApp",
      "Shipping labels on WhatsApp",
      "Jumia fee calculator on WhatsApp",
    ]);
    expect(packFeatures("business")).toEqual(pro);
  });
});
