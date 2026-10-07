/**
 * Pack features (lib/billing/features.ts), the owner's rules of 2026-10-06:
 * a feature comes with the pack the seller last bought (a smaller pack
 * bought later means the smaller pack's features), and none works at 0
 * credits until they top up. Since 2026-10-07 the chat's features are on
 * every plan; QC fixes and WhatsApp labels (Standard) and alerts (Pro) need
 * a pack. The QC check that refunds a rejected listing
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
import { everyoneFeatures, packFeatures } from "@/lib/billing/credit-packs";

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

describe("the chat's features: on every plan (owner, 2026-10-07)", () => {
  it("need no pack: free credits, Starter, or a grant of credits are enough", async () => {
    for (const f of ["shop_whatsapp", "fee_calc_whatsapp"] as const) {
      expect(await hasFeature("seller", f)).toBe(true);
      bought(100);
      expect(await hasFeature("seller", f)).toBe(true);
      db.tables.extension_credit_transactions = [{ user_id: "seller", type: "grant", amount: 12 }];
      expect(await hasFeature("seller", f)).toBe(true);
    }
  });

  it("aren't any pack's own, and name no pack", () => {
    expect(everyoneFeatures().map((f) => f.id)).toEqual(["shop_whatsapp", "fee_calc_whatsapp"]);
    expect(featureMinPackName("shop_whatsapp")).toBe("");
  });
});

describe("QC fixes and WhatsApp labels (Standard and up), alerts (Pro and up)", () => {
  it("aren't included without a pack, or with only Starter", async () => {
    expect(await hasFeature("seller", "qc_fix")).toBe(false);
    expect(await hasFeature("seller", "shipping_labels")).toBe(false);
    expect(await hasFeature("seller", "order_alerts")).toBe(false);
    bought(100);
    expect(await hasFeature("seller", "qc_fix")).toBe(false);
    expect(await hasFeature("seller", "shipping_labels")).toBe(false);
    expect(await hasFeature("seller", "order_alerts")).toBe(false);
  });

  it("QC fixes and labels come with Standard, Pro or Business; alerts with Pro or Business", async () => {
    bought(210);
    expect(await hasFeature("seller", "qc_fix")).toBe(true);
    expect(await hasFeature("seller", "shipping_labels")).toBe(true);
    expect(await hasFeature("seller", "order_alerts")).toBe(false);
    for (const credits of [440, 940]) {
      bought(credits);
      expect(await hasFeature("seller", "shipping_labels")).toBe(true);
      expect(await hasFeature("seller", "order_alerts")).toBe(true);
    }
  });

  it("follow the pack bought last: a smaller pack after a bigger one means the smaller one's features", async () => {
    bought(440, 100);
    expect((await currentPack("seller"))?.id).toBe("starter");
    expect(await hasFeature("seller", "shipping_labels")).toBe(false);
    expect(await hasFeature("seller", "image_polish_extension")).toBe(false);

    bought(100, 440);
    expect((await currentPack("seller"))?.id).toBe("pro");
    expect(await hasFeature("seller", "image_polish_extension")).toBe(true);
  });

  it("count an earlier pack by its nearest pack today", async () => {
    bought(200); // the old GHS 50 pack
    expect(await hasFeature("seller", "shipping_labels")).toBe(true);
  });

  it("ignore grants of credits and deductions", async () => {
    db.tables.extension_credit_transactions = [{ user_id: "seller", type: "grant", amount: 940 }];
    expect(await hasFeature("seller", "shipping_labels")).toBe(false);
  });

  it("are everyone's while billing is off, and always an admin's, at any balance", async () => {
    balance(0);
    expect(await hasFeature("admin", "order_alerts")).toBe(true);
    billingOn = false;
    expect(await hasFeature("seller", "order_alerts")).toBe(true);
  });

  it("name the pack they start at", () => {
    expect(featureMinPackName("qc_fix")).toBe("Standard");
    expect(featureMinPackName("shipping_labels")).toBe("Standard");
    expect(featureMinPackName("order_alerts")).toBe("Pro");
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
    expect(await featureAccess("seller", "shipping_labels")).toEqual({ ok: false, blockedBy: "pack" });
  });

  it("the chat's features, on every plan, say it's the credits", async () => {
    balance(0);
    for (const f of ["shop_whatsapp", "fee_calc_whatsapp"] as const) {
      expect(await featureAccess("seller", f)).toEqual({ ok: false, blockedBy: "credits" });
    }
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
  // The chat's features are on every plan (everyoneFeatures) and no pack lists them.
  it("Standard adds QC fixes and shipping labels; Pro the extension's two tools and the alerts to come", () => {
    expect(packFeatures("starter")).toEqual([]);
    // Labels from Standard since 2026-10-07: each one is charged.
    expect(packFeatures("standard").map((f) => f.id)).toEqual(["qc_fix", "shipping_labels"]);
    const pro = packFeatures("pro");
    expect(pro.filter((f) => !f.comingSoon).map((f) => f.id)).toEqual(["qc_fix", "fee_calc_extension", "image_polish_extension"]);
    expect(pro.filter((f) => f.comingSoon).map((f) => f.label)).toEqual([
      "Order and payout alerts on WhatsApp",
      "Shipping labels on WhatsApp",
    ]);
    expect(packFeatures("business")).toEqual(pro);
  });
});
