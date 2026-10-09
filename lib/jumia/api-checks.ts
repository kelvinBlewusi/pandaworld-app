/**
 * Every read request the chat relies on, run once a day against the owner's
 * own shop (owner, 2026-10-09: "start with the list and daily checks"). A
 * request Jumia changes or breaks shows up here the same morning, not when a
 * seller asks. Read-only: nothing here changes anything on Jumia.
 *
 * Which capability each check proves is in lib/jumia/capabilities.ts
 * (`checks`); the results are kept in jumia_api_checks and shown on
 * /admin/jumia-api. Run by app/api/worker/jumia-api-checks (pg_cron, daily),
 * or from that page.
 */

import { createServerClient } from "@/lib/supabase/server";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import { sendTextIfConfigured } from "@/lib/whatsapp/client";
import { appUrl } from "@/lib/whatsapp/app-url";
import { call, getItemsOfOrders, listOrders, type JumiaCall, type JumiaOrderItem } from "@/lib/jumia/orders";
import { fetchCatalogPage, fetchLinkedShops, fetchPayouts, fetchProductSet, fetchStock, jumiaTime, type ShopProduct } from "@/lib/jumia/shop";
import { getCategoryByCode } from "@/lib/jumia/categories";
import type { CheckId } from "@/lib/jumia/capabilities";

export interface ApiCheckResult {
  check:   CheckId;
  ok:      boolean;
  /** Nothing to check it with today (no order, no pending item, no recent feed). */
  skipped: boolean;
  ms:      number;
  detail:  string;
}

/** What each check reads, for the admin page. */
export const CHECK_NAMES: Record<CheckId, string> = {
  shops: "GET /shops", linked_shops: "GET /shops-of-master-shop", brands: "GET /catalog/brands", categories: "GET /catalog/categories",
  attribute_set: "GET /catalog/attribute-sets/{id}", products: "GET /catalog/products", product_set: "GET /catalog/products?sellerSku",
  stock: "GET /catalog/stock", feed: "GET /feeds/{id}", orders: "GET /orders", order_items: "GET /orders/items",
  shipment_providers: "GET /orders/shipment-providers", payouts: "GET /payout-statement",
};

const PACE_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400_000;

/**
 * Run every check in order (each needs what the one before found: a
 * product, an order), paced under Jumia's 4 requests a second. Never throws.
 */
export async function runApiChecks(
  accessToken: string, country: string, opts: { feedId?: string | null; now?: number; paceMs?: number } = {},
): Promise<ApiCheckResult[]> {
  const now = opts.now ?? Date.now();
  const pace = opts.paceMs ?? PACE_MS;
  const results: ApiCheckResult[] = [];
  const run = async <T>(check: CheckId, fn: () => Promise<JumiaCall<T> | null>, detail: (data: T) => string): Promise<T | null> => {
    const t0 = Date.now();
    try {
      const r = await fn();
      const ms = Date.now() - t0;
      if (r === null) results.push({ check, ok: true, skipped: true, ms: 0, detail: "nothing to check it with today" });
      else if (r.ok) results.push({ check, ok: true, skipped: false, ms, detail: detail(r.data).slice(0, 200) });
      else results.push({ check, ok: false, skipped: false, ms, detail: `${r.status || "error"}: ${r.message}`.slice(0, 300) });
      if (pace > 0) await sleep(pace);
      return r && r.ok ? r.data : null;
    } catch (e) {
      results.push({ check, ok: false, skipped: false, ms: Date.now() - t0, detail: (e as Error).message.slice(0, 300) });
      return null;
    }
  };
  const count = (v: unknown) => (Array.isArray(v) ? v.length : Array.isArray((v as { products?: unknown[] } | null)?.products) ? (v as { products: unknown[] }).products.length : 0);

  await run("shops", () => call<unknown[]>(accessToken, "GET", "/shops"), (d) => `${count(d)} shop(s)`);
  await run("linked_shops", () => fetchLinkedShops(accessToken), (d) => `${d.length} shop(s) under the account`);
  await run("brands", () => call<unknown>(accessToken, "GET", "/catalog/brands", { query: { page: 1 } }), (d) => `${count((d as { brands?: unknown[] })?.brands ?? d)} brand(s) on page 1`);
  await run("categories", () => call<unknown>(accessToken, "GET", "/catalog/categories", { query: { page: 1, size: 5 } }), (d) => `${count((d as { categories?: unknown[] })?.categories ?? d)} categor(ies) on page 1`);

  const products = await run<ShopProduct[]>("products", () => fetchCatalogPage(accessToken, country, { latestFirst: true, size: 5 }), (d) => `${d.length} newest product(s), e.g. ${d[0]?.sellerSku ?? "none"}`);
  const first = products?.[0] ?? null;
  await run("product_set", () => (first ? fetchProductSet(accessToken, first.sellerSku) : Promise.resolve(null)), (d) => (d ? `${d.variations.length} variation(s), ${d.attributes.length} detail(s)` : "no product set"));
  await run("stock", () => (products && products.length > 0 ? fetchStock(accessToken, Date.now() + 20_000, products.map((p) => p.sid)) : Promise.resolve(null)), (d) => `${d.size} stock figure(s)`);
  const category = first?.categoryCode ? await getCategoryByCode(Number(first.categoryCode)).catch(() => null) : null;
  await run("attribute_set", () => (category?.attribute_set_sid ? call<unknown>(accessToken, "GET", `/catalog/attribute-sets/${category.attribute_set_sid}`) : Promise.resolve(null)), () => `${category?.name ?? "its category"}'s details`);
  await run("feed", () => (opts.feedId ? call<unknown>(accessToken, "GET", `/feeds/${encodeURIComponent(opts.feedId)}`) : Promise.resolve(null)), (d) => `feed ${String((d as { status?: string })?.status ?? "read")}`);

  const orders = await run("orders", () => listOrders(accessToken, { createdAfter: jumiaTime(now - 30 * DAY), createdBefore: jumiaTime(now), size: 5, sort: "DESC" }), (d) => `${d.orders?.length ?? 0} order(s) in 30 days`);
  const firstOrders = (orders?.orders ?? []).slice(0, 3);
  const items = await run("order_items", () => (firstOrders.length > 0 ? getItemsOfOrders(accessToken, firstOrders.map((o) => o.id)) : Promise.resolve(null)), (d) => `${Array.from(d.values()).reduce((n, x) => n + x.items.length, 0)} item(s)`);
  const pending = items ? Array.from(items.values()).flatMap((x) => x.items).find((i: JumiaOrderItem) => String(i.status ?? "").toUpperCase() === "PENDING") : undefined;
  await run("shipment_providers", () => (pending ? call<unknown>(accessToken, "GET", "/orders/shipment-providers", { query: { orderItemId: [pending.id] } }) : Promise.resolve(null)), () => "providers read");
  await run("payouts", () => fetchPayouts(accessToken, { createdAfter: new Date(now - 30 * DAY).toISOString().slice(0, 10) }), (d) => `${d.length} statement(s) in 30 days`);
  return results;
}

/** The account the checks run as: app_settings `api_check_user`, else the first admin with Jumia connected. */
export async function checkAccount(): Promise<string | null> {
  const db = createServerClient();
  const { data: set } = await db.from("app_settings").select("value").eq("key", "api_check_user").maybeSingle();
  if (typeof set?.value === "string" && set.value) return set.value;
  const admins = (process.env.ADMIN_USER_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (admins.length === 0) return null;
  const { data } = await db.from("jumia_connections").select("user_id").in("user_id", admins).eq("status", "active").limit(1);
  return ((data ?? [])[0] as { user_id: string } | undefined)?.user_id ?? null;
}

/** The newest feed the account sent, to read back. */
export async function latestFeedId(userId: string): Promise<string | null> {
  const { data } = await createServerClient().from("jumia_product_changes").select("feed_id")
    .eq("user_id", userId).not("feed_id", "is", null).order("updated_at", { ascending: false }).limit(1);
  return ((data ?? [])[0] as { feed_id: string | null } | undefined)?.feed_id ?? null;
}

/** Keep one run's results. Never throws. */
export async function saveChecks(userId: string, results: ApiCheckResult[]): Promise<string> {
  const runId = crypto.randomUUID();
  try {
    await createServerClient().from("jumia_api_checks").insert(results.map((r) => ({
      run_id: runId, user_id: userId, check_id: r.check, ok: r.ok, skipped: r.skipped, ms: r.ms, detail: r.detail,
    })));
  } catch (e) {
    console.warn(`[jumia api checks] couldn't save: ${(e as Error).message}`);
  }
  return runId;
}

/** The latest run's results, newest first, for the admin page. */
export async function latestChecks(): Promise<{ runAt: string | null; results: (ApiCheckResult & { runAt: string })[] }> {
  const { data } = await createServerClient().from("jumia_api_checks").select("*").order("run_at", { ascending: false }).limit(40);
  const rows = (data ?? []) as { run_id: string; run_at: string; check_id: CheckId; ok: boolean; skipped: boolean; ms: number; detail: string }[];
  const runId = rows[0]?.run_id;
  const latest = rows.filter((r) => r.run_id === runId);
  return {
    runAt: rows[0]?.run_at ?? null,
    results: latest.map((r) => ({ check: r.check_id, ok: r.ok, skipped: r.skipped, ms: r.ms, detail: r.detail, runAt: r.run_at })),
  };
}

/**
 * One daily run: the checks on the check account, kept, and any failure
 * logged (Sentry) and sent to that account's WhatsApp.
 */
export async function runAndReport(): Promise<{ userId: string | null; results: ApiCheckResult[] }> {
  const userId = await checkAccount();
  if (!userId) return { userId: null, results: [] };
  let results: ApiCheckResult[];
  try {
    const { accessToken, country } = await getValidJumiaCredentials(userId);
    results = await runApiChecks(accessToken, country, { feedId: await latestFeedId(userId) });
  } catch (e) {
    results = [{ check: "shops", ok: false, skipped: false, ms: 0, detail: `couldn't get a Jumia token: ${(e as Error).message}`.slice(0, 300) }];
  }
  await saveChecks(userId, results);
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`[jumia api checks] ${failed.length} of ${results.length} failed: ${failed.map((f) => `${CHECK_NAMES[f.check]} (${f.detail})`).join("; ")}`);
    const { data } = await createServerClient().from("whatsapp_connections").select("phone_number").eq("user_id", userId).limit(1);
    const phone = ((data ?? [])[0] as { phone_number: string } | undefined)?.phone_number;
    if (phone) {
      await sendTextIfConfigured(phone, [
        `⚠️ Daily Jumia API check: ${failed.length} of ${results.length} failed.`,
        ...failed.map((f) => `• ${CHECK_NAMES[f.check]}: ${f.detail.slice(0, 140)}`),
        "", `Details: ${appUrl()}/admin/jumia-api`,
      ].join("\n")).catch(() => undefined);
    }
  }
  return { userId, results };
}
