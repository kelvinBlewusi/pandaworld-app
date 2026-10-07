/**
 * More of the seller's Jumia shop in chat (owner, 2026-10-07: "do all"),
 * reached through the assistant (lib/whatsapp/assistant.ts); the Jumia side
 * is lib/jumia/shop.ts.
 *
 *   - Reports from their orders: best sellers, products with no sale, what
 *     runs out soon at the rate it sells, returns and failed deliveries.
 *   - Payout statements in detail, and their history.
 *   - Before listing: whether a brand is on Jumia (and allowed in a
 *     category), and what a category needs.
 *   - The shops under their Jumia account.
 *   - Jumia's warehouse: what it holds of a product, a delivery order into
 *     it, and marking one shipped. Both changes are offered for a tap
 *     (`wh:<id>`, recorded in jumia_warehouse_orders): Jumia has no call to
 *     read a delivery order back.
 *
 * Gated like the rest of the live shop (`shop_whatsapp`, Pro and up); the
 * brand and category answers are for everyone, as they help listing.
 */

import { createServerClient } from "@/lib/supabase/server";
import { sendButtonsIfConfigured, sendTextIfConfigured } from "@/lib/whatsapp/client";
import { formatAmount } from "@/lib/whatsapp/orders";
import { catalog, label, LOW_STOCK, sendLong, shopContext, shorten, type Ctx } from "@/lib/whatsapp/shop";
import { periodEnd, periodStart, type Period } from "@/lib/whatsapp/shop";
import { getItemsOfOrders, type JumiaCall, type JumiaOrderItem } from "@/lib/jumia/orders";
import {
  createWarehouseOrder, fetchLinkedShops, fetchPayouts, fetchWarehouseStock, findProducts, markWarehouseOrderShipped, ordersCreatedSince,
  refreshProducts, saveProducts, type PayoutStatement, type ShopProduct,
} from "@/lib/jumia/shop";
import { findBrandExact, searchBrandsFromDB } from "@/lib/jumia/brands";
import { checkProhibitedCategory, checkRestrictedBrand } from "@/lib/jumia/prohibited-catalog";
import { getCategoryAttributes, getListableCategories } from "@/lib/jumia/categories";
import { searchCategoriesByText } from "@/lib/jumia/category-search";
import { COUNTRY_FEES, feeCategoryForPath } from "@/lib/marketing/country-fees";
import { jumiaCountryByCode, type JumiaCountryCode } from "@/lib/marketing/countries";
import { sellerCountry } from "@/lib/jumia/unlistable-categories";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ID = "[0-9a-f-]{36}";
/** A warehouse offer waits this long for its tap. */
const OFFER_TTL_MS = 30 * 60_000;

const PERIOD_WORDS: Record<Period, string> = {
  today: "today", yesterday: "yesterday", week: "in the last 7 days", month: "in the last 30 days", quarter: "in the last 90 days",
};

// ─── Reports from their orders ───────────────────────────────────────────────

export type ReportKind = "best_sellers" | "slow_movers" | "restock" | "returns";

export interface ProductSales { sku: string; name: string; sold: number; revenue: number; returned: number; failed: number; cancelled: number; currency: string }

const itemStatus = (s: unknown) => String(s ?? "").trim().toUpperCase().replace(/[^A-Z]+/g, "_");

/**
 * Each product's units and money from order items, by its seller SKU. Sold is
 * everything not cancelled, returned or failed; the money is what buyers paid
 * for those. Pure.
 */
export function salesByProduct(items: JumiaOrderItem[]): Map<string, ProductSales> {
  const out = new Map<string, ProductSales>();
  for (const i of items) {
    const sku = i.product?.sellerSku?.trim();
    if (!sku) continue;
    const row = out.get(sku) ?? { sku, name: i.product?.name ?? sku, sold: 0, revenue: 0, returned: 0, failed: 0, cancelled: 0, currency: i.country?.currencyCode ?? "" };
    const st = itemStatus(i.status);
    if (st === "CANCELED" || st === "CANCELLED") row.cancelled++;
    else if (st === "RETURNED") row.returned++;
    else if (st.startsWith("FAILED")) row.failed++;
    else { row.sold++; row.revenue += Number(i.paidPriceLocal ?? i.itemPriceLocal) || 0; }
    out.set(sku, row);
  }
  return out;
}

/** At most this many orders are read for a report: the newest. */
const REPORT_ORDERS_MAX = 500;

/** The items of their orders in a period, the newest REPORT_ORDERS_MAX orders. `partial` when not all were read. */
async function orderItems(ctx: Ctx, from: string, to: string, deadline: number): Promise<JumiaCall<{ items: JumiaOrderItem[]; orders: number; partial: boolean }>> {
  const r = await ordersCreatedSince(ctx.token, from, 5, to);
  if (!r.ok) return r;
  const orders = r.data.slice(0, REPORT_ORDERS_MAX);
  const items: JumiaOrderItem[] = [];
  let read = 0;
  for (; read < orders.length && Date.now() < deadline; read += 25) {
    const got = await getItemsOfOrders(ctx.token, orders.slice(read, read + 25).map((o) => o.id));
    if (!got.ok) return got;
    for (const v of Array.from(got.data.values())) items.push(...v.items);
    await sleep(260);
  }
  return { ok: true, data: { items, orders: Math.min(read, orders.length), partial: read < orders.length || r.data.length >= REPORT_ORDERS_MAX } };
}

/** A product's days of stock left at the rate it sold in `days`; null when it didn't sell. */
export function daysLeft(stock: number | null, sold: number, days: number): number | null {
  if (stock == null || sold <= 0) return null;
  return Math.floor(stock / (sold / days));
}

/** Best sellers, products with no sale, what runs out soon, returns: one report. */
export async function answerReport(userId: string, phone: string, kind: ReportKind, period: Period): Promise<string> {
  const ctx = await shopContext(userId, phone, "shop_whatsapp", "reports on your Jumia shop");
  if (!ctx) return "blocked";
  const tz = ctx.jc?.timeZone ?? "UTC";
  // What runs out is worked out from the last 30 days, whatever was asked.
  const p: Period = kind === "restock" ? "month" : period === "today" || period === "yesterday" ? "week" : period;
  const days = p === "week" ? 7 : p === "quarter" ? 90 : 30;
  const r = await orderItems(ctx, periodStart(p, tz), periodEnd(p, tz), Date.now() + 35_000);
  if (!r.ok) {
    await sendTextIfConfigured(phone, `I couldn't read your Jumia orders: ${r.message}`);
    return "failed";
  }
  const sales = salesByProduct(r.data.items);
  const when = PERIOD_WORDS[p];
  const basis = r.data.partial ? ` (from your ${r.data.orders} most recent orders)` : "";
  const money = (n: number, cur: string) => formatAmount(n, cur || ctx.currency, ctx.jc);

  if (kind === "best_sellers") {
    const top = Array.from(sales.values()).filter((s) => s.sold > 0).sort((a, b) => b.sold - a.sold || b.revenue - a.revenue).slice(0, 10);
    if (top.length === 0) {
      await sendTextIfConfigured(phone, `No sales ${when} yet.`);
      return "best sellers: none";
    }
    await sendLong(phone, [
      `🏆 Your best sellers ${when}${basis}`,
      ...top.map((s, i) => `${i + 1}. ${shorten(s.name, 55)}: ${s.sold} sold · ${money(s.revenue, s.currency)}`),
    ].join("\n"));
    return `best sellers: ${top.length}`;
  }

  if (kind === "returns") {
    const rows = Array.from(sales.values()).filter((s) => s.returned + s.failed > 0)
      .sort((a, b) => (b.returned + b.failed) - (a.returned + a.failed)).slice(0, 12);
    const all = Array.from(sales.values());
    const total = all.reduce((n, s) => n + s.sold + s.returned + s.failed, 0);
    const back = all.reduce((n, s) => n + s.returned + s.failed, 0);
    if (rows.length === 0) {
      await sendTextIfConfigured(phone, `✅ No returns or failed deliveries ${when}${basis}.`);
      return "returns: none";
    }
    const rate = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : "–");
    await sendLong(phone, [
      `↩️ Returns and failed deliveries ${when}${basis}: ${back} of ${total} items (${rate(back, total)})`,
      ...rows.map((s) => `• ${shorten(s.name, 50)}: ${[s.returned ? `${s.returned} returned` : null, s.failed ? `${s.failed} failed delivery` : null].filter(Boolean).join(", ")} of ${s.sold + s.returned + s.failed} (${rate(s.returned + s.failed, s.sold + s.returned + s.failed)})`),
    ].join("\n"));
    return `returns: ${rows.length}`;
  }

  const products = await catalog(ctx);
  if (!products) return "no catalog";
  const live = products.filter((x) => x.status === "ACTIVE" && x.qcStatus === "APPROVED");

  if (kind === "slow_movers") {
    const from = periodStart(p, tz);
    const sold = new Set(Array.from(sales.values()).filter((s) => s.sold + s.returned + s.failed > 0).map((s) => s.sku));
    const idle = live
      .filter((x) => !sold.has(x.sellerSku) && (!x.createdAt || x.createdAt.slice(0, 10) < from) && x.stock !== 0)
      .sort((a, b) => (b.stock ?? 0) - (a.stock ?? 0));
    if (idle.length === 0) {
      await sendTextIfConfigured(phone, `✅ Every product that's on sold at least once ${when}${basis}.`);
      return "slow movers: none";
    }
    await sendLong(phone, [
      `🐢 ${idle.length} product${idle.length === 1 ? "" : "s"} on Jumia with no sale ${when}${basis}, most stock first:`,
      ...idle.slice(0, 15).map((x) => `• ${shorten(label(x), 55)}${x.stock != null ? `: ${x.stock} in stock` : ""}`),
      ...(idle.length > 15 ? [`+${idle.length - 15} more`] : []),
      "", "A sale can move them, e.g. \"10% off the blender this week\".",
    ].join("\n"));
    return `slow movers: ${idle.length}`;
  }

  // Restock: what runs out within two weeks at the rate it sold in 30 days.
  const bySku = new Map(live.map((x) => [x.sellerSku, x] as const));
  const soon = Array.from(sales.values())
    .filter((s) => s.sold > 0 && bySku.has(s.sku))
    .map((s) => ({ s, product: bySku.get(s.sku)!, left: daysLeft(bySku.get(s.sku)!.stock, s.sold, days) }))
    .filter((x) => x.product.stock === 0 || (x.left != null && x.left <= 14))
    .sort((a, b) => (a.left ?? -1) - (b.left ?? -1));
  if (soon.length === 0) {
    await sendTextIfConfigured(phone, `✅ Nothing runs out in the next 2 weeks at the rate it sold ${when}${basis}.`);
    return "restock: none";
  }
  await sendLong(phone, [
    `📦 Restock soon (at the rate each sold ${when}${basis}):`,
    ...soon.slice(0, 15).map(({ s, product, left }) =>
      `• ${shorten(label(product), 50)}: ${product.stock === 0 ? "out of stock" : `${product.stock} left, about ${left} day${left === 1 ? "" : "s"}`} · sold ${s.sold}`),
    ...(soon.length > 15 ? [`+${soon.length - 15} more`] : []),
    "", "Tell me the new stock to update one, e.g. \"set the kettle's stock to 30\".",
  ].join("\n"));
  return `restock: ${soon.length}`;
}

// ─── Payouts in detail ───────────────────────────────────────────────────────

const statementDate = (s: PayoutStatement) => (s.updatedAt ?? s.createdAt ?? "").slice(0, 10);

/** One statement line by line, as Jumia gives it. Pure. */
export function statementLines(s: PayoutStatement, money: (n: number) => string): string[] {
  const line = (what: string, n: number | null | undefined, minus = false) =>
    n != null && n !== 0 ? `• ${what}: ${minus && n > 0 ? "-" : ""}${money(n)}` : null;
  return [
    line("Opening balance", s.openingBalance),
    line("Sales", s.itemRevenue),
    line("Other revenue", s.otherRevenue),
    line("Shipping fees", s.shipmentFee, true),
    line("Shipping fee credits", s.shipmentFeeCredit),
    line("All fees", s.feesTotal, true),
    line("Refunds", s.refunds, true),
    line("Fees on refunds", s.feesOnRefunds),
    line("Subsidy", s.subsidy),
    line("Guarantee deposit", s.guaranteeDeposit),
    line("Closing balance", s.closingBalance),
  ].filter((x): x is string => !!x);
}

/** Their statements one line each, or one statement in detail (by its number, else the newest). */
export async function answerPayoutDetail(userId: string, phone: string, mode: "history" | "breakdown", number: string | null): Promise<string> {
  const ctx = await shopContext(userId, phone, "shop_whatsapp", "your Jumia payouts");
  if (!ctx) return "blocked";
  const r = await fetchPayouts(ctx.token);
  if (!r.ok) {
    await sendTextIfConfigured(phone, `I couldn't read your Jumia payouts: ${r.message}`);
    return "failed";
  }
  if (r.data.length === 0) {
    await sendTextIfConfigured(phone, "Jumia has no payout statements for you in the last 90 days.");
    return "none";
  }
  const money = (cur: string) => (n: number) => formatAmount(n, cur || ctx.currency, ctx.jc);
  if (mode === "history") {
    await sendLong(phone, [
      "💰 Your Jumia statements (last 90 days)",
      ...r.data.slice(0, 10).map((s) => `• ${statementDate(s)} · ${s.number} · *${money(s.currency)(s.amount)}* · ${s.paid ? `paid${s.reference ? ` (ref ${s.reference})` : ""}` : "not paid yet"}`),
      "", "Ask about one by its number for its fees and refunds.",
    ].join("\n"));
    return `history ${Math.min(10, r.data.length)}`;
  }
  const want = number?.trim().toLowerCase();
  const s = (want ? r.data.find((x) => x.number.toLowerCase() === want || x.number.toLowerCase().includes(want)) : null) ?? r.data[0];
  if (want && !s.number.toLowerCase().includes(want)) {
    await sendTextIfConfigured(phone, `I couldn't find statement ${number} in the last 90 days. Here's the newest one.`);
  }
  await sendLong(phone, [
    `🧾 Statement ${s.number} (${statementDate(s)})`,
    ...statementLines(s, money(s.currency)),
    `*Payout: ${money(s.currency)(s.amount)}* · ${s.paid ? `paid${s.reference ? ` (ref ${s.reference})` : ""}` : "not paid yet"}`,
    "", "Jumia's statements don't list their orders here: Vendor Center has each one's order lines.",
  ].join("\n"));
  return `breakdown ${s.number}`;
}

// ─── Brands and categories, before listing ───────────────────────────────────

/** The Jumia category that best fits a seller's words for a product, with a few others. */
async function categoryFor(words: string) {
  const all = await getListableCategories();
  return searchCategoriesByText(words, all, 4);
}

/** Whether a brand is on Jumia, and allowed in the category of a product they name. */
export async function answerBrand(userId: string, phone: string, brand: string, product: string | null): Promise<string> {
  const exact = await findBrandExact(brand).catch(() => null);
  if (!exact) {
    const near = [
      ...(await searchBrandsFromDB(brand, 6).catch(() => [])),
      ...(await searchBrandsFromDB(brand.slice(0, 3), 6).catch(() => [])),
    ];
    const names = Array.from(new Set(near.map((b) => b.name))).slice(0, 6);
    await sendTextIfConfigured(phone, `❓ "${shorten(brand, 40)}" isn't in Jumia's brand list.` +
      (names.length > 0 ? ` Close ones: ${names.join(", ")}.` : "") +
      " A product with no brand on Jumia is listed as Generic.");
    return `brand unknown: ${brand}`;
  }
  const lines = [`✅ *${exact.name}* is a brand on Jumia.`];
  if (product) {
    const top = (await categoryFor(product))[0];
    if (top) {
      const check = checkRestrictedBrand(exact.name, top.path);
      if (check.status === "forbidden") lines.push(`⛔ But Jumia doesn't allow ${exact.name} in ${top.path.split(">").pop()!.trim()}: a listing would be rejected.`);
      else if (check.status === "qc") lines.push(`⚠️ Jumia checks ${exact.name} closely in ${top.path.split(">").pop()!.trim()} for fakes: list only genuine stock, with clear photos of the packaging.`);
    }
  }
  await sendTextIfConfigured(phone, lines.join("\n"));
  return `brand ${exact.name}`;
}

/** What Jumia needs for a kind of product: its category, the details it asks for, the variation options, the commission. */
export async function answerCategoryNeeds(userId: string, phone: string, product: string): Promise<string> {
  const candidates = await categoryFor(product);
  const top = candidates[0];
  if (!top) {
    await sendTextIfConfigured(phone, `I couldn't match "${shorten(product, 40)}" to a Jumia category. Describe it another way, e.g. "women's perfume" or "electric kettle".`);
    return "no category";
  }
  const country = (await sellerCountry(userId).catch(() => null))?.toUpperCase() ?? null;
  const attrs = await getCategoryAttributes(top.code).catch(() => []);
  const required = attrs.filter((a) => a.required && !a.is_variant).map((a) => a.label || a.name);
  const options = Array.from(new Set(attrs.filter((a) => a.is_variant).flatMap((a) => a.allowed_values ?? []))).filter((v) => v && v !== "...");
  const fees = country ? COUNTRY_FEES[country as JumiaCountryCode] : undefined;
  const fee = fees ? feeCategoryForPath(fees, top.path) : null;
  const banned = country ? checkProhibitedCategory(country, [product, top.path]) : null;
  const countryName = country ? jumiaCountryByCode(country)?.name ?? country : null;
  const lines = [
    `🗂️ *${top.path.split(">").pop()!.trim()}*`,
    top.path,
    ...(banned?.blocked ? [`⛔ Jumia doesn't allow ${banned.blocked.keyword} in ${countryName}.`] : []),
    ...(banned?.warnings.length ? [`⚠️ ${banned.warnings.map((w) => `${w.keyword}: ${w.status.toLowerCase()}`).join("; ")}`] : []),
    required.length > 0 ? `Jumia needs: ${required.slice(0, 14).join(", ")}${required.length > 14 ? ", …" : ""}` : "Jumia needs the usual details: name, brand, description, price, photos.",
    options.length > 0 ? `Variation: one of ${options.slice(0, 10).join(", ")}${options.length > 10 ? ` and ${options.length - 10} more` : ""}` : "Variation: any (or none for a single product)",
    ...(fee ? [`Commission in ${countryName}: ${fee.commission}% (${fee.name})`] : []),
    ...(candidates.length > 1 ? [`Close categories: ${candidates.slice(1, 4).map((c) => c.path.split(">").pop()!.trim()).join(", ")}`] : []),
    "", "When you list with me, I fill most of this from your photos and notes.",
  ];
  await sendLong(phone, lines.join("\n"));
  return `category ${top.code}`;
}

// ─── Their shops ─────────────────────────────────────────────────────────────

export async function answerLinkedShops(userId: string, phone: string): Promise<string> {
  const ctx = await shopContext(userId, phone, "shop_whatsapp", "your Jumia shops");
  if (!ctx) return "blocked";
  const r = await fetchLinkedShops(ctx.token);
  if (!r.ok) {
    await sendTextIfConfigured(phone, `I couldn't read your Jumia shops: ${r.message}`);
    return "failed";
  }
  const name = (c: { country: string }) => jumiaCountryByCode(c.country)?.name ?? c.country;
  const lines = r.data.map((s) => `• *${s.name}*: ${s.countries.map((c) => `${name(c)}${c.status && c.status !== "ACTIVE" ? ` (${c.status.toLowerCase()})` : ""}`).join(", ") || "no country"}`);
  if (lines.length === 0) {
    await sendTextIfConfigured(phone, "Jumia didn't list any shop for your account.");
    return "none";
  }
  const current = ctx.jc?.name ?? ctx.country;
  await sendLong(phone, [
    `🏬 ${r.data.length === 1 ? "Your Jumia shop" : `Your ${r.data.length} Jumia shops`}`,
    ...lines,
    "", `I work on the shop you connected, in ${current}.`,
  ].join("\n"));
  return `shops ${r.data.length}`;
}

// ─── Jumia's warehouse ───────────────────────────────────────────────────────

/** The products found, with Jumia's own SKU read fresh when the local copy lacks it. */
async function withJumiaSku(ctx: Ctx, found: ShopProduct[]): Promise<ShopProduct[]> {
  if (found.every((p) => p.jumiaSku)) return found;
  const fresh = await refreshProducts(ctx.token, ctx.country, found).catch(() => found);
  await saveProducts(ctx.userId, fresh).catch(() => undefined);
  return fresh;
}

/** What Jumia's warehouse holds of the products they name. */
export async function answerWarehouseStock(userId: string, phone: string, query: string): Promise<string> {
  const ctx = await shopContext(userId, phone, "shop_whatsapp", "your stock in Jumia's warehouse");
  if (!ctx) return "blocked";
  const products = await catalog(ctx);
  if (!products) return "no catalog";
  const found = findProducts(products, query);
  if (found.length === 0) {
    await sendTextIfConfigured(phone, `I couldn't find "${shorten(query, 60)}" among your Jumia products. Try its name as it shows on Jumia, or its SKU.`);
    return "not found";
  }
  const shown = await withJumiaSku(ctx, found.slice(0, 3));
  const lines: string[] = [];
  for (const p of shown) {
    if (!p.jumiaSku) { lines.push(`• ${shorten(label(p), 55)}: Jumia didn't give its warehouse SKU`); continue; }
    const r = await fetchWarehouseStock(ctx.token, ctx.country, p.jumiaSku);
    if (!r.ok) {
      lines.push(`• ${shorten(label(p), 55)}: ${r.status === 404 ? "none in Jumia's warehouse" : r.message}`);
      continue;
    }
    const w = r.data;
    const parts = [
      `${w.received} received`, w.quarantined ? `${w.quarantined} in quarantine` : null, w.defective ? `${w.defective} defective` : null,
      w.returned ? `${w.returned} returned` : null, w.failed ? `${w.failed} failed` : null, w.canceled ? `${w.canceled} cancelled` : null,
    ].filter(Boolean);
    lines.push(`• ${shorten(label(p), 55)} (SKU ${p.sellerSku}): ${parts.join(" · ")}`);
    await sleep(260);
  }
  await sendLong(phone, ["🏭 In Jumia's warehouse", ...lines, ...(found.length > 3 ? [`+${found.length - 3} more match. Name one exactly, or its SKU.`] : [])].join("\n"));
  return `warehouse stock ${shown.length}`;
}

const tomorrow = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(Date.now() + 86_400_000));

/**
 * A delivery order into Jumia's warehouse, offered for one tap: each product
 * they name (one exact product each, its size or colour included) with its
 * quantity, leaving on `date` (tomorrow when they gave none).
 */
export async function proposeWarehouseOrder(
  userId: string, phone: string, items: { product: string; quantity: number }[], date: string | null,
): Promise<string> {
  const ctx = await shopContext(userId, phone, "shop_whatsapp", "delivery orders to Jumia's warehouse");
  if (!ctx) return "blocked";
  if (!ctx.shopId) {
    await sendTextIfConfigured(phone, "I don't have your Jumia shop's id yet. Reconnect Jumia in Settings, then try again.");
    return "no shop id";
  }
  const products = await catalog(ctx);
  if (!products) return "no catalog";
  const lines: { p: ShopProduct; quantity: number }[] = [];
  const problems: string[] = [];
  for (const item of items.slice(0, 20)) {
    const found = findProducts(products, item.product);
    if (found.length === 0) problems.push(`I couldn't find "${shorten(item.product, 40)}"`);
    else if (found.length > 1) problems.push(`"${shorten(item.product, 40)}" could be ${found.length} products (${found.slice(0, 3).map((p) => `${shorten(label(p), 30)}, SKU ${p.sellerSku}`).join("; ")})`);
    else lines.push({ p: found[0], quantity: item.quantity });
  }
  if (problems.length > 0 || lines.length === 0) {
    await sendLong(phone, ["I haven't made the delivery order:", ...problems.map((x) => `• ${x}`), "", "Name each product exactly (with its size or colour), or its SKU, with how many."].join("\n"));
    return `warehouse order unclear: ${problems.length}`;
  }
  const withSku = await withJumiaSku(ctx, lines.map((l) => l.p));
  const missing = withSku.filter((p) => !p.jumiaSku);
  if (missing.length > 0) {
    await sendTextIfConfigured(phone, `Jumia didn't give the warehouse SKU of ${missing.map((p) => shorten(label(p), 40)).join(", ")}, so I can't send ${missing.length === 1 ? "it" : "them"} to its warehouse.`);
    return "no jumia sku";
  }
  const shipping = date ?? tomorrow(ctx.jc?.timeZone ?? "UTC");
  const rows = lines.map((l, i) => ({ sid: l.p.sid, sellerSku: l.p.sellerSku, jumiaSku: withSku[i].jumiaSku, name: label(l.p), quantity: l.quantity }));
  const { data, error } = await createServerClient().from("jumia_warehouse_orders").insert({
    id: crypto.randomUUID(), user_id: userId, action: "create", status: "pending", products: rows, shipping_date: shipping,
  }).select("id").single();
  if (error || !data) {
    await sendTextIfConfigured(phone, "I couldn't get that ready just now. Send it again in a moment.");
    return `failed: ${error?.message ?? "no row"}`;
  }
  const id = (data as { id: string }).id;
  const units = rows.reduce((n, r) => n + r.quantity, 0);
  await sendButtonsIfConfigured(phone, [
    `Create a delivery order into Jumia's warehouse (${units} item${units === 1 ? "" : "s"})?`,
    ...rows.map((r) => `• ${shorten(r.name, 50)} (SKU ${r.sellerSku}): ${r.quantity}`),
    "", `Shipping on ${shipping}${date ? "" : " (tomorrow; say another date to change it)"}. Jumia gives it a purchase order number.`,
  ].join("\n").slice(0, 1024), [{ id: `wh:${id}`, title: "Yes, create it ✅" }, { id: `whno:${id}`, title: "No" }]);
  return `offered warehouse order: ${rows.length} products`;
}

/** Marking a delivery order shipped, with its tracking number, offered for one tap. */
export async function proposeWarehouseShipped(userId: string, phone: string, po: string, tracking: string, carrier: string | null): Promise<string> {
  const ctx = await shopContext(userId, phone, "shop_whatsapp", "delivery orders to Jumia's warehouse");
  if (!ctx) return "blocked";
  const { data, error } = await createServerClient().from("jumia_warehouse_orders").insert({
    id: crypto.randomUUID(), user_id: userId, action: "ship", status: "pending", po_number: po, tracking_number: tracking, carrier,
  }).select("id").single();
  if (error || !data) {
    await sendTextIfConfigured(phone, "I couldn't get that ready just now. Send it again in a moment.");
    return `failed: ${error?.message ?? "no row"}`;
  }
  const id = (data as { id: string }).id;
  await sendButtonsIfConfigured(phone,
    `Tell Jumia delivery order *${po}* has shipped, tracking ${tracking}${carrier ? ` with ${carrier}` : ""}?`,
    [{ id: `wh:${id}`, title: "Yes, it's shipped ✅" }, { id: `whno:${id}`, title: "No" }]);
  return `offered shipped ${po}`;
}

/** A tap on a warehouse offer. False when the message isn't one. */
export async function handleWarehouseTap(userId: string, phone: string, text: string | undefined): Promise<boolean> {
  const m = (text?.trim() ?? "").match(new RegExp(`^wh(no)?:(${ID})$`, "i"));
  if (!m) return false;
  const db = createServerClient();
  const { data } = await db.from("jumia_warehouse_orders").select("*").eq("id", m[2]).eq("user_id", userId).maybeSingle();
  const row = data as Record<string, unknown> | null;
  const now = () => new Date().toISOString();
  if (!row || row.status !== "pending") {
    await sendTextIfConfigured(phone, row ? "That was already handled." : "I couldn't find that. Tell me again what to do.");
    return true;
  }
  if (Date.now() - new Date(String(row.created_at)).getTime() > OFFER_TTL_MS) {
    await db.from("jumia_warehouse_orders").update({ status: "cancelled", error: "expired", updated_at: now() }).eq("id", m[2]);
    await sendTextIfConfigured(phone, "That was a while ago, so I haven't sent anything. Tell me again what to do.");
    return true;
  }
  if (m[1]) {
    await db.from("jumia_warehouse_orders").update({ status: "cancelled", updated_at: now() }).eq("id", m[2]);
    await sendTextIfConfigured(phone, "OK, nothing sent to Jumia.");
    return true;
  }
  const ctx = await shopContext(userId, phone, "shop_whatsapp", "delivery orders to Jumia's warehouse");
  if (!ctx) return true;
  if (row.action === "create") {
    const products = (row.products ?? []) as { jumiaSku: string; quantity: number; name: string }[];
    const r = await createWarehouseOrder(ctx.token, {
      shopId: ctx.shopId ?? "", country: ctx.country, shippingDate: String(row.shipping_date), products,
    });
    if (!r.ok) {
      await db.from("jumia_warehouse_orders").update({ status: "failed", error: r.message, updated_at: now() }).eq("id", m[2]);
      await sendTextIfConfigured(phone, `⚠️ Jumia didn't take the delivery order: ${r.message}`);
      return true;
    }
    await db.from("jumia_warehouse_orders").update({ status: "done", po_number: r.data.purchaseOrderNumber, updated_at: now() }).eq("id", m[2]);
    await sendTextIfConfigured(phone, `✅ Delivery order *${r.data.purchaseOrderNumber}* created with Jumia. When it leaves, tell me "${r.data.purchaseOrderNumber} shipped, tracking …" and I'll update Jumia.`);
    return true;
  }
  const r = await markWarehouseOrderShipped(ctx.token, String(row.po_number), {
    trackingNumber: String(row.tracking_number), ...(row.carrier ? { carrier: String(row.carrier) } : {}),
  });
  if (!r.ok) {
    await db.from("jumia_warehouse_orders").update({ status: "failed", error: r.message, updated_at: now() }).eq("id", m[2]);
    await sendTextIfConfigured(phone, `⚠️ Jumia didn't take that: ${r.message}`);
    return true;
  }
  await db.from("jumia_warehouse_orders").update({ status: "done", updated_at: now() }).eq("id", m[2]);
  await sendTextIfConfigured(phone, `✅ Jumia knows delivery order ${String(row.po_number)} has shipped (tracking ${String(row.tracking_number)}).`);
  return true;
}
