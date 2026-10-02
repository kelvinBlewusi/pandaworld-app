/**
 * POST /api/extension/polish-images — the extension's Polish images: rough
 * photos in, four generated product shots out. Comes with the Pro and
 * Business packs and costs IMAGE_CREDIT_COST per image that came back
 * (from 2026-10-02; admins only before). GET /api/extension/account tells
 * the panel which of these tools to show, and the calculator's country.
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));

let authUser: string | null = "user_pro";
jest.mock("@/lib/security/extension-keys", () => ({
  authenticateExtensionKey: async () => (authUser ? { ok: true, userId: authUser } : { ok: false, error: "Invalid API key" }),
}));

const generated: { sources: number; context?: string }[] = [];
jest.mock("@/lib/gemini-image", () => ({
  PRODUCT_SHOTS: [{ id: "main" }, { id: "angle" }, { id: "lifestyle" }, { id: "detail" }],
  isGeminiImageEnabled: () => true,
  generateProductShots: async (sources: unknown[], _userId: string, opts: { productContext?: string }) => {
    generated.push({ sources: sources.length, context: opts.productContext });
    return [
      { id: "main", label: "Main image", url: "https://cdn.test/main.png" },
      { id: "angle", label: "Angle", url: "https://cdn.test/angle.png" },
      { id: "lifestyle", label: "Lifestyle", error: "timed out" },
      { id: "detail", label: "Detail", url: "https://cdn.test/detail.png" },
    ];
  },
}));

// The seller's own Jumia country, and where the request came from.
const sellerCountries: Record<string, string> = { user_pro: "NG" };
jest.mock("@/lib/jumia/unlistable-categories", () => ({ sellerCountry: async (id: string) => sellerCountries[id] ?? null }));
jest.mock("next/headers", () => ({ headers: () => new Headers({ "x-vercel-ip-country": "KE" }) }));

import { POST } from "@/app/api/extension/polish-images/route";
import { GET as account } from "@/app/api/extension/account/route";
import { _resetBillingModeCache } from "@/lib/billing/mode";
import { IMAGE_CREDIT_COST } from "@/lib/billing/credit-packs";

const PHOTO = `data:image/jpeg;base64,${Buffer.alloc(2048, 1).toString("base64")}`;
const call = (body: unknown) => POST(new Request("https://pandaworldai.site/api/extension/polish-images", {
  method: "POST", headers: { authorization: "Bearer pw_live_x", "content-type": "application/json" }, body: JSON.stringify(body),
}));
const accountFor = async (userId: string) => {
  authUser = userId;
  const res = await account(new Request("https://pandaworldai.site/api/extension/account", { headers: { authorization: "Bearer pw_live_x" } }));
  return res.json();
};

/** A seller who bought `pack` credits once and now holds `balance`. */
function buyer(userId: string, packCredits: number, balance: number) {
  db.tables.extension_credits.push({ user_id: userId, balance });
  db.tables.extension_credit_transactions.push({ user_id: userId, type: "purchase", amount: packCredits, reference: `pwcr_${userId}` });
}

beforeEach(() => {
  db = new FakeDb();
  db.tables.app_settings = [{ key: "billing_enabled", value: true }];
  db.tables.extension_credits = [];
  db.tables.extension_credit_transactions = [];
  _resetBillingModeCache();
  process.env.ADMIN_USER_IDS = "user_admin";
  authUser = "user_pro";
  generated.length = 0;
  buyer("user_pro", 440, 50);
  buyer("user_starter", 100, 50);
});

it("needs a valid API key", async () => {
  authUser = null;
  expect((await call({ images: [{ dataUrl: PHOTO }] })).status).toBe(401);
});

it("comes with the Pro and Business packs, not Starter", async () => {
  authUser = "user_starter";
  const res = await call({ images: [{ dataUrl: PHOTO }] });
  expect(res.status).toBe(403);
  expect((await res.json()).error).toBe("Image polish comes with the Pro and Business credit packs.");
  expect(generated).toHaveLength(0);
});

it("charges for the images that came back, and says what's left", async () => {
  const res = await call({ images: [{ dataUrl: PHOTO }] });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.creditsRemaining).toBe(50 - 3 * IMAGE_CREDIT_COST); // lifestyle failed: free
  expect(db.tables.extension_credit_transactions).toContainEqual(expect.objectContaining({
    user_id: "user_pro", type: "deduction", amount: -3 * IMAGE_CREDIT_COST, description: "Polished 3 product images in the extension",
  }));
});

it("stops before generating when the balance can't cover four images", async () => {
  db.tables.extension_credits.find((r) => r.user_id === "user_pro")!.balance = 4 * IMAGE_CREDIT_COST - 1;
  const res = await call({ images: [{ dataUrl: PHOTO }] });
  expect(res.status).toBe(402);
  expect(generated).toHaveLength(0);
});

it("costs an admin nothing", async () => {
  authUser = "user_admin";
  const body = await (await call({ images: [{ dataUrl: PHOTO }] })).json();
  expect(body.unlimitedCredits).toBe(true);
  expect(db.tables.extension_credit_transactions.some((t) => t.user_id === "user_admin")).toBe(false);
});

it("needs at least one photo", async () => {
  expect((await call({ images: [] })).status).toBe(400);
});

it("returns the four shots from up to three photos, with the seller's notes as context", async () => {
  const res = await call({ images: [{ dataUrl: PHOTO }, { dataUrl: PHOTO }, { dataUrl: PHOTO }, { dataUrl: PHOTO }], notes: "Palmolive shower cream 250ml" });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.images.map((i: { id: string }) => i.id)).toEqual(["main", "angle", "lifestyle", "detail"]);
  expect(generated).toEqual([{ sources: 3, context: "Palmolive shower cream 250ml" }]);
});

describe("the panel's account", () => {
  it("shows a Pro buyer both tools and their own country's calculator", async () => {
    const body = await accountFor("user_pro");
    expect(body.features).toEqual({ imagePolish: true, feeCalculator: true });
    expect(body.country).toEqual({ code: "NG", name: "Nigeria" });
  });

  it("shows a Starter buyer neither", async () => {
    expect((await accountFor("user_starter")).features).toEqual({ imagePolish: false, feeCalculator: false });
  });

  it("uses where the seller is when they haven't connected Jumia", async () => {
    buyer("user_new", 940, 900);
    expect((await accountFor("user_new")).country).toEqual({ code: "KE", name: "Kenya" });
  });
});
