/**
 * The newest extension version on the Chrome Web Store, told to the panel with
 * the account (lib/extension/latest-version.ts, app_settings key
 * extension_latest_version), so a panel older than it can offer an update.
 * Set by hand once a version is published; unset or malformed means no banner.
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
jest.mock("@/lib/security/extension-keys", () => ({
  authenticateExtensionKey: async () => ({ ok: true, userId: "user_a" }),
}));
jest.mock("@/lib/jumia/unlistable-categories", () => ({ sellerCountry: async () => null }));
jest.mock("next/headers", () => ({ headers: () => new Headers({ "x-vercel-ip-country": "GH" }) }));

import { GET as account } from "@/app/api/extension/account/route";
import { latestExtensionVersion } from "@/lib/extension/latest-version";
import { _resetBillingModeCache } from "@/lib/billing/mode";

const setting = (value: unknown) => { db.tables.app_settings.push({ key: "extension_latest_version", value }); };
const getAccount = async () =>
  (await account(new Request("https://pandaworldai.site/api/extension/account", { headers: { authorization: "Bearer pw_live_x" } }))).json();

beforeEach(() => {
  db = new FakeDb();
  db.tables.app_settings = [{ key: "billing_enabled", value: true }];
  db.tables.extension_credits = [{ user_id: "user_a", balance: 8 }];
  db.tables.extension_credit_transactions = [];
  _resetBillingModeCache();
});

it("is null until a version has been set", async () => {
  expect(await latestExtensionVersion()).toBeNull();
  expect((await getAccount()).latestExtensionVersion).toBeNull();
});

it("tells the panel the version that was set", async () => {
  setting("0.2.58");
  expect((await getAccount()).latestExtensionVersion).toBe("0.2.58");
});

it.each([["not a version"], [""], ["0"], ["1.2.3.4.5"], [258], [null], [{ v: "0.2.58" }]])(
  "ignores a malformed value (%p), so a typo never shows sellers a banner",
  async (value) => {
    setting(value);
    expect(await latestExtensionVersion()).toBeNull();
  },
);
