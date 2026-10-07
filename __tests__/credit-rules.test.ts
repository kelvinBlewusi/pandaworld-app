/**
 * The owner's credit rules of 2026-10-06 (lib/billing/credit-status.ts,
 * lib/whatsapp/credit-gate.ts, the hooks in lib/billing/extension-credits.ts):
 *   - at 0 credits (owner, 2026-10-07; below a listing's cost before), the
 *     chat sends ONE reply saying to top up, then it's locked (no reply, no
 *     "typing…") until the balance is above 0: a purchase or a refund; only
 *     disconnecting Jumia still answers;
 *   - below 6, one WhatsApp warning at the next message, and one notice in
 *     the dashboard bell and extension panel when a charge takes them there;
 *   - a purchase or a refund resets all of it, so the next drop is told again;
 *   - at the start of a batch, a count the credits can't cover is refused
 *     before any photo is accepted.
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
let billingOn = true;
jest.mock("@/lib/billing/mode", () => ({ isBillingEnabled: async () => billingOn }));
jest.mock("@/lib/auth/is-admin", () => ({ isAdmin: (id: string) => id === "admin" }));

const sent: { to: string; body: string; button: string }[] = [];
jest.mock("@/lib/whatsapp/client", () => ({
  sendCtaUrlIfConfigured: async (to: string, body: string, button: string) => { sent.push({ to, body, button }); },
}));

import { batchCreditRefusal, botPausedForCredits, creditGate, isCreditQuiet } from "@/lib/whatsapp/credit-gate";
import { creditPurchase, deductCredits } from "@/lib/billing/extension-credits";

const PHONE = "233200000000";
const balance = (n: number) => { db.tables.extension_credits = [{ user_id: "seller", balance: n }]; };
const notices = (kind?: string) => (db.tables.user_notices ?? []).filter((n) => !kind || n.kind === kind);
const open = (kind: string) => notices(kind).filter((n) => !n.dismissed_at);

beforeEach(() => {
  db = new FakeDb();
  billingOn = true;
  sent.length = 0;
  balance(20);
});

describe("at 0 credits", () => {
  it("one reply about credits, with Buy credits, then silence", async () => {
    balance(0);
    expect(await creditGate("seller", PHONE, "hi")).toBe("stop");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain("🔒 You've used all your PandaWorld credits, so this chat is locked until you top up.");
    expect(sent[0].body).toContain("A refund from Jumia's quality check unlocks it too.");
    expect(sent[0].body).toContain("Updates about listings already with Jumia will still come here");
    expect(sent[0].button).toBe("Buy credits");

    for (const text of ["hello?", "orders", "help", "status", undefined]) {
      expect(await creditGate("seller", PHONE, text)).toBe("stop");
    }
    expect(sent).toHaveLength(1);
  });

  it("no typing indicator once the one reply has gone out", async () => {
    balance(0);
    expect(await isCreditQuiet("seller")).toBe(false); // the first message still gets typing + the reply
    await creditGate("seller", PHONE, "hi");
    expect(await isCreditQuiet("seller")).toBe(true);
  });

  it("disconnecting Jumia still answers", async () => {
    balance(0);
    await creditGate("seller", PHONE, "hi");
    expect(await creditGate("seller", PHONE, "disconnect")).toBe("go");
    expect(await creditGate("seller", PHONE, "confirm disconnect")).toBe("go");
    expect(await creditGate("seller", PHONE, "keep jumia connected")).toBe("go");
  });

  it("a below-zero balance counts as 0", async () => {
    balance(-1);
    expect(await creditGate("seller", PHONE, "hi")).toBe("stop");
  });

  it("a purchase brings the bot back, and a later drop to 0 is told again", async () => {
    balance(0);
    await creditGate("seller", PHONE, "hi");
    await creditPurchase({ userId: "seller", credits: 100, reference: "ref-1", description: "Starter" });
    expect(await isCreditQuiet("seller")).toBe(false);
    expect(await creditGate("seller", PHONE, "hi")).toBe("go");

    sent.length = 0;
    balance(0);
    expect(await creditGate("seller", PHONE, "hi")).toBe("stop");
    expect(sent).toHaveLength(1);
  });

  it("a balance topped up by hand is seen at the next message", async () => {
    balance(0);
    await creditGate("seller", PHONE, "hi");
    balance(4);
    expect(await creditGate("seller", PHONE, "hi")).toBe("go");
  });

  it("admins and everyone while billing is off are never stopped", async () => {
    db.tables.extension_credits = [{ user_id: "admin", balance: 0 }];
    expect(await creditGate("admin", PHONE, "hi")).toBe("go");
    billingOn = false;
    balance(0);
    expect(await creditGate("seller", PHONE, "hi")).toBe("go");
    expect(sent).toHaveLength(0);
  });
});

describe("above 0 but below one listing's cost (the owner's test seller had 1 credit)", () => {
  it("1 credit: the chat still answers (its features cost less), with the running-low warning", async () => {
    balance(1);
    expect(await creditGate("seller", PHONE, "hi")).toBe("go");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain("💡 Heads up: you have 1 credit left");
    expect(await isCreditQuiet("seller")).toBe(false);
    expect(await botPausedForCredits("seller")).toBe(false);
  });

  it("but a listing it can't cover is refused before any photo", async () => {
    balance(1);
    expect(await batchCreditRefusal("seller", 1)).toContain("not enough to list a product");
  });

  it("a refund from 0 unlocks the chat, and the next lock is told again", async () => {
    balance(0);
    await creditGate("seller", PHONE, "hi");
    expect(await botPausedForCredits("seller")).toBe(true);
    balance(0.5); // a refunded live change
    expect(await creditGate("seller", PHONE, "hi")).toBe("go");
    expect(await botPausedForCredits("seller")).toBe(false);
    sent.length = 0;
    balance(0);
    expect(await creditGate("seller", PHONE, "hi")).toBe("stop");
    expect(sent).toHaveLength(1);
  });

  it("the web chat's reply doesn't ask for a message to carry on: the page unlocks itself", async () => {
    balance(0);
    await creditGate("seller", "web:seller", undefined);
    expect(sent[0].body).toContain("it unlocks straight away.");
    expect(sent[0].body).not.toContain("send me a message");
  });
});

describe("running low (below 6)", () => {
  it("one WhatsApp warning, sent with the next reply, then not again", async () => {
    balance(4);
    expect(await creditGate("seller", PHONE, "3")).toBe("go");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain("you have 4 credits left, enough for about 2 WhatsApp listings");
    expect(await creditGate("seller", PHONE, "3")).toBe("go");
    expect(sent).toHaveLength(1);
  });

  it("6 or more: nothing", async () => {
    balance(6);
    expect(await creditGate("seller", PHONE, "hi")).toBe("go");
    expect(sent).toHaveLength(0);
  });

  it("back to 6 or more resets it, so the next drop warns again", async () => {
    balance(4);
    await creditGate("seller", PHONE, "hi");
    balance(10);
    await creditGate("seller", PHONE, "hi");
    balance(3);
    expect(await creditGate("seller", PHONE, "hi")).toBe("go");
    expect(sent).toHaveLength(2);
  });
});

describe("dashboard and extension notices, from charges", () => {
  it("dropping below 6 adds one 'running low' notice", async () => {
    balance(7);
    await deductCredits("seller", 1, "Extension autofill"); // 6
    expect(notices()).toHaveLength(0);
    await deductCredits("seller", 1, "Extension autofill"); // 5
    await deductCredits("seller", 1, "Extension autofill"); // 4
    expect(open("credits_low")).toHaveLength(1);
    expect(open("credits_low")[0].title).toBe("You're running low on credits");
    expect(open("credits_low")[0].body).toContain("You have *5 credits* left");
  });

  it("reaching 0 replaces it with 'out of credits'", async () => {
    balance(3);
    await deductCredits("seller", 1, "a"); // 2: low
    await deductCredits("seller", 2, "b"); // 0: out
    expect(open("credits_low")).toHaveLength(0);
    expect(open("credits_out")).toHaveLength(1);
    expect(open("credits_out")[0].body).toContain("Your chat (WhatsApp and the Jumia Listing Assistant), order alerts and pack features are locked until you buy credits.");
    expect(open("credits_out")[0].body).toContain("a refund from Jumia's quality check brings everything back");
  });

  it("a purchase takes the notices down", async () => {
    balance(1);
    await deductCredits("seller", 1, "a"); // 0
    expect(open("credits_out")).toHaveLength(1);
    await creditPurchase({ userId: "seller", credits: 100, reference: "ref-2", description: "Starter" });
    expect(open("credits_out")).toHaveLength(0);
    expect(open("credits_low")).toHaveLength(0);
  });

  it("a refund of 2 back above 0 (still low) takes down 'out', keeps quiet about 'low'", async () => {
    balance(1);
    await deductCredits("seller", 1, "a"); // 0
    await creditPurchase({ userId: "seller", credits: 2, reference: "refund-test", description: "not a pack" });
    expect(open("credits_out")).toHaveLength(0);
    expect(open("credits_low")).toHaveLength(0);
  });
});

describe("at the start of a batch, before any photo", () => {
  it("a count the credits can't cover is refused, with how many they can list", async () => {
    balance(5);
    expect(await batchCreditRefusal("seller", 4)).toBe(
      "⚠️ You have 5 credits available: enough to list 2 of your 4 products (2 credits each when it goes live on Jumia). " +
      "Reply *2* to list those now, or buy credits to list all 4.",
    );
    expect(await batchCreditRefusal("seller", 2)).toBeNull();
  });

  it("none at all, counting what's held for listings still with Jumia", async () => {
    balance(5);
    db.tables.listings = [{ id: "l1", user_id: "seller", status: "pending_approval", credits_due: 4 }];
    expect(await batchCreditRefusal("seller", 1)).toBe(
      "⚠️ You have 1 credit available (4 more held for listings waiting on Jumia): not enough to list a product " +
      "(2 credits each when it goes live on Jumia). Buy credits, or wait for Jumia's verdict on those listings, then tell me how many products you're listing.",
    );
  });

  it("nothing when the credits cover the batch, or the seller isn't charged", async () => {
    balance(20);
    expect(await batchCreditRefusal("seller", 10)).toBeNull();
    billingOn = false;
    balance(0);
    expect(await batchCreditRefusal("seller", 3)).toBeNull();
  });
});
