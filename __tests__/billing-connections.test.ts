/**
 * WhatsApp and Jumia as conditions (owner, 2026-10-07; lib/billing/
 * connections.ts): every pack is bought with both connected; Standard, Pro
 * and Business autofill in the extension only while both are; free credits
 * and Starter autofill whatever is connected.
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
let billingOn = true;
jest.mock("@/lib/billing/mode", () => ({ isBillingEnabled: async () => billingOn }));
jest.mock("@/lib/auth/is-admin", () => ({ isAdmin: (id: string) => id === "admin" }));

let jumiaKind = "connected";
jest.mock("@/lib/jumia/credentials", () => ({ getJumiaConnectionKind: async () => jumiaKind }));

let clerkUser: string | null = "seller";
jest.mock("@clerk/nextjs/server", () => ({
  auth: async () => ({ userId: clerkUser }),
  currentUser: async () => ({ primaryEmailAddress: { emailAddress: "seller@test.dev" } }),
}));
jest.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => null, RATE_LIMITS: {} }));

import { autofillBlock, missingConnections, purchaseBlock } from "@/lib/billing/connections";
import { POST as checkout } from "@/app/api/extension/credits/checkout/route";
import { GET as eligibility } from "@/app/api/extension/credits/eligibility/route";

const linked = () => { db.tables.whatsapp_connections = [{ user_id: "seller", phone_number: "233200000000" }]; };
const bought = (credits: number) => {
  db.tables.extension_credit_transactions = [{ user_id: "seller", type: "purchase", amount: credits, created_at: "2026-10-01T10:00:00Z" }];
};

beforeEach(() => {
  db = new FakeDb();
  db.tables.whatsapp_connections = [];
  db.tables.extension_credit_transactions = [];
  db.tables.extension_credits = [{ user_id: "seller", balance: 50 }];
  billingOn = true;
  jumiaKind = "connected";
  clerkUser = "seller";
  process.env.PAYSTACK_SECRET_KEY = "sk_test";
  global.fetch = jest.fn(async () => new Response(JSON.stringify({ status: true, data: { authorization_url: "https://paystack.test/pay" } }))) as unknown as typeof fetch;
});

describe("what's connected", () => {
  it("WhatsApp is a linked number; Jumia is a working connection", async () => {
    expect(await missingConnections("seller")).toEqual(["whatsapp"]);
    linked();
    expect(await missingConnections("seller")).toEqual([]);
    jumiaKind = "needs_new_token";
    expect(await missingConnections("seller")).toEqual(["jumia"]);
  });
});

describe("buying credits", () => {
  it("needs both, for every pack, and says which to connect", async () => {
    jumiaKind = "needs_credentials";
    const block = await purchaseBlock("seller");
    expect(block?.missing).toEqual(["whatsapp", "jumia"]);
    expect(block?.message).toContain("To buy credits, first link your WhatsApp number and connect your Jumia account in Settings.");

    for (const tier of ["starter", "standard", "pro", "business"]) {
      const res = await checkout(new Request("https://x.test", { method: "POST", body: JSON.stringify({ tier }) }));
      expect(res.status).toBe(403);
      expect((await res.json()).connect).toEqual(["whatsapp", "jumia"]);
    }
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("with both connected, checkout starts", async () => {
    linked();
    expect(await purchaseBlock("seller")).toBeNull();
    const res = await checkout(new Request("https://x.test", { method: "POST", body: JSON.stringify({ tier: "starter" }) }));
    expect(res.status).toBe(200);
    expect(global.fetch).toHaveBeenCalled();
  });

  it("the modal asks first (eligibility)", async () => {
    expect(await (await eligibility()).json()).toMatchObject({ ok: false, missing: ["whatsapp"] });
    linked();
    expect(await (await eligibility()).json()).toEqual({ ok: true, missing: [] });
  });

  it("admins and everyone while billing is off aren't stopped", async () => {
    expect(await purchaseBlock("admin")).toBeNull();
    billingOn = false;
    expect(await purchaseBlock("seller")).toBeNull();
  });
});

describe("extension autofill", () => {
  it("free credits (no pack) and Starter autofill with nothing connected", async () => {
    jumiaKind = "needs_credentials";
    expect(await autofillBlock("seller")).toBeNull();
    bought(80);
    expect(await autofillBlock("seller")).toBeNull();
  });

  it("Standard, Pro and Business need both, and are told which one to connect", async () => {
    for (const credits of [210, 440, 940]) {
      bought(credits);
      const block = await autofillBlock("seller");
      expect(block?.missing).toEqual(["whatsapp"]);
      expect(block?.message).toMatch(/^Autofill on your (Standard|Pro|Business) pack needs your WhatsApp linked and your Jumia account connected\. Open PandaWorld Settings to link your WhatsApp number, then try again\.$/);
    }
    linked();
    expect(await autofillBlock("seller")).toBeNull();
    jumiaKind = "needs_reconnect";
    expect((await autofillBlock("seller"))?.missing).toEqual(["jumia"]);
  });
});
