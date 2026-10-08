/**
 * Shop research (owner, 2026-10-08: "let it be able to make a number of
 * different API calls to the vendor shop and get info and data and organize
 * them to fit the sellers request"). For what no single answer in
 * lib/whatsapp/shop.ts covers: "the full list of the last 10 products
 * uploaded on my shop", "my newest products with their price and stock",
 * "orders this week and what was in them, and my last payout".
 *
 *   - The assistant names what to read (lib/whatsapp/assistant.ts, the
 *     "research" action): up to MAX_NEEDS sources, all read-only. Products
 *     (newest or oldest first, by price or stock, on or off, rejected,
 *     pending, out of stock, low, on sale, matching words), orders with their
 *     items, sales by product, a sales summary, payout statements, and what
 *     they listed with PandaWorld.
 *   - Each is read here (lib/jumia/shop.ts, orders.ts; "newest" straight from
 *     Jumia with latestFirst, so a product added a minute ago is there) and
 *     made into plain lines (readNeed). Nothing is changed and nothing is
 *     charged: reading the shop is free on every pack (shop_whatsapp,
 *     paused at 0 credits).
 *   - The AI then writes the answer to what was asked, organised the way it
 *     was asked, from those lines only (composeAnswer). Every amount, count
 *     and date in its answer must be in the data or the question
 *     (numbersBacked); if not, or when the AI can't be reached, the lines go
 *     out as they are.
 */

import { createServerClient } from "@/lib/supabase/server";
import { callGeminiBackend } from "@/lib/ai/gemini-client";
import { withAiUsageContext } from "@/lib/ai/usage";
import { sendTextIfConfigured } from "@/lib/whatsapp/client";
import { getItemsOfOrders, type JumiaOrderItem } from "@/lib/jumia/orders";
import {
  fetchCatalogPage, fetchPayouts, fetchStock, findProducts, orderStatusWord, ordersCreatedSince, ordersWithStatus, saveProducts, shopProducts, summarizeOrders,
  syncCatalog, type ShopProduct,
} from "@/lib/jumia/shop";
import { formatAmount } from "@/lib/whatsapp/orders";
import { LOW_STOCK, periodEnd, periodStart, sendLong, shopContext, shorten, statusName, type Ctx, type Period } from "@/lib/whatsapp/shop";
import { orderItems, salesByProduct } from "@/lib/whatsapp/shop-insights";

/** The most sources one question reads. */
export const MAX_NEEDS = 4;
/** The most rows one source gives. */
export const MAX_ROWS = 30;
const MODEL = "gemini-2.5-flash";
const DAY = 86_400_000;

export type ProductSort = "newest" | "oldest" | "price_high" | "price_low" | "stock_low" | "stock_high" | "name";
export type ProductFilter = "all" | "active" | "inactive" | "rejected" | "pending" | "out_of_stock" | "low_stock" | "on_sale";

export type ResearchNeed =
  | { source: "products"; sort: ProductSort; filter: ProductFilter; words: string | null; limit: number; since: Period | null }
  | { source: "orders"; period: Period; status: string | null; limit: number }
  | { source: "product_sales"; period: Period }
  | { source: "sales_summary"; period: Period }
  | { source: "payouts" }
  | { source: "pandaworld_listings"; period: Period };

const SORTS = new Set<ProductSort>(["newest", "oldest", "price_high", "price_low", "stock_low", "stock_high", "name"]);
const FILTERS = new Set<ProductFilter>(["all", "active", "inactive", "rejected", "pending", "out_of_stock", "low_stock", "on_sale"]);
const PERIODS = new Set<Period>(["today", "yesterday", "week", "month", "quarter"]);
const period = (v: unknown, fallback: Period): Period =>
  v === "all" || v === "ever" || v === "90days" ? "quarter" : PERIODS.has(v as Period) ? (v as Period) : fallback;
const rows = (v: unknown, fallback: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? Math.min(n, MAX_ROWS) : fallback;
};

/**
 * The AI's "needs", checked: known sources only, at most MAX_NEEDS, each
 * once. `backed` says whether product words are the seller's (else they're
 * dropped, never searched); `asStatus` reads an order status. Pure.
 */
export function parseNeeds(
  raw: unknown,
  check: { backed: (words: string) => boolean; asStatus: (v: unknown) => string | null },
): ResearchNeed[] {
  const out: ResearchNeed[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    let need: ResearchNeed | null = null;
    switch (r.source) {
      case "products": case "catalog": {
        const words = typeof r.words === "string" && r.words.trim() && check.backed(r.words) ? r.words.trim().slice(0, 80) : null;
        need = {
          source: "products",
          sort: SORTS.has(r.sort as ProductSort) ? (r.sort as ProductSort) : "newest",
          filter: FILTERS.has(r.filter as ProductFilter) ? (r.filter as ProductFilter) : "all",
          words, limit: rows(r.limit, 10), since: r.since == null ? null : period(r.since, "month"),
        };
        break;
      }
      case "orders":
        need = { source: "orders", period: period(r.period, "week"), status: check.asStatus(r.status), limit: rows(r.limit, 15) };
        break;
      case "product_sales": case "sales_by_product":
        need = { source: "product_sales", period: period(r.period, "month") };
        break;
      case "sales_summary": case "sales":
        need = { source: "sales_summary", period: period(r.period, "week") };
        break;
      case "payouts":
        need = { source: "payouts" };
        break;
      case "pandaworld_listings": case "listings":
        need = { source: "pandaworld_listings", period: period(r.period, "month") };
        break;
    }
    if (!need) continue;
    const key = JSON.stringify(need);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(need);
    if (out.length >= MAX_NEEDS) break;
  }
  return out;
}

// ─── Products, one line each ─────────────────────────────────────────────────

/** A product as the seller thinks of it: its variations together. */
export interface ProductGroup {
  name: string; sku: string; variations: string[]; price: number | null; maxPrice: number | null; salePrice: number | null;
  stock: number | null; status: string | null; qc: string | null; qcReason: string | null; createdAt: string | null; currency: string | null;
}

const QC_ORDER = ["REJECTED", "PENDING", "NOT_READY_TO_QC", "APPROVED"];

/** Jumia's rows (one per variation) as products, in the order given; deleted ones left out. Pure. */
export function groupProducts(products: ShopProduct[], today: string): ProductGroup[] {
  const by = new Map<string, ShopProduct[]>();
  for (const p of products) {
    if (p.status === "DELETED") continue;
    const key = p.setSid ?? p.sid;
    by.set(key, [...(by.get(key) ?? []), p]);
  }
  return Array.from(by.values()).map((vs) => {
    const prices = vs.map((v) => v.price).filter((n): n is number => n != null);
    const stocks = vs.map((v) => v.stock).filter((n): n is number => n != null);
    const sale = vs.find((v) => v.salePrice != null && (!v.saleEnd || v.saleEnd.slice(0, 10) >= today) && (!v.saleStart || v.saleStart.slice(0, 10) <= today));
    return {
      name: vs[0].name,
      sku: vs[0].sellerSku,
      variations: vs.map((v) => v.variation).filter((v): v is string => !!v && v !== "..."),
      price: prices.length ? Math.min(...prices) : null,
      maxPrice: prices.length ? Math.max(...prices) : null,
      salePrice: sale?.salePrice ?? null,
      stock: stocks.length ? stocks.reduce((a, b) => a + b, 0) : null,
      status: vs.some((v) => v.status === "ACTIVE") ? "ACTIVE" : vs[0].status,
      qc: QC_ORDER.find((q) => vs.some((v) => v.qcStatus === q)) ?? vs[0].qcStatus,
      qcReason: vs.find((v) => v.qcStatus === "REJECTED")?.qcReason ?? null,
      createdAt: vs.map((v) => v.createdAt).filter((d): d is string => !!d).sort()[0] ?? null,
      currency: vs[0].currency,
    };
  });
}

const FILTER_TEST: Record<ProductFilter, (g: ProductGroup) => boolean> = {
  all:          () => true,
  active:       (g) => g.status === "ACTIVE",
  inactive:     (g) => g.status === "INACTIVE",
  rejected:     (g) => g.qc === "REJECTED",
  pending:      (g) => g.qc === "PENDING" || g.qc === "NOT_READY_TO_QC",
  out_of_stock: (g) => g.stock === 0,
  low_stock:    (g) => g.stock != null && g.stock > 0 && g.stock <= LOW_STOCK,
  on_sale:      (g) => g.salePrice != null,
};

const FILTER_WORDS: Record<ProductFilter, string> = {
  all: "", active: "on", inactive: "turned off", rejected: "rejected by Jumia's quality check", pending: "waiting for Jumia's check",
  out_of_stock: "out of stock", low_stock: `low on stock (${LOW_STOCK} or fewer)`, on_sale: "on sale",
};
const SORT_WORDS: Record<ProductSort, string> = {
  newest: "newest first", oldest: "oldest first", price_high: "highest price first", price_low: "lowest price first",
  stock_low: "least stock first", stock_high: "most stock first", name: "by name",
};

const last = (a: number | null, b: number | null, desc: boolean) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : desc ? b - a : a - b);

/** Products sorted as asked. Pure. */
export function sortGroups(groups: ProductGroup[], sort: ProductSort): ProductGroup[] {
  const time = (g: ProductGroup) => (g.createdAt ? toDate(g.createdAt)?.getTime() ?? null : null);
  const out = [...groups];
  switch (sort) {
    case "newest":     return out.sort((a, b) => last(time(a), time(b), true));
    case "oldest":     return out.sort((a, b) => last(time(a), time(b), false));
    case "price_high": return out.sort((a, b) => last(a.maxPrice, b.maxPrice, true));
    case "price_low":  return out.sort((a, b) => last(a.price, b.price, false));
    case "stock_low":  return out.sort((a, b) => last(a.stock, b.stock, false));
    case "stock_high": return out.sort((a, b) => last(a.stock, b.stock, true));
    case "name":       return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}

/** "2026-10-08T09:00:00Z", "2026-10-08 09:00:00" (Jumia's, UTC) as a date. */
function toDate(iso: string): Date | null {
  const d = new Date(/[TZ+]/.test(iso.slice(10)) ? iso : `${iso.replace(" ", "T")}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "8 Oct", or "8 Oct 2025" for another year, in the seller's timezone. */
export function dayText(iso: string | null | undefined, timeZone: string, now = new Date()): string {
  const d = iso ? toDate(iso) : null;
  if (!d) return "";
  const year = (x: Date) => new Intl.DateTimeFormat("en-GB", { year: "numeric", timeZone }).format(x);
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", ...(year(d) !== year(now) ? { year: "numeric" } : {}), timeZone }).format(d);
}

const QC_TEXT: Record<string, string> = { APPROVED: "approved", PENDING: "waiting for Jumia's check", NOT_READY_TO_QC: "waiting for Jumia's check", REJECTED: "rejected" };

/** One product as a line. Pure. */
export function productLine(g: ProductGroup, money: (n: number, cur?: string | null) => string, timeZone: string, now = new Date()): string {
  const vars = g.variations.length > 1 ? ` (${g.variations.length} variations: ${g.variations.slice(0, 6).join(", ")}${g.variations.length > 6 ? ", …" : ""})`
    : g.variations.length === 1 ? ` (${g.variations[0]})` : "";
  const price = g.price == null ? "no price" : g.maxPrice != null && g.maxPrice !== g.price ? `${money(g.price, g.currency)} to ${money(g.maxPrice, g.currency)}` : money(g.price, g.currency);
  const stock = g.stock == null ? "stock unknown" : g.stock === 0 ? "out of stock" : `${g.stock} in stock`;
  const state = [g.status === "ACTIVE" ? "on" : g.status === "INACTIVE" ? "off" : null, g.qc ? QC_TEXT[g.qc] ?? g.qc.toLowerCase() : null]
    .filter(Boolean).join(", ") + (g.qc === "REJECTED" && g.qcReason ? `: ${shorten(g.qcReason, 70)}` : "");
  const added = dayText(g.createdAt, timeZone, now);
  return [
    `• ${shorten(g.name, 70)}${vars}`,
    `${price}${g.salePrice != null ? ` (on sale at ${money(g.salePrice, g.currency)})` : ""}`,
    stock,
    state,
    added ? `added ${added}` : "",
    `SKU ${g.sku}`,
  ].filter(Boolean).join(" · ");
}

// ─── Reading each source ─────────────────────────────────────────────────────

/** What one source gave: a heading and its lines, the data the answer is written from. */
export interface Block { title: string; lines: string[]; failed?: boolean }

const PERIOD_WORDS: Record<Period, string> = {
  today: "today", yesterday: "yesterday", week: "in the last 7 days", month: "in the last 30 days", quarter: "in the last 90 days",
};

const failed = (title: string, why: string): Block => ({ title, lines: [`Couldn't read this from Jumia just now (${shorten(why, 80)}).`], failed: true });

async function readProducts(ctx: Ctx, need: Extract<ResearchNeed, { source: "products" }>, deadline: number): Promise<Block> {
  const tz = ctx.jc?.timeZone ?? "UTC";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  const money = (n: number, cur?: string | null) => formatAmount(n, cur || ctx.currency, ctx.jc);
  const since = need.since ? periodStart(need.since, tz) : null;
  const what = [FILTER_WORDS[need.filter], need.words ? `matching "${need.words}"` : "", since ? `added ${PERIOD_WORDS[need.since!]}` : ""].filter(Boolean).join(", ");

  // Newest or oldest, straight from Jumia in its own order: one call, fresh.
  const live = (need.sort === "newest" || need.sort === "oldest") && !need.words
    && (["all", "active", "inactive", "rejected", "pending"] as ProductFilter[]).includes(need.filter);
  if (live) {
    const r = await fetchCatalogPage(ctx.token, ctx.country, {
      latestFirst: need.sort === "newest", size: need.limit,
      ...(need.filter === "active" ? { status: "ACTIVE" as const } : need.filter === "inactive" ? { status: "INACTIVE" as const } : {}),
      ...(need.filter === "rejected" ? { qcStatus: "REJECTED" } : need.filter === "pending" ? { qcStatus: "PENDING" } : {}),
      ...(since ? { createdFrom: since } : {}),
    });
    if (r.ok) {
      const stock = await fetchStock(ctx.token, deadline, r.data.map((p) => p.sid));
      if (stock.ok) for (const p of r.data) p.stock = stock.data.get(p.sid) ?? null;
      await saveProducts(ctx.userId, r.data).catch(() => undefined);
      const groups = groupProducts(r.data, today).slice(0, need.limit);
      return {
        title: groups.length === 0
          ? `Products${what ? ` ${what}` : ""}: none`
          : `The ${groups.length} ${need.sort} product${groups.length === 1 ? "" : "s"} in the Jumia shop${what ? ` (${what})` : ""}, ${SORT_WORDS[need.sort]}`,
        lines: groups.map((g) => productLine(g, money, tz)),
      };
    }
    // Not read: the local copy below.
  }

  const sync = await syncCatalog(ctx.userId, { accessToken: ctx.token, country: ctx.country }, { budgetMs: Math.max(3_000, deadline - Date.now()) });
  const all = await shopProducts(ctx.userId);
  if (all.length === 0) return sync.ok ? { title: "Products", lines: ["The Jumia shop has no products yet."] } : failed("Products", sync.message);
  const picked = need.words ? findProducts(all, need.words, 1000) : all;
  const groups = groupProducts(picked, today)
    .filter(FILTER_TEST[need.filter])
    .filter((g) => !since || (g.createdAt != null && (toDate(g.createdAt)?.toISOString().slice(0, 10) ?? "") >= since));
  const shown = sortGroups(groups, need.sort).slice(0, need.limit);
  return {
    title: `Products${what ? ` ${what}` : ""}, ${SORT_WORDS[need.sort]}: ${shown.length === groups.length ? `all ${groups.length}` : `${shown.length} of ${groups.length}`}` +
      ` (the shop has ${groupProducts(all, today).length} in all)`,
    lines: shown.length > 0 ? shown.map((g) => productLine(g, money, tz)) : ["None."],
  };
}

/** "Mini Blender ×2, Kettle". */
function itemsText(items: JumiaOrderItem[]): string {
  const count = new Map<string, number>();
  for (const i of items) {
    const name = shorten(i.product?.name ?? "Item", 40);
    count.set(name, (count.get(name) ?? 0) + 1);
  }
  const parts = Array.from(count.entries()).map(([n, c]) => (c > 1 ? `${n} ×${c}` : n));
  return parts.length > 3 ? `${parts.slice(0, 3).join(", ")} +${parts.length - 3} more` : parts.join(", ");
}

async function readOrders(ctx: Ctx, need: Extract<ResearchNeed, { source: "orders" }>, deadline: number): Promise<Block> {
  const tz = ctx.jc?.timeZone ?? "UTC";
  const from = periodStart(need.period, tz);
  const to = periodEnd(need.period, tz);
  const name = need.status ? statusName(need.status).toLowerCase() : "";
  const title = `Orders ${need.status ? `that became ${name} ` : ""}${PERIOD_WORDS[need.period]}`;
  const r = need.status ? await ordersWithStatus(ctx.token, need.status, from, to) : await ordersCreatedSince(ctx.token, from, 3, to);
  if (!r.ok) return failed(title, r.message);
  if (r.data.length === 0) return { title: `${title}: none`, lines: [] };
  const shown = r.data.slice(0, need.limit);
  const items = Date.now() < deadline ? await getItemsOfOrders(ctx.token, shown.map((o) => o.id)) : null;
  const s = summarizeOrders(r.data);
  const money = (n: number, cur?: string) => formatAmount(n, cur || ctx.currency, ctx.jc);
  return {
    title: `${title}: ${r.data.length}${r.data.length >= 300 && !need.status ? "+" : ""} (the newest ${shown.length} below)`,
    lines: [
      `By status: ${Object.entries(s.byStatus).map(([k, n]) => `${statusName(k)} ${n}`).join(", ")}`,
      ...(s.currency ? [`Value of those not cancelled: ${money(s.value, s.currency)}`] : []),
      ...shown.map((o) => {
        const its = items?.ok ? items.data.get(o.id)?.items ?? [] : [];
        return [
          `• #${o.number}`, dayText(o.createdAt, tz), statusName(orderStatusWord(o)),
          o.totalAmountLocal ? money(Number(o.totalAmountLocal.value) || 0, o.totalAmountLocal.currency) : "",
          its.length > 0 ? itemsText(its) : `${o.totalItems} item${o.totalItems === 1 ? "" : "s"}`,
        ].filter(Boolean).join(" · ");
      }),
    ],
  };
}

async function readProductSales(ctx: Ctx, need: Extract<ResearchNeed, { source: "product_sales" }>, deadline: number): Promise<Block> {
  const tz = ctx.jc?.timeZone ?? "UTC";
  const title = `Sales by product ${PERIOD_WORDS[need.period]}`;
  const r = await orderItems(ctx, periodStart(need.period, tz), periodEnd(need.period, tz), deadline);
  if (!r.ok) return failed(title, r.message);
  const sales = Array.from(salesByProduct(r.data.items).values()).sort((a, b) => b.sold - a.sold || b.revenue - a.revenue);
  if (sales.length === 0) return { title: `${title}: no orders`, lines: [] };
  const money = (n: number, cur?: string) => formatAmount(n, cur || ctx.currency, ctx.jc);
  const sold = sales.reduce((n, s) => n + s.sold, 0);
  const revenue = sales.reduce((n, s) => n + s.revenue, 0);
  return {
    title: `${title} (from ${r.data.orders}${r.data.partial ? " of the newest" : ""} orders)`,
    lines: [
      `Total: ${sold} sold · ${money(revenue, sales[0].currency)}`,
      ...sales.slice(0, 25).map((s) => [
        `• ${shorten(s.name, 60)}`, `${s.sold} sold`, money(s.revenue, s.currency),
        s.returned ? `${s.returned} returned` : "", s.failed ? `${s.failed} failed delivery` : "", s.cancelled ? `${s.cancelled} cancelled` : "",
        `SKU ${s.sku}`,
      ].filter(Boolean).join(" · ")),
      ...(sales.length > 25 ? [`+${sales.length - 25} more products`] : []),
    ],
  };
}

async function readSalesSummary(ctx: Ctx, need: Extract<ResearchNeed, { source: "sales_summary" }>): Promise<Block> {
  const tz = ctx.jc?.timeZone ?? "UTC";
  const title = `Orders and sales ${PERIOD_WORDS[need.period]}`;
  const r = await ordersCreatedSince(ctx.token, periodStart(need.period, tz), 10, periodEnd(need.period, tz));
  if (!r.ok) return failed(title, r.message);
  const s = summarizeOrders(r.data);
  if (s.orders === 0) return { title: `${title}: no orders`, lines: [] };
  return {
    title: `${title}: ${s.orders}${s.orders >= 1000 ? "+" : ""} orders`,
    lines: [
      `By status: ${Object.entries(s.byStatus).map(([k, n]) => `${statusName(k)} ${n}`).join(", ")}`,
      ...(s.currency ? [`Value of those not cancelled: ${formatAmount(s.value, s.currency, ctx.jc)}`] : []),
    ],
  };
}

async function readPayouts(ctx: Ctx): Promise<Block> {
  const tz = ctx.jc?.timeZone ?? "UTC";
  const r = await fetchPayouts(ctx.token, { createdAfter: new Date(Date.now() - 90 * DAY).toISOString().slice(0, 10) });
  if (!r.ok) return failed("Payout statements", r.message);
  if (r.data.length === 0) return { title: "Payout statements in the last 90 days: none", lines: [] };
  const money = (n: number | null, cur: string) => (n == null ? "?" : formatAmount(n, cur || ctx.currency, ctx.jc));
  return {
    title: `Payout statements in the last 90 days: ${r.data.length} (newest first)`,
    lines: r.data.slice(0, 10).map((s) => [
      `• Statement ${s.number}`, s.createdAt ? `from ${dayText(s.createdAt, tz)}` : "", money(s.amount, s.currency),
      s.paid ? `paid${s.updatedAt ? ` ${dayText(s.updatedAt, tz)}` : ""}` : "not paid yet",
      s.itemRevenue != null ? `sales ${money(s.itemRevenue, s.currency)}` : "", s.feesTotal != null ? `fees ${money(s.feesTotal, s.currency)}` : "",
      s.refunds ? `refunds ${money(s.refunds, s.currency)}` : "",
    ].filter(Boolean).join(" · ")),
  };
}

const LISTING_STATUS: Record<string, string> = {
  draft: "draft, not sent", awaiting_review: "draft, not sent", failed: "held", processing: "sent to Jumia",
  pending_approval: "waiting for Jumia", live: "live on Jumia",
};

async function readPandaworldListings(ctx: Ctx, need: Extract<ResearchNeed, { source: "pandaworld_listings" }>): Promise<Block> {
  const tz = ctx.jc?.timeZone ?? "UTC";
  const from = periodStart(need.period, tz);
  const { data } = await createServerClient().from("listings")
    .select("title, status, selling_price, created_at").eq("user_id", ctx.userId).gt("created_at", `${from}T00:00:00`)
    .order("created_at", { ascending: false }).limit(MAX_ROWS);
  const list = (data ?? []) as { title: string | null; status: string; selling_price: number | null; created_at: string }[];
  const title = `Products listed with PandaWorld ${PERIOD_WORDS[need.period]}`;
  if (list.length === 0) return { title: `${title}: none`, lines: [] };
  return {
    title: `${title}: ${list.length}${list.length >= MAX_ROWS ? "+" : ""} (newest first)`,
    lines: list.map((l) => [
      `• ${shorten(l.title ?? "(no name yet)", 70)}`, LISTING_STATUS[l.status] ?? l.status,
      l.selling_price != null ? formatAmount(l.selling_price, ctx.currency, ctx.jc) : "", dayText(l.created_at, tz),
    ].filter(Boolean).join(" · ")),
  };
}

/** One source read, as lines. Never throws: a failure is said in the block. */
export async function readNeed(ctx: Ctx, need: ResearchNeed, deadline: number): Promise<Block> {
  try {
    switch (need.source) {
      case "products":            return await readProducts(ctx, need, deadline);
      case "orders":              return await readOrders(ctx, need, deadline);
      case "product_sales":       return await readProductSales(ctx, need, deadline);
      case "sales_summary":       return await readSalesSummary(ctx, need);
      case "payouts":             return await readPayouts(ctx);
      case "pandaworld_listings": return await readPandaworldListings(ctx, need);
    }
  } catch (e) {
    return failed(need.source.replace(/_/g, " "), (e as Error).message);
  }
}

// ─── The answer ──────────────────────────────────────────────────────────────

export const blocksText = (blocks: Block[]) =>
  blocks.map((b) => [`*${b.title}*`, ...b.lines].join("\n")).join("\n\n");

/** Every number written in `text`: "1,500" is 1500, "GHS 150.00" is 150. */
function numbersIn(text: string): number[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => parseFloat(n.replace(/,(?=\d{3}\b)/g, "").replace(/,/g, ""))).filter(Number.isFinite);
}

/**
 * Whether every number in the AI's answer is in the data or the question:
 * an amount, count or date it worked out or made up isn't. Small counts
 * (up to 12: "3 of them", "top 5") and recent years are let through. Pure.
 */
export function numbersBacked(answer: string, data: string, request: string): boolean {
  const known = new Set([...numbersIn(data), ...numbersIn(request)]);
  const year = new Date().getUTCFullYear();
  // A date's year ("8 Oct 2026") is let through too.
  return numbersIn(answer).every((n) => known.has(n) || (Number.isInteger(n) && (n <= 12 || (n >= year - 10 && n <= year + 1))));
}

function composePrompt(request: string, data: string): string {
  return [
    "You are PandaWorld's assistant for a seller on Jumia (Africa's online marketplace).",
    `The seller asked: "${request.replace(/"/g, "'").slice(0, 600)}"`,
    "Below is data read from their Jumia shop just now (and what they listed with PandaWorld).",
    "Answer exactly what they asked, organised the way it fits their request: the list, order, grouping, filtering or comparison they want.",
    "Rules:",
    "- Use ONLY this data. Products, orders, amounts, counts and dates exactly as written below: never invent, estimate or add up a figure that isn't written here.",
    "- A full list they asked for: every item from the data, one per line, with the details that matter for their question.",
    "- If the data doesn't answer part of the question, say so in one short line.",
    "- Lists as \"• \" lines, never numbered. *bold* with single asterisks for a short heading; never ** or # headings.",
    "- No greeting, no sign-off, no web addresses. At most 1,800 characters. Reply in the language the seller wrote in.",
    "- At most one last short line on what they could do next, only if the data shows something worth doing (a product out of stock, one rejected).",
    "",
    "Data:",
    data,
  ].join("\n");
}

/** The AI's answer from the data, checked; null when it can't be used. */
async function composeAnswer(userId: string, request: string, data: string): Promise<string | null> {
  try {
    const { text } = await withAiUsageContext({ feature: "assistant", userId }, () => callGeminiBackend(MODEL, [{ text: composePrompt(request, data) }]));
    const clean = (text ?? "")
      .replace(/```[a-z]*\n?|```/g, "")
      .replace(/\*\*(.+?)\*\*/g, "*$1*")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
      .trim();
    if (clean.length < 20) return null;
    if (!numbersBacked(clean, data, request)) {
      console.warn(`[shop research] ${userId}: the answer had numbers not in the data; sending the data instead`);
      return null;
    }
    return clean.slice(0, 3000);
  } catch (e) {
    console.warn(`[shop research] ${userId}: AI answer failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Read what the question needs from their shop and answer it. Returns what
 * happened, for the assistant's log.
 */
export async function answerResearch(userId: string, phone: string, request: string, needs: ResearchNeed[]): Promise<string> {
  if (needs.length === 0) return "default";
  const ctx = await shopContext(userId, phone, "shop_whatsapp", "your shop's data");
  if (!ctx) return "blocked";
  // Several reads, or orders' items, take a while: say so.
  if (needs.length > 1 || needs.some((n) => n.source === "product_sales" || n.source === "orders")) {
    await sendTextIfConfigured(phone, "🔎 Looking through your Jumia shop…");
  }
  const deadline = Date.now() + 30_000;
  const blocks = await Promise.all(needs.map((n) => readNeed(ctx, n, deadline)));
  const data = blocksText(blocks);
  const answer = blocks.every((b) => b.failed) ? null : await composeAnswer(userId, request, data);
  const fromJumia = needs.some((n) => n.source !== "pandaworld_listings");
  await sendLong(phone, `${answer ?? data}${fromJumia ? "\n\n_Read from Jumia just now._" : ""}`);
  return `research ${needs.map((n) => n.source).join("+")}: ${answer ? "answered" : "data sent"}`;
}
