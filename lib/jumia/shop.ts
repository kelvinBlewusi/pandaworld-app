/**
 * A seller's live Jumia shop through the Vendor API (owner, 2026-10-07: "let's
 * implement the rest from the API and wire it conversationally"). Spec:
 * https://vendorcenter.jumia.com/api-docs/openapi.yaml.
 *
 *   - Their whole catalog (GET /catalog/products) and stock (GET
 *     /catalog/stock), kept in jumia_products so the WhatsApp assistant can
 *     find "the fridge" among everything they sell, not only what PandaWorld
 *     listed. Synced when it's needed and older than CATALOG_STALE_MS.
 *   - Changing a live product: stock (POST /feeds/products/stock), price and
 *     sale price (POST /feeds/products/price), on/off (POST
 *     /feeds/products/status). Each is a feed Jumia applies on its own time;
 *     the worker reads the result (lib/whatsapp/shop-notices.ts).
 *   - Payout statements (GET /payout-statement).
 *   - Orders after packing: one order by its number, orders since a date, and
 *     orders whose status changed (GET /orders with updatedAfter).
 *
 * Nothing here talks to WhatsApp (that's lib/whatsapp/shop.ts), and nothing is
 * country-specific: the seller's token decides the shop, their country picks
 * the business client ("jumia-gh") and the currency.
 */

import { createServerClient } from "@/lib/supabase/server";
import { call, getItemsOfOrders, listOrders, type JumiaCall, type JumiaOrder, type JumiaOrderItem } from "@/lib/jumia/orders";

/** One product (a variation, in Jumia's words): what the feeds take, by its sid and SKU. */
export interface ShopProduct {
  sid:          string;
  setSid:       string | null;
  sellerSku:    string;
  name:         string;
  variation:    string | null;
  brand:        string | null;
  categoryCode: string | null;
  createdAt:    string | null;
  /** On the seller's own country: ACTIVE, INACTIVE or DELETED. */
  status:       string | null;
  visible:      boolean | null;
  qcStatus:     string | null;
  qcReason:     string | null;
  price:        number | null;
  salePrice:    number | null;
  saleStart:    string | null;
  saleEnd:      string | null;
  currency:     string | null;
  imageUrl:     string | null;
  stock:        number | null;
}

/** The catalog is read again when it's older than this and the assistant needs it. */
export const CATALOG_STALE_MS = 3 * 3_600_000;
/** At most this many pages of 100 (products, and stock) per sync. */
const MAX_PAGES = 30;
/** Jumia allows 4 requests a second per shop; a sync stays under it. */
const PACE_MS = 260;

export const businessClientCode = (country: string) => `jumia-${country.toLowerCase()}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * GET /catalog/products as one row per variation, with the seller's own
 * country's status, QC and price (its business client), else the global price.
 */
export function productsFromCatalog(raw: unknown, country: string | null): ShopProduct[] {
  const products = ((raw as { products?: unknown[] } | null)?.products ?? []) as Record<string, unknown>[];
  const code = country ? businessClientCode(country) : null;
  const out: ShopProduct[] = [];
  for (const p of products) {
    const images = (p.images ?? []) as Record<string, unknown>[];
    const image = images.find((i) => i.primary) ?? images[0];
    const brand = (p.brand ?? {}) as Record<string, unknown>;
    const category = (p.category ?? {}) as Record<string, unknown>;
    for (const v of (p.variations ?? []) as Record<string, unknown>[]) {
      const sid = str(v.id);
      const sku = str(v.sellerSku);
      if (!sid || !sku) continue;
      const clients = (v.businessClients ?? []) as Record<string, unknown>[];
      const client = clients.find((c) => code && String(c.code ?? "").toLowerCase() === code) ?? clients[0] ?? {};
      const qc = (client.qc ?? {}) as Record<string, unknown>;
      const cp = (client.price ?? {}) as Record<string, unknown>;
      const gp = (v.globalPrice ?? {}) as Record<string, unknown>;
      const sale = ((cp.salePrice ?? gp.salePrice) ?? {}) as Record<string, unknown>;
      const clientValue = num(cp.localValue) ?? num(cp.value);
      out.push({
        sid,
        setSid:       str(p.id),
        sellerSku:    sku,
        name:         str(p.name) ?? sku,
        variation:    str(v.variation),
        brand:        str(brand.name),
        categoryCode: category.code != null ? String(category.code) : null,
        createdAt:    str(p.createdAt),
        status:       str(client.status)?.toUpperCase() ?? null,
        visible:      typeof client.visible === "boolean" ? client.visible : null,
        qcStatus:     str(qc.status)?.toUpperCase() ?? null,
        qcReason:     str(qc.rejectionReason),
        price:        clientValue ?? num(gp.value),
        salePrice:    num(sale.localValue) ?? num(sale.value),
        saleStart:    str(sale.startAt),
        saleEnd:      str(sale.endAt),
        currency:     clientValue != null ? (str(cp.localCurrency) ?? str(cp.currency)) : str(gp.currency),
        imageUrl:     str(image?.url) ?? str(image?.originalUrl),
        stock:        null,
      });
    }
  }
  return out;
}

/** Every product of the shop, page by page. */
export async function fetchCatalog(accessToken: string, country: string | null, deadline: number): Promise<JumiaCall<ShopProduct[]>> {
  const all: ShopProduct[] = [];
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES && Date.now() < deadline; page++) {
    const r = await call<{ products?: unknown[]; nextToken?: string | null; isLastPage?: boolean }>(
      accessToken, "GET", "/catalog/products", { query: { size: 100, token } },
    );
    if (!r.ok) return r;
    all.push(...productsFromCatalog(r.data, country));
    if (r.data.isLastPage || !r.data.nextToken) break;
    token = r.data.nextToken;
    await sleep(PACE_MS);
  }
  return { ok: true, data: all };
}

/** Stock per product sid: every product's (no sids), or just these. */
export async function fetchStock(accessToken: string, deadline: number, sids?: string[]): Promise<JumiaCall<Map<string, number>>> {
  const stock = new Map<string, number>();
  if (sids) {
    for (let i = 0; i < sids.length && Date.now() < deadline; i += 50) {
      const r = await call<{ products?: { id: string; globalStock: number }[] }>(
        accessToken, "GET", "/catalog/stock", { query: { productSids: sids.slice(i, i + 50), size: 100 } },
      );
      if (!r.ok) return r;
      for (const p of r.data.products ?? []) if (num(p.globalStock) != null) stock.set(p.id, Number(p.globalStock));
      if (i + 50 < sids.length) await sleep(PACE_MS);
    }
    return { ok: true, data: stock };
  }
  let token: string | undefined;
  for (let page = 0; page < MAX_PAGES && Date.now() < deadline; page++) {
    const r = await call<{ products?: { id: string; globalStock: number }[]; nextToken?: string | null; isLastPage?: boolean }>(
      accessToken, "GET", "/catalog/stock", { query: { size: 100, token } },
    );
    if (!r.ok) return r;
    for (const p of r.data.products ?? []) if (num(p.globalStock) != null) stock.set(p.id, Number(p.globalStock));
    if (r.data.isLastPage || !r.data.nextToken) break;
    token = r.data.nextToken;
    await sleep(PACE_MS);
  }
  return { ok: true, data: stock };
}

/**
 * These products read fresh from Jumia (GET /catalog/products by SKU, and
 * their stock), for "is the drone live?": the local copy can be hours old.
 * A product Jumia doesn't return keeps its local copy.
 */
export async function refreshProducts(
  accessToken: string, country: string | null, products: ShopProduct[], deadline = Date.now() + 8_000,
): Promise<ShopProduct[]> {
  const fresh = new Map<string, ShopProduct>();
  for (const sku of Array.from(new Set(products.map((p) => p.sellerSku))).slice(0, 5)) {
    if (Date.now() > deadline) break;
    const r = await call<unknown>(accessToken, "GET", "/catalog/products", { query: { sellerSku: sku, size: 10 } });
    if (r.ok) for (const p of productsFromCatalog(r.data, country)) fresh.set(p.sid, p);
    await sleep(PACE_MS);
  }
  const stock = await fetchStock(accessToken, deadline, products.map((p) => p.sid));
  return products.map((old) => {
    const p = { ...(fresh.get(old.sid) ?? old) };
    p.stock = stock.ok ? stock.data.get(p.sid) ?? old.stock : old.stock;
    return p;
  });
}

/** Write these products back to the local copy, as read just now. */
export async function saveProducts(userId: string, products: ShopProduct[]): Promise<void> {
  if (products.length === 0) return;
  const at = new Date().toISOString();
  await createServerClient().from("jumia_products").upsert(products.map((p) => toRow(userId, p, at)), { onConflict: "user_id,product_sid" });
}

// ─── The local copy ──────────────────────────────────────────────────────────

const toRow = (userId: string, p: ShopProduct, at: string) => ({
  user_id: userId, product_sid: p.sid, set_sid: p.setSid, seller_sku: p.sellerSku, name: p.name, variation: p.variation,
  brand: p.brand, category_code: p.categoryCode, product_created_at: p.createdAt, status: p.status, visible: p.visible,
  qc_status: p.qcStatus, qc_reason: p.qcReason, price: p.price, sale_price: p.salePrice, sale_start: p.saleStart,
  sale_end: p.saleEnd, currency: p.currency, image_url: p.imageUrl, stock: p.stock, synced_at: at,
});

export const fromRow = (r: Record<string, unknown>): ShopProduct => ({
  sid: String(r.product_sid), setSid: str(r.set_sid), sellerSku: String(r.seller_sku), name: String(r.name ?? r.seller_sku),
  variation: str(r.variation), brand: str(r.brand), categoryCode: str(r.category_code), createdAt: str(r.product_created_at),
  status: str(r.status), visible: typeof r.visible === "boolean" ? r.visible : null, qcStatus: str(r.qc_status),
  qcReason: str(r.qc_reason), price: num(r.price), salePrice: num(r.sale_price), saleStart: str(r.sale_start),
  saleEnd: str(r.sale_end), currency: str(r.currency), imageUrl: str(r.image_url), stock: num(r.stock),
});

/** When the catalog was last read, or null if never. */
export async function lastCatalogSync(userId: string): Promise<number | null> {
  const { data } = await createServerClient().from("jumia_catalog_syncs").select("synced_at").eq("user_id", userId).maybeSingle();
  const at = (data as { synced_at?: string } | null)?.synced_at;
  return at ? new Date(at).getTime() : null;
}

/**
 * Read the shop's catalog and stock from Jumia into jumia_products, unless it
 * was read within CATALOG_STALE_MS (or `force`). Products no longer in the
 * shop are removed. A failed read keeps the last copy.
 */
export async function syncCatalog(
  userId: string,
  creds: { accessToken: string; country: string | null },
  opts: { force?: boolean; budgetMs?: number } = {},
): Promise<{ ok: true; count: number; fresh: boolean } | { ok: false; message: string }> {
  const db = createServerClient();
  const last = await lastCatalogSync(userId);
  if (!opts.force && last != null && Date.now() - last < CATALOG_STALE_MS) {
    const { count } = await db.from("jumia_products").select("product_sid", { count: "exact", head: true }).eq("user_id", userId);
    return { ok: true, count: count ?? 0, fresh: false };
  }

  const deadline = Date.now() + (opts.budgetMs ?? 20_000);
  const catalog = await fetchCatalog(creds.accessToken, creds.country, deadline);
  if (!catalog.ok) return { ok: false, message: catalog.message };
  const stock = await fetchStock(creds.accessToken, deadline);
  if (stock.ok) for (const p of catalog.data) p.stock = stock.data.get(p.sid) ?? null;

  const at = new Date().toISOString();
  const rows = catalog.data.map((p) => toRow(userId, p, at));
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from("jumia_products").upsert(rows.slice(i, i + 500), { onConflict: "user_id,product_sid" });
    if (error) return { ok: false, message: error.message };
  }
  // Gone from the shop: only once the whole catalog was read.
  if (Date.now() < deadline) await db.from("jumia_products").delete().eq("user_id", userId).lt("synced_at", at);
  await db.from("jumia_catalog_syncs").upsert({ user_id: userId, synced_at: at, products: rows.length }, { onConflict: "user_id" });
  return { ok: true, count: rows.length, fresh: true };
}

export async function shopProducts(userId: string): Promise<ShopProduct[]> {
  const { data } = await createServerClient().from("jumia_products").select("*").eq("user_id", userId);
  return ((data ?? []) as Record<string, unknown>[]).map(fromRow);
}

// ─── Finding "the fridge" ────────────────────────────────────────────────────

const STOP = new Set([
  "the", "my", "a", "an", "of", "for", "to", "on", "in", "and", "with", "set", "change", "make", "put", "stock", "price",
  "quantity", "qty", "product", "products", "item", "items", "jumia", "please", "it", "its", "one", "turn", "off", "sale",
]);
const NON_WORD = new RegExp("[^\\p{L}\\p{N}]+", "gu");
const words = (s: string) =>
  s.toLowerCase().replace(NON_WORD, " ").split(" ").filter((w) => w && !STOP.has(w)).map((w) => (w.length > 3 ? w.replace(/s$/, "") : w));

/**
 * The products a seller means by `query` ("the Hisense fridge", "black
 * t-shirt", a SKU): an exact SKU first, else those whose name, variation, brand
 * and SKU hold the most of its words. Deleted products are left out. Best
 * first; empty when nothing fits.
 */
export function findProducts(products: ShopProduct[], query: string, max = 10): ShopProduct[] {
  const live = products.filter((p) => p.status !== "DELETED");
  const q = query.trim().toLowerCase();
  const bySku = live.filter((p) => p.sellerSku.toLowerCase() === q);
  if (bySku.length > 0) return bySku;

  const want = words(query);
  if (want.length === 0) return [];
  const scored = live.map((p) => {
    const have = words(`${p.name} ${p.variation ?? ""} ${p.brand ?? ""} ${p.sellerSku}`);
    const hits = want.filter((w) => have.some((h) => h === w || (w.length >= 4 && (h.startsWith(w) || w.startsWith(h) && h.length >= 4))));
    return { p, score: hits.length / want.length };
  });
  const best = Math.max(0, ...scored.map((s) => s.score));
  if (best < 0.5) return [];
  return scored.filter((s) => s.score >= best - 1e-9).map((s) => s.p).slice(0, max);
}

// ─── Changing a live product ─────────────────────────────────────────────────

export type LiveChange =
  | { kind: "stock"; stock: number }
  | { kind: "price"; price: number }
  /** A sale with its dates (YYYY-MM-DD), or null to end the sale. */
  | { kind: "sale"; sale: { price: number; start: string; end: string } | null }
  | { kind: "status"; active: boolean };

const FEED_PATH: Record<LiveChange["kind"], string> = {
  stock: "/feeds/products/stock", price: "/feeds/products/price", sale: "/feeds/products/price", status: "/feeds/products/status",
};

/** One product's item in a feed, or why it can't be. */
function feedItem(product: ShopProduct, change: LiveChange, ctx: { country: string; currency: string }): Record<string, unknown> | string {
  const base = { sellerSku: product.sellerSku, id: product.sid };
  const client = businessClientCode(ctx.country);
  const currency = product.currency ?? ctx.currency;
  switch (change.kind) {
    case "stock":
      return { ...base, stock: change.stock };
    case "price":
    case "sale": {
      const value = change.kind === "price" ? change.price : product.price;
      if (value == null) return "I don't know this product's price on Jumia yet, so I can't set a sale on it";
      const salePrice = change.kind === "price"
        ? undefined
        : change.sale
          ? { value: change.sale.price, startAt: `${change.sale.start} 00:00`, endAt: `${change.sale.end} 23:59` }
          : { value: null, startAt: null, endAt: null };
      const price = { currency, value, ...(salePrice !== undefined ? { salePrice } : {}) };
      return {
        ...base,
        ...(product.categoryCode ? { category: Number(product.categoryCode) } : {}),
        price,
        businessClients: [{ businessClientCode: client, price }],
      };
    }
    case "status":
      return {
        ...base,
        createdAt: (product.createdAt ?? new Date().toISOString()).slice(0, 10),
        businessClients: [{ businessClientCode: client, status: change.active ? "ACTIVE" : "INACTIVE" }],
      };
  }
}

/**
 * The same change to one or more products, as one feed Jumia will apply, by
 * its id ("set the freezer, the blender and the chainsaw to 10": one tap,
 * one feed; owner's second test, 2026-10-07).
 */
export async function sendLiveChanges(
  accessToken: string,
  products: ShopProduct[],
  change: LiveChange,
  ctx: { country: string; currency: string },
): Promise<JumiaCall<{ feedId: string }>> {
  const items: Record<string, unknown>[] = [];
  for (const p of products) {
    const item = feedItem(p, change, ctx);
    if (typeof item === "string") return { ok: false, status: 0, message: products.length > 1 ? `${p.name}: ${item}` : item };
    items.push(item);
  }
  if (items.length === 0) return { ok: false, status: 0, message: "no product to change" };
  const r = await call<{ feedId?: string }>(accessToken, "POST", FEED_PATH[change.kind], { body: { products: items } });
  if (!r.ok) return r;
  const feedId = str(r.data?.feedId);
  return feedId ? { ok: true, data: { feedId } } : { ok: false, status: 200, message: "Jumia didn't give a feed id back" };
}

/** One product's change, as a feed. */
export function sendLiveChange(
  accessToken: string,
  product: ShopProduct,
  change: LiveChange,
  ctx: { country: string; currency: string },
): Promise<JumiaCall<{ feedId: string }>> {
  return sendLiveChanges(accessToken, [product], change, ctx);
}

/**
 * Per product of a finished feed (GET /feeds/{id}'s feedItems), by SKU and
 * by sid: whether Jumia refused it, and why.
 */
export function feedItemResults(raw: unknown): Map<string, { failed: boolean; error: string | null }> {
  const out = new Map<string, { failed: boolean; error: string | null }>();
  const items = ((raw as { feedItems?: unknown[] } | null)?.feedItems ?? []) as Record<string, unknown>[];
  for (const i of items) {
    const failed = String(i.status ?? "").toUpperCase() === "FAILED";
    const nested = ((i.errors as Record<string, unknown> | undefined)?.globalMessages as unknown[] | undefined) ?? [];
    const first = [i.errorMessage, ...nested].map((e) => (typeof e === "string" ? e : e && typeof e === "object" ? String((e as Record<string, unknown>).message ?? "") : "")).find(Boolean);
    const result = { failed, error: first ? first.slice(0, 200) : null };
    for (const key of [str(i.sellerSKU) ?? str(i.sellerSku), str(i.productSid)]) if (key) out.set(key, result);
  }
  return out;
}

/** The jumia_products columns a change sets, once Jumia has it. */
export function localUpdate(change: LiveChange): Record<string, unknown> {
  switch (change.kind) {
    case "stock":  return { stock: change.stock };
    case "price":  return { price: change.price };
    case "sale":   return change.sale
      ? { sale_price: change.sale.price, sale_start: change.sale.start, sale_end: change.sale.end }
      : { sale_price: null, sale_start: null, sale_end: null };
    case "status": return { status: change.active ? "ACTIVE" : "INACTIVE" };
  }
}

// ─── Payouts ─────────────────────────────────────────────────────────────────

export interface PayoutStatement {
  number:         string;
  createdAt:      string | null;
  updatedAt:      string | null;
  paid:           boolean;
  reference:      string | null;
  amount:         number;
  currency:       string;
  openingBalance: number | null;
  itemRevenue:    number | null;
  feesTotal:      number | null;
  refunds:        number | null;
  closingBalance: number | null;
}

export function statementsFrom(raw: unknown): PayoutStatement[] {
  const list = ((raw as { statements?: unknown[] } | null)?.statements ?? []) as Record<string, unknown>[];
  return list
    .map((s) => {
      const payout = (s.payout ?? {}) as Record<string, unknown>;
      return {
        number:         String(s.statementNumber ?? ""),
        createdAt:      str(s.createdAt),
        updatedAt:      str(s.updatedAt),
        paid:           s.paid === true,
        reference:      str(s.paymentReference),
        amount:         num(payout.amount) ?? 0,
        currency:       str(payout.currency) ?? "",
        openingBalance: num(s.openingBalance),
        itemRevenue:    num(s.itemRevenue),
        feesTotal:      num(s.feesTotal),
        refunds:        num(s.refunds),
        closingBalance: num(s.closingBalance),
      };
    })
    .filter((s) => s.number)
    .sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
}

/** The shop's payout statements, newest first, in its own currency. Jumia's default is the last 90 days. */
export async function fetchPayouts(accessToken: string, opts: { createdAfter?: string; paid?: boolean } = {}): Promise<JumiaCall<PayoutStatement[]>> {
  const r = await call<unknown>(accessToken, "GET", "/payout-statement", {
    query: { currency: "LOCAL", size: 50, createdAfter: opts.createdAfter, paid: opts.paid == null ? undefined : String(opts.paid) },
  });
  return r.ok ? { ok: true, data: statementsFrom(r.data) } : r;
}

// ─── Orders after packing ────────────────────────────────────────────────────

const day = (offsetDays: number, from = Date.now()) => new Date(from + offsetDays * 86_400_000).toISOString().slice(0, 10);
/** Jumia's "yyyy-MM-dd HH:mm:ss", in UTC. */
export const jumiaTime = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");

/** Orders created since `since` and before `before` (YYYY-MM-DD; default tomorrow), newest first, up to `pages` of 100. */
export async function ordersCreatedSince(accessToken: string, since: string, pages = 10, before?: string): Promise<JumiaCall<JumiaOrder[]>> {
  const orders: JumiaOrder[] = [];
  let token: string | undefined;
  for (let page = 0; page < pages; page++) {
    const r = await listOrders(accessToken, { createdAfter: since, createdBefore: before ?? day(1), size: 100, sort: "DESC", token });
    if (!r.ok) return r;
    orders.push(...(r.data.orders ?? []));
    if (r.data.isLastPage || !r.data.nextToken) break;
    token = r.data.nextToken;
    await sleep(PACE_MS);
  }
  return { ok: true, data: orders };
}

/** An order by the number the seller knows (#355926919), from the last 89 days, with its items. */
export async function findOrderByNumber(
  accessToken: string, number: string,
): Promise<JumiaCall<{ order: JumiaOrder; items: JumiaOrderItem[] } | null>> {
  const want = number.replace(/\D/g, "");
  let token: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await listOrders(accessToken, { createdAfter: day(-89), createdBefore: day(1), size: 100, sort: "DESC", token });
    if (!r.ok) return r;
    const order = (r.data.orders ?? []).find((o) => String(o.number).replace(/\D/g, "") === want);
    if (order) {
      const items = await getItemsOfOrders(accessToken, [order.id]);
      return { ok: true, data: { order, items: items.ok ? items.data.get(order.id)?.items ?? [] : [] } };
    }
    if (r.data.isLastPage || !r.data.nextToken) break;
    token = r.data.nextToken;
    await sleep(PACE_MS);
  }
  return { ok: true, data: null };
}

/** Orders whose items moved to `status` (one or several) between two days (YYYY-MM-DD, the second exclusive), newest first. */
export async function ordersWithStatus(accessToken: string, status: string | string[], after: string, before: string): Promise<JumiaCall<JumiaOrder[]>> {
  const orders: JumiaOrder[] = [];
  let token: string | undefined;
  for (let page = 0; page < 5; page++) {
    const r = await listOrders(accessToken, { status: Array.isArray(status) ? status : [status], updatedAfter: after, updatedBefore: before, size: 100, sort: "DESC", token });
    if (!r.ok) return r;
    orders.push(...(r.data.orders ?? []));
    if (r.data.isLastPage || !r.data.nextToken) break;
    token = r.data.nextToken;
    await sleep(PACE_MS);
  }
  return { ok: true, data: orders };
}

/** The statuses whose change the seller hears about (lib/whatsapp/shop-notices.ts). */
export const NOTICE_STATUSES = ["DELIVERED", "RETURNED", "FAILED", "CANCELED"] as const;

/** Orders whose items moved to one of NOTICE_STATUSES since `sinceMs`. */
export async function ordersChangedSince(accessToken: string, sinceMs: number): Promise<JumiaCall<JumiaOrder[]>> {
  const orders: JumiaOrder[] = [];
  let token: string | undefined;
  for (let page = 0; page < 5; page++) {
    const r = await listOrders(accessToken, {
      status: [...NOTICE_STATUSES], updatedAfter: jumiaTime(sinceMs), updatedBefore: jumiaTime(Date.now() + 60_000),
      size: 100, sort: "ASC", token,
    });
    if (!r.ok) return r;
    orders.push(...(r.data.orders ?? []));
    if (r.data.isLastPage || !r.data.nextToken) break;
    token = r.data.nextToken;
    await sleep(PACE_MS);
  }
  return { ok: true, data: orders };
}

/** An order's status as one word: "Delivered", "DELIVERED" → DELIVERED; "Multiple Status" stays itself. */
export const orderStatusWord = (o: { status?: string }) => String(o.status ?? "").trim().toUpperCase().replace(/[^A-Z]+/g, "_");

export interface SalesSummary {
  orders:   number;
  value:    number;
  currency: string;
  byStatus: Record<string, number>;
}

/** Orders by status and their total value. */
export function summarizeOrders(orders: JumiaOrder[]): SalesSummary {
  const byStatus: Record<string, number> = {};
  let value = 0;
  let currency = "";
  for (const o of orders) {
    const s = orderStatusWord(o) || "UNKNOWN";
    byStatus[s] = (byStatus[s] ?? 0) + 1;
    if (orderStatusWord(o) !== "CANCELED") value += Number(o.totalAmountLocal?.value) || 0;
    currency ||= o.totalAmountLocal?.currency ?? "";
  }
  return { orders: orders.length, value, currency, byStatus };
}

// ─── What the seller was told ────────────────────────────────────────────────

/** Remember that the seller was told (or did) this, so it's said once. True if it's new. `at`: when, for a time marker. */
export async function markNoticed(userId: string, kind: string, ref: string, at?: Date): Promise<boolean> {
  try {
    const { data } = await createServerClient()
      .from("shop_notices")
      .upsert({ user_id: userId, kind, ref, ...(at ? { created_at: at.toISOString() } : {}) }, { onConflict: "user_id,kind,ref", ignoreDuplicates: true })
      .select("ref");
    return (data ?? []).length > 0;
  } catch {
    return false;
  }
}

/** Of these refs, the ones already noticed. */
export async function noticed(userId: string, kind: string, refs: string[]): Promise<Set<string>> {
  if (refs.length === 0) return new Set();
  const { data } = await createServerClient().from("shop_notices").select("ref").eq("user_id", userId).eq("kind", kind).in("ref", refs);
  return new Set(((data ?? []) as { ref: string }[]).map((r) => r.ref));
}

