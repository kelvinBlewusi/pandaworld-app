/**
 * POST /api/extension/polish-images — the extension's Polish images: rough
 * photos in, four generated product shots out. On every plan, free credits
 * included, since 2026-10-07 (Pro and Business from 2026-10-02, admins only
 * before), at POLISH_CREDIT_COST per image that came back. GET /api/extension/account tells
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
import { POLISH_CREDIT_COST } from "@/lib/billing/credit-packs";

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

// Owner, 2026-10-07: "all packs can use Chrome image generation tool even free packs".
it("works on every plan: Starter, and free credits with no pack", async () => {
  authUser = "user_starter";
  expect((await call({ images: [{ dataUrl: PHOTO }] })).status).toBe(200);
  buyer("user_free", 0, 12);
  db.tables.extension_credit_transactions = db.tables.extension_credit_transactions.filter((t) => t.user_id !== "user_free");
  authUser = "user_free";
  const res = await call({ images: [{ dataUrl: PHOTO }] });
  expect(res.status).toBe(200);
  expect((await res.json()).creditsRemaining).toBe(12 - 3 * POLISH_CREDIT_COST);
});

it("charges for the images that came back, and says what's left", async () => {
  const res = await call({ images: [{ dataUrl: PHOTO }] });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.creditsRemaining).toBe(50 - 3 * 2); // 2 an image; lifestyle failed: free
  expect(db.tables.extension_credit_transactions).toContainEqual(expect.objectContaining({
    user_id: "user_pro", type: "deduction", amount: -3 * POLISH_CREDIT_COST, description: "Polished 3 product images in the extension",
  }));
});

it("a Pro buyer at 0 credits is told to buy credits, not to upgrade (owner's rule, 2026-10-06)", async () => {
  db.tables.extension_credits.find((r) => r.user_id === "user_pro")!.balance = 0;
  const res = await call({ images: [{ dataUrl: PHOTO }] });
  expect(res.status).toBe(402);
  expect(await res.json()).toEqual({ error: "You're out of credits. Buy credits from your dashboard to keep using Polish.", buyCredits: true });
  expect(generated).toHaveLength(0);
});

it("whatever the pack bought last: Pro then Starter still polishes", async () => {
  db.tables.extension_credit_transactions.push({ user_id: "user_pro", type: "purchase", amount: 100, reference: "later", created_at: "2099-01-01T00:00:00Z" });
  expect((await call({ images: [{ dataUrl: PHOTO }] })).status).toBe(200);
});

it("stops before generating when the balance can't cover four images", async () => {
  db.tables.extension_credits.find((r) => r.user_id === "user_pro")!.balance = 4 * POLISH_CREDIT_COST - 1;
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
    expect(body.features).toEqual({ imagePolish: true, imagePolishAllowed: true, feeCalculator: true });
    expect(body.country).toEqual({ code: "NG", name: "Nigeria" });
  });

  // Owner's request, 2026-10-06: every seller sees the Polish button; the
  // ones without the pack are told to upgrade on tap. Panels 0.2.53 to
  // 0.2.55 show it from imagePolish, so that is true for everyone.
  it("lets a Starter buyer polish (every plan), but no calculator (Pro)", async () => {
    expect((await accountFor("user_starter")).features).toEqual({ imagePolish: true, imagePolishAllowed: true, feeCalculator: false });
  });

  it("turns a Pro buyer's tools off at 0 credits and says why, so 0.2.58 offers Buy credits", async () => {
    db.tables.extension_credits.find((r) => r.user_id === "user_pro")!.balance = 0;
    const body = await accountFor("user_pro");
    expect(body.features).toEqual({ imagePolish: true, imagePolishAllowed: false, feeCalculator: false });
    expect(body.outOfCredits).toBe(true);
    expect((await accountFor("user_starter")).outOfCredits).toBe(false);
  });

  it("uses where the seller is when they haven't connected Jumia", async () => {
    buyer("user_new", 940, 900);
    expect((await accountFor("user_new")).country).toEqual({ code: "KE", name: "Kenya" });
  });
});

// Owner's gift, 2026-10-06: a seller on free credits polishes free until
// he has spent the 8 credits he had left (lib/billing/feature-grants.ts).
describe("a free grant", () => {
  const GRANTED_AT = "2026-10-06T12:00:00.000Z";
  beforeEach(() => {
    db.tables.extension_credits.push({ user_id: "user_gift", balance: 8 });
    db.tables.feature_grants = [{
      id: "grant-1", user_id: "user_gift", feature: "image_polish_extension",
      free_use: true, credit_allowance: 8, ends_at: null, uses: 0, created_at: GRANTED_AT,
    }];
    authUser = "user_gift";
  });

  it("polishes without the pack, without the credits, and charges nothing", async () => {
    const res = await call({ images: [{ dataUrl: PHOTO }] });
    expect(res.status).toBe(200);
    expect((await res.json()).creditsRemaining).toBe(8);
    expect(db.tables.extension_credit_transactions.some((t) => t.user_id === "user_gift")).toBe(false);
    expect(db.tables.feature_grants[0].uses).toBe(1);
    expect((await accountFor("user_gift")).features.imagePolishAllowed).toBe(true);
  });

  it("ends once the credits it covered are spent: polish is then charged like anyone's", async () => {
    db.tables.extension_credit_transactions.push(
      ...Array.from({ length: 8 }, () => ({ user_id: "user_gift", type: "deduction", amount: -1, created_at: "2026-10-07T10:00:00.000Z" })),
      { user_id: "user_gift", type: "purchase", amount: 100, created_at: "2026-10-07T11:00:00.000Z" },
    );
    const res = await call({ images: [{ dataUrl: PHOTO }] });
    expect(res.status).toBe(200);
    expect((await res.json()).creditsRemaining).toBe(8 - 3 * POLISH_CREDIT_COST);
  });

  it("doesn't count what was spent before it began", async () => {
    db.tables.extension_credit_transactions.push(
      { user_id: "user_gift", type: "deduction", amount: -1, created_at: "2026-10-05T23:46:09.000Z" },
      ...Array.from({ length: 7 }, () => ({ user_id: "user_gift", type: "deduction", amount: -1, created_at: "2026-10-07T10:00:00.000Z" })),
    );
    expect((await call({ images: [{ dataUrl: PHOTO }] })).status).toBe(200);
  });

  it("counts a refund back", async () => {
    db.tables.extension_credit_transactions.push(
      ...Array.from({ length: 8 }, () => ({ user_id: "user_gift", type: "deduction", amount: -1, created_at: "2026-10-07T10:00:00.000Z" })),
      { user_id: "user_gift", type: "refund", amount: 2, created_at: "2026-10-07T10:30:00.000Z" },
    );
    expect((await call({ images: [{ dataUrl: PHOTO }] })).status).toBe(200);
  });

  it("charges as usual when the grant isn't a free one", async () => {
    db.tables.feature_grants[0].free_use = false;
    db.tables.extension_credits.find((r) => r.user_id === "user_gift")!.balance = 50;
    const body = await (await call({ images: [{ dataUrl: PHOTO }] })).json();
    expect(body.creditsRemaining).toBe(50 - 3 * POLISH_CREDIT_COST);
  });
});
