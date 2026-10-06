/**
 * Messages from PandaWorld to one seller (lib/notices.ts, table user_notices):
 * returned to the extension panel with the account, hidden by its "Got it"
 * (POST /api/extension/notices/dismiss, API key) and by the dashboard bell's
 * x (POST /api/extension/notifications/dismiss, Clerk), and only ever for the
 * seller they were written for. First used 2026-10-06 to tell a seller that
 * Polish images was unlocked for them.
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));

let authUser: string | null = "user_a";
jest.mock("@/lib/security/extension-keys", () => ({
  authenticateExtensionKey: async () => (authUser ? { ok: true, userId: authUser } : { ok: false, error: "Invalid API key" }),
}));
jest.mock("@/lib/jumia/unlistable-categories", () => ({ sellerCountry: async () => null }));
jest.mock("next/headers", () => ({ headers: () => new Headers({ "x-vercel-ip-country": "GH" }) }));

let clerkUser: string | null = "user_a";
// Set when the session is Clerk's "Impersonate user": someone signed in AS the seller.
let clerkActor: { sub: string } | undefined;
jest.mock("@clerk/nextjs/server", () => ({ auth: async () => ({ userId: clerkUser, actor: clerkActor }) }));

import { GET as account } from "@/app/api/extension/account/route";
import { POST as panelDismiss } from "@/app/api/extension/notices/dismiss/route";
import { POST as bellDismiss } from "@/app/api/extension/notifications/dismiss/route";
import { _resetBillingModeCache } from "@/lib/billing/mode";
import { getKeyCardNotice } from "@/lib/notices";

const TITLE = "🎉 Congrats on using the PandaWorldAI Chrome extension!";
const BODY = "You've unlocked *Polish images* on your extension panel.\n\nTo try it: tap 🪄 *Polish images* in the panel.";

const getAccount = async () =>
  (await account(new Request("https://pandaworldai.site/api/extension/account", { headers: { authorization: "Bearer pw_live_x" } }))).json();
const post = (handler: (r: Request) => Promise<Response>, body: unknown) =>
  handler(new Request("https://pandaworldai.site/x", {
    method: "POST", headers: { authorization: "Bearer pw_live_x", "content-type": "application/json" }, body: JSON.stringify(body),
  }));

beforeEach(() => {
  db = new FakeDb();
  db.tables.app_settings = [{ key: "billing_enabled", value: true }];
  db.tables.extension_credits = [{ user_id: "user_a", balance: 8 }, { user_id: "user_b", balance: 8 }];
  db.tables.extension_credit_transactions = [];
  db.tables.user_notices = [
    { id: "n1", user_id: "user_a", title: TITLE, body: BODY, created_at: "2026-10-06T12:00:00Z", dismissed_at: null },
    { id: "n2", user_id: "user_b", title: "For b", body: "Only b.", created_at: "2026-10-06T12:00:00Z", dismissed_at: null },
  ];
  _resetBillingModeCache();
  authUser = "user_a";
  clerkUser = "user_a";
  clerkActor = undefined;
});

it("sends the seller's own notices with the account, and nobody else's", async () => {
  const { notices } = await getAccount();
  // (The real select returns just these four columns; the fake returns the whole row.)
  expect(notices).toHaveLength(1);
  expect(notices[0]).toMatchObject({ id: "n1", title: TITLE, body: BODY, created_at: "2026-10-06T12:00:00Z" });
});

it("sends none once dismissed", async () => {
  db.tables.user_notices[0].dismissed_at = "2026-10-06T13:00:00Z";
  expect((await getAccount()).notices).toEqual([]);
});

describe("the panel's Got it", () => {
  it("dismisses the notice for good", async () => {
    const res = await post(panelDismiss, { id: "n1" });
    expect(res.status).toBe(200);
    expect(db.tables.user_notices[0].dismissed_at).not.toBeNull();
    expect((await getAccount()).notices).toEqual([]);
  });

  it("can't dismiss another seller's notice", async () => {
    await post(panelDismiss, { id: "n2" });
    expect(db.tables.user_notices[1].dismissed_at).toBeNull();
  });

  it("needs a valid key and an id", async () => {
    authUser = null;
    expect((await post(panelDismiss, { id: "n1" })).status).toBe(401);
    authUser = "user_a";
    expect((await post(panelDismiss, {})).status).toBe(400);
    expect(db.tables.user_notices[0].dismissed_at).toBeNull();
  });
});

describe("the dashboard bell's x", () => {
  it("dismisses a notice when told it is one", async () => {
    expect((await post(bellDismiss, { id: "n1", kind: "notice" })).status).toBe(200);
    expect(db.tables.user_notices[0].dismissed_at).not.toBeNull();
  });

  it("can't dismiss another seller's notice", async () => {
    await post(bellDismiss, { id: "n2", kind: "notice" });
    expect(db.tables.user_notices[1].dismissed_at).toBeNull();
  });

  it("still dismisses a credit ledger entry by default", async () => {
    db.tables.extension_credit_transactions = [{ id: "t1", user_id: "user_a", type: "grant", amount: 20, dismissed_at: null }];
    await post(bellDismiss, { id: "t1" });
    expect(db.tables.extension_credit_transactions[0].dismissed_at).not.toBeNull();
    expect(db.tables.user_notices[0].dismissed_at).toBeNull();
  });
});

describe("a notice shown at the dashboard's Copy key button", () => {
  beforeEach(() => { db.tables.user_notices[0].show_on_key_card = true; });

  it("is the seller's own open notice marked for the key card, and nobody else's", async () => {
    expect((await getKeyCardNotice("user_a"))?.id).toBe("n1");
    db.tables.user_notices[1].show_on_key_card = true;
    expect((await getKeyCardNotice("user_a"))?.id).toBe("n1");
    expect((await getKeyCardNotice("user_b"))?.id).toBe("n2");
  });

  it("is nothing for a notice that isn't marked for it, or once dismissed", async () => {
    db.tables.user_notices[0].show_on_key_card = false;
    expect(await getKeyCardNotice("user_a")).toBeNull();
    db.tables.user_notices[0].show_on_key_card = true;
    db.tables.user_notices[0].dismissed_at = "2026-10-06T13:00:00Z";
    expect(await getKeyCardNotice("user_a")).toBeNull();
  });

  // Live 2026-10-06: the owner, signed in as the seller to look, dismissed it
  // before the seller had seen it.
  it("isn't used up by the owner signed in as the seller", async () => {
    clerkActor = { sub: "user_owner" };
    const res = await post(bellDismiss, { id: "n1", kind: "notice" });
    expect(res.status).toBe(200);
    expect(db.tables.user_notices[0].dismissed_at).toBeNull();
    expect((await getKeyCardNotice("user_a"))?.id).toBe("n1");
  });

  it("is dismissed when the seller copies their key", async () => {
    await post(bellDismiss, { id: "n1", kind: "notice" });
    expect(db.tables.user_notices[0].dismissed_at).not.toBeNull();
    expect(await getKeyCardNotice("user_a")).toBeNull();
    expect((await getAccount()).notices).toEqual([]);
  });
});
