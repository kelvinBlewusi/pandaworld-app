/**
 * The seller's live Jumia shop on WhatsApp (owner, 2026-10-07: "implement the
 * rest from the API and wire it conversationally"). Reached through the
 * assistant (lib/whatsapp/assistant.ts), which understands what the seller
 * asked and hands it here; the Jumia side is lib/jumia/shop.ts.
 *
 *   - Changing a live product: stock, price, a sale, on/off. The product is
 *     found in their catalog by their own words; the change is offered with
 *     one "Yes, change it" tap (or, when several products fit, one tap on
 *     the right one) before anything reaches Jumia, and is recorded in
 *     jumia_product_changes. Jumia applies it as a feed; the worker tells the
 *     seller if it refused (lib/whatsapp/shop-notices.ts).
 *   - Answers: stock ("how many fridges are left", "what's out of stock"),
 *     their products (inactive, rejected, an overview), one order by its
 *     number, orders and sales for today / the week / the month, payouts.
 *
 * Gated by pack (lib/billing/features.ts): products, stock and payouts need
 * `shop_whatsapp`, orders and sales `order_alerts` (both Pro and up). Every
 * tap id names the change it acts on (`lchg:<id>`), so a tap works whatever
 * the conversation is doing.
 */

import { createServerClient } from "@/lib/supabase/server";
import {
  sendButtonsIfConfigured, sendCtaUrlIfConfigured, sendListIfConfigured, sendTextIfConfigured,
} from "@/lib/whatsapp/client";
import { INTERACTIVE_BODY_MAX, splitForText } from "@/lib/whatsapp/text-limits";
import { appUrl } from "@/lib/whatsapp/app-url";
import { featureAccess, featureMinPackName, type FeatureId } from "@/lib/billing/features";
import { COUNTRY_CURRENCY, getValidJumiaCredentials } from "@/lib/jumia/api";
import { getJumiaConnectionKind } from "@/lib/jumia/credentials";
import { promptJumiaConnection } from "@/lib/whatsapp/jumia-connect";
import { jumiaCountryByCode, type JumiaCountry } from "@/lib/marketing/countries";
import { priceMinimumForUser, isBelowMinimum, money } from "@/lib/jumia/price-minimums";
import { formatAmount, handleOrderMessage } from "@/lib/whatsapp/orders";
import { isPacked, isToPack } from "@/lib/jumia/order-flow";
import { sellerCountry } from "@/lib/jumia/unlistable-categories";
import { getCategoryByCode } from "@/lib/jumia/categories";
import { COUNTRY_FEES, commissionOn, feeCategoryForPath, itemFeeFor, payoutAt } from "@/lib/marketing/country-fees";
import { calculatorPathFor, type JumiaCountryCode } from "@/lib/marketing/countries";
import {
  fetchPayouts, fetchStock, findOrderByNumber, findProducts, fromRow, localUpdate, orderStatusWord, ordersCreatedSince, ordersWithStatus, refreshProducts,
  saveProducts, sendLiveChange, sendLiveChanges, shopProducts, summarizeOrders, syncCatalog, type LiveChange, type ShopProduct,
} from "@/lib/jumia/shop";

const ID = "[0-9a-f-]{36}";
/** A proposed change waits this long for its tap. */
const CHANGE_TTL_MS = 30 * 60_000;
/** At or below this, stock is low. */
export const LOW_STOCK = 3;

interface Ctx {
  userId:   string;
  phone:    string;
  token:    string;
  country:  string;
  currency: string;
  jc?:      JumiaCountry;
}

/** Feature and Jumia connection, said to the seller when one's missing. Null then. */
async function shopContext(userId: string, phone: string, feature: FeatureId, what: string): Promise<Ctx | null> {
  const access = await featureAccess(userId, feature);
  if (!access.ok) {
    if (access.blockedBy === "credits") {
      await sendCtaUrlIfConfigured(phone, `You're out of credits: buy credits to use ${what} on WhatsApp again.`, "Buy credits", `${appUrl()}/extension/dashboard`);
    } else {
      await sendCtaUrlIfConfigured(phone, `${capitalise(what)} on WhatsApp come with the ${featureMinPackName(feature)} pack.`, "See packs", `${appUrl()}/pricing`);
    }
    return null;
  }
  try {
    const creds = await getValidJumiaCredentials(userId);
    const country = (creds.country || "GH").toUpperCase();
    return {
      userId, phone, token: creds.accessToken, country,
      currency: creds.currency || COUNTRY_CURRENCY[country] || "", jc: jumiaCountryByCode(country),
    };
  } catch {
    const kind = await getJumiaConnectionKind(userId);
    if (kind !== "connected") await promptJumiaConnection(userId, phone, kind, `To see ${what}, connect your Jumia account first.\n\n`);
    else await sendTextIfConfigured(phone, "I couldn't reach Jumia just now. Try again in a minute.");
    return null;
  }
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const shorten = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);
const label = (p: ShopProduct) => `${p.name}${p.variation && p.variation !== "..." ? ` (${p.variation})` : ""}`;

async function sendLong(phone: string, text: string): Promise<void> {
  for (const part of splitForText(text)) await sendTextIfConfigured(phone, part);
}

/** Their catalog, read from Jumia first when the copy is old. Null (and said) when it can't be read at all. */
async function catalog(ctx: Ctx): Promise<ShopProduct[] | null> {
  const sync = await syncCatalog(ctx.userId, { accessToken: ctx.token, country: ctx.country });
  const products = await shopProducts(ctx.userId);
  if (!sync.ok && products.length === 0) {
    await sendTextIfConfigured(ctx.phone, `I couldn't read your Jumia products just now: ${sync.message}`);
    return null;
  }
  if (products.length === 0) {
    await sendTextIfConfigured(ctx.phone, "Your Jumia shop has no products yet. Tell me how many you'd like to list and I'll help you get them on.");
    return null;
  }
  return products;
}

// ─── Changing a live product ─────────────────────────────────────────────────

/** "stock 3 → 20", "price GHS 4,500 → GHS 4,200". */
export function describeLiveChange(change: LiveChange, p: ShopProduct | null, ctx: { currency: string; jc?: JumiaCountry }): string {
  const cur = p?.currency || ctx.currency;
  const amount = (n: number) => formatAmount(n, cur, ctx.jc);
  switch (change.kind) {
    case "stock":  return p?.stock != null ? `stock ${p.stock} → ${change.stock}` : `stock to ${change.stock}`;
    case "price":  return p?.price != null ? `price ${amount(p.price)} → ${amount(change.price)}` : `price to ${amount(change.price)}`;
    case "sale":   return change.sale ? `a sale at ${amount(change.sale.price)} from ${change.sale.start} to ${change.sale.end}` : "end its sale";
    case "status": return change.active ? "turn it on (shown on Jumia)" : "turn it off (hidden on Jumia)";
  }
}

/** The most products one tap changes. */
export const MAX_GROUP = 20;

/**
 * The products each of the seller's words mean, for a change to several at
 * once: one match, the one they just changed, every match when they said
 * "all" or the matches are one product's variations (sizes, colours), else
 * unclear (said back, nothing changed).
 */
export function groupTargets(
  products: ShopProduct[], queries: string[], opts: { all?: boolean; preferSid?: string | null } = {},
): { targets: ShopProduct[]; missing: string[]; unclear: { query: string; matches: ShopProduct[] }[] } {
  const targets: ShopProduct[] = [];
  const missing: string[] = [];
  const unclear: { query: string; matches: ShopProduct[] }[] = [];
  for (const query of queries) {
    const found = findProducts(products, query, MAX_GROUP + 1);
    const preferred = opts.preferSid ? found.find((m) => m.sid === opts.preferSid) : undefined;
    const sets = new Set(found.map((m) => m.setSid ?? m.sid));
    if (found.length === 0) missing.push(query);
    else if (found.length === 1) targets.push(found[0]);
    else if (preferred) targets.push(preferred);
    else if (opts.all || sets.size === 1) targets.push(...found);
    else unclear.push({ query, matches: found });
  }
  const seen = new Set<string>();
  return { targets: targets.filter((p) => !seen.has(p.sid) && !!seen.add(p.sid)), missing, unclear };
}

/** The confirm question for a change, one line per product. */
function confirmText(products: ShopProduct[], change: LiveChange, ctx: { currency: string; jc?: JumiaCountry }): string {
  if (products.length === 1) {
    const one = products[0];
    return `Change *${shorten(label(one), 120)}* (SKU ${one.sellerSku}): ${describeLiveChange(change, one, ctx)}?\n\nThis changes it on Jumia.`;
  }
  const lines = products.map((p) => `• ${shorten(label(p), 50)}: ${describeLiveChange(change, p, ctx)}`);
  const head = `Change these ${products.length} products on Jumia?`;
  const tail = "One tap changes them all.";
  let body = [head, ...lines, "", tail].join("\n");
  for (let shown = lines.length - 1; body.length > INTERACTIVE_BODY_MAX - 20 && shown > 0; shown--) {
    body = [head, ...lines.slice(0, shown), `+${products.length - shown} more`, "", tail].join("\n");
  }
  return body;
}

/**
 * Offer a change to the product the seller means, for one tap. Several
 * products (a list of their words, or "all" of what one fits) go together:
 * one question, one tap, one feed. Returns what was done, for the
 * assistant's log.
 */
export async function proposeLiveChange(
  userId: string, phone: string, query: string | string[], change: LiveChange, opts: { preferSid?: string | null; all?: boolean } = {},
): Promise<string> {
  const ctx = await shopContext(userId, phone, "shop_whatsapp", "your live products");
  if (!ctx) return "blocked";
  if (change.kind === "price" || change.kind === "sale") {
    const value = change.kind === "price" ? change.price : change.sale?.price;
    const minimum = value != null ? await priceMinimumForUser(userId) : null;
    if (value != null && isBelowMinimum(value, minimum)) {
      await sendTextIfConfigured(phone, `${money(value, minimum.currency)} is below the lowest price Jumia allows (${money(minimum.min, minimum.currency)}), so I haven't changed anything.`);
      return "below minimum";
    }
  }
  const products = await catalog(ctx);
  if (!products) return "no catalog";
  const queries = (Array.isArray(query) ? query : [query]).filter((q) => q.trim());
  if (queries.length > 1 || opts.all) return proposeGroup(ctx, products, queries, change, opts);
  const found = findProducts(products, queries[0] ?? "");
  if (found.length === 0) {
    await sendTextIfConfigured(phone, `I couldn't find "${shorten(queries[0] ?? "", 60)}" among your ${products.length} Jumia products. Try its name as it shows on Jumia, or its SKU.`);
    return "not found";
  }
  // "Change its sale price…" right after changing one of these: that one.
  const preferred = opts.preferSid ? found.find((m) => m.sid === opts.preferSid) : undefined;
  const matches = preferred ? [preferred] : found;

  const db = createServerClient();
  const one = matches.length === 1 ? matches[0] : null;
  const { data, error } = await db.from("jumia_product_changes").insert({
    id: crypto.randomUUID(),
    user_id: userId,
    product_sid: one?.sid ?? null,
    seller_sku: one?.sellerSku ?? null,
    name: one ? label(one) : null,
    change,
    candidates: one ? null : matches.map((m) => m.sid),
    status: "pending",
  }).select("id").single();
  if (error || !data) {
    await sendTextIfConfigured(phone, "I couldn't get that ready just now. Send it again in a moment.");
    return `failed: ${error?.message ?? "no row"}`;
  }
  const id = (data as { id: string }).id;

  if (one) {
    await sendButtonsIfConfigured(
      phone,
      confirmText([one], change, ctx),
      [{ id: `lchg:${id}`, title: "Yes, change it ✅" }, { id: `lchgno:${id}`, title: "No" }],
    );
    return `offered ${change.kind} for ${one.sellerSku}`;
  }
  await sendListIfConfigured(
    phone,
    `Which product should I change (${describeLiveChange(change, null, ctx)})? I'll ask you to confirm before anything changes on Jumia.`,
    "Choose product",
    matches.map((m, i) => ({
      id:          `lpick:${id}:${i}`,
      title:       shorten(m.name, 24),
      description: shorten([m.variation && m.variation !== "..." ? m.variation : null, `SKU ${m.sellerSku}`, m.stock != null ? `${m.stock} in stock` : null].filter(Boolean).join(" · "), 72),
    })),
  );
  return `asked which of ${matches.length}`;
}

/** Several products, one change: said back when any is missing or unclear, else one question for one tap. */
async function proposeGroup(
  ctx: Ctx, products: ShopProduct[], queries: string[], change: LiveChange, opts: { preferSid?: string | null; all?: boolean },
): Promise<string> {
  const { userId, phone } = ctx;
  const { targets, missing, unclear } = groupTargets(products, queries, opts);
  if (missing.length > 0 || unclear.length > 0) {
    const lines: string[] = ["I haven't changed anything yet:"];
    for (const q of missing) lines.push(`• I couldn't find "${shorten(q, 50)}" among your Jumia products.`);
    for (const u of unclear) {
      lines.push(`• "${shorten(u.query, 40)}" could be ${u.matches.length} products:`);
      for (const m of u.matches.slice(0, 5)) lines.push(`   – ${shorten(label(m), 50)} (SKU ${m.sellerSku})`);
      if (u.matches.length > 5) lines.push(`   +${u.matches.length - 5} more`);
    }
    lines.push("", "Send it again with each product's name as it shows on Jumia, or its SKU" + (unclear.length > 0 ? ", or say \"all\" to change every one that fits." : "."));
    await sendLong(phone, lines.join("\n"));
    return `group unclear: ${[...missing, ...unclear.map((u) => u.query)].join(", ")}`;
  }
  if (targets.length > MAX_GROUP) {
    await sendTextIfConfigured(phone, `That's ${targets.length} products: I change up to ${MAX_GROUP} with one tap. Name fewer at a time, or use Jumia Vendor Center's bulk tools for more.`);
    return `group too big: ${targets.length}`;
  }
  const db = createServerClient();
  const groupId = crypto.randomUUID();
  const { error } = await db.from("jumia_product_changes").insert(targets.map((p) => ({
    id: crypto.randomUUID(), user_id: userId, group_id: groupId, product_sid: p.sid, seller_sku: p.sellerSku, name: label(p),
    change, candidates: null, status: "pending",
  })));
  if (error) {
    await sendTextIfConfigured(phone, "I couldn't get that ready just now. Send it again in a moment.");
    return `failed: ${error.message}`;
  }
  await sendButtonsIfConfigured(phone, confirmText(targets, change, ctx), [
    { id: `lgrp:${groupId}`, title: targets.length === 1 ? "Yes, change it ✅" : `Yes, change ${targets.length} ✅` },
    { id: `lgrpno:${groupId}`, title: "No" },
  ]);
  return `offered ${change.kind} for ${targets.length}: ${targets.map((p) => p.sellerSku).join(", ")}`;
}

type ShopTap =
  | { kind: "confirm" | "cancel"; id: string }
  | { kind: "pick"; id: string; index: number }
  | { kind: "group" | "groupno"; id: string };

/** A tap on a change's buttons, or null. Cheap: no I/O. */
export function parseShopTap(text: string | undefined): ShopTap | null {
  const t = text?.trim() ?? "";
  let m: RegExpMatchArray | null;
  if ((m = t.match(new RegExp(`^lchg:(${ID})$`, "i")))) return { kind: "confirm", id: m[1] };
  if ((m = t.match(new RegExp(`^lchgno:(${ID})$`, "i")))) return { kind: "cancel", id: m[1] };
  if ((m = t.match(new RegExp(`^lpick:(${ID}):(\\d{1,2})$`, "i")))) return { kind: "pick", id: m[1], index: Number(m[2]) };
  if ((m = t.match(new RegExp(`^lgrp:(${ID})$`, "i")))) return { kind: "group", id: m[1] };
  if ((m = t.match(new RegExp(`^lgrpno:(${ID})$`, "i")))) return { kind: "groupno", id: m[1] };
  return null;
}

/** The tap on a several-products change: every product in one feed, or none. */
async function handleGroupTap(userId: string, phone: string, groupId: string, confirm: boolean): Promise<void> {
  const db = createServerClient();
  const { data } = await db.from("jumia_product_changes").select("*").eq("group_id", groupId).eq("user_id", userId);
  const rows = (data ?? []) as Record<string, unknown>[];
  const pending = rows.filter((r) => r.status === "pending");
  if (pending.length === 0) {
    await sendTextIfConfigured(phone, rows.length > 0 ? "That change was already handled." : "I couldn't find that change. Tell me again what to change.");
    return;
  }
  const ids = pending.map((r) => String(r.id));
  const now = () => new Date().toISOString();
  if (Date.now() - new Date(String(pending[0].created_at)).getTime() > CHANGE_TTL_MS) {
    await db.from("jumia_product_changes").update({ status: "cancelled", error: "expired", updated_at: now() }).in("id", ids);
    await sendTextIfConfigured(phone, "That was a while ago, so I haven't changed anything. Tell me again what to change.");
    return;
  }
  if (!confirm) {
    await db.from("jumia_product_changes").update({ status: "cancelled", updated_at: now() }).in("id", ids);
    await sendTextIfConfigured(phone, "OK, nothing changed on Jumia.");
    return;
  }
  const ctx = await shopContext(userId, phone, "shop_whatsapp", "your live products");
  if (!ctx) return;
  const { data: prows } = await db.from("jumia_products").select("*").eq("user_id", userId).in("product_sid", pending.map((r) => String(r.product_sid)));
  const products = ((prows ?? []) as Record<string, unknown>[]).map(fromRow);
  const live = pending[0].change as LiveChange;
  const kept = pending.filter((r) => products.some((p) => p.sid === r.product_sid));
  if (kept.length === 0) {
    await sendTextIfConfigured(phone, "I couldn't find those products any more. Tell me again what to change.");
    return;
  }
  const keptProducts = kept.map((r) => products.find((p) => p.sid === r.product_sid)!);
  const sent = await sendLiveChanges(ctx.token, keptProducts, live, { country: ctx.country, currency: ctx.currency });
  if (!sent.ok) {
    await db.from("jumia_product_changes").update({ status: "failed", error: sent.message, updated_at: now() }).in("id", ids);
    await sendTextIfConfigured(phone, `⚠️ Jumia didn't take that change: ${sent.message}`);
    return;
  }
  await db.from("jumia_product_changes").update({ status: "sent", feed_id: sent.data.feedId, updated_at: now() }).in("id", kept.map((r) => String(r.id)));
  const gone = pending.filter((r) => !kept.includes(r));
  if (gone.length > 0) await db.from("jumia_product_changes").update({ status: "cancelled", error: "product gone", updated_at: now() }).in("id", gone.map((r) => String(r.id)));
  const names = keptProducts.slice(0, 5).map((p) => shorten(label(p), 40)).join(", ") + (keptProducts.length > 5 ? ` and ${keptProducts.length - 5} more` : "");
  await sendTextIfConfigured(phone, `✅ Sent to Jumia for ${keptProducts.length} product${keptProducts.length === 1 ? "" : "s"} (${names}): ${describeLiveChange(live, null, ctx)}. Jumia usually applies it within a few minutes; I'll tell you if it refuses any.`);
}

/** Handle a change's tap. False when the message isn't one. */
export async function handleShopTap(userId: string, phone: string, text: string | undefined): Promise<boolean> {
  const tap = parseShopTap(text);
  if (!tap) return false;
  if (tap.kind === "group" || tap.kind === "groupno") {
    await handleGroupTap(userId, phone, tap.id, tap.kind === "group");
    return true;
  }
  const db = createServerClient();
  const { data: row } = await db.from("jumia_product_changes").select("*").eq("id", tap.id).eq("user_id", userId).maybeSingle();
  const change = row as Record<string, unknown> | null;
  if (!change || change.status !== "pending") {
    await sendTextIfConfigured(phone, change ? "That change was already handled." : "I couldn't find that change. Tell me again what to change.");
    return true;
  }
  if (Date.now() - new Date(String(change.created_at)).getTime() > CHANGE_TTL_MS) {
    await db.from("jumia_product_changes").update({ status: "cancelled", error: "expired", updated_at: new Date().toISOString() }).eq("id", tap.id);
    await sendTextIfConfigured(phone, "That was a while ago, so I haven't changed anything. Tell me again what to change.");
    return true;
  }
  if (tap.kind === "cancel") {
    await db.from("jumia_product_changes").update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", tap.id);
    await sendTextIfConfigured(phone, "OK, nothing changed on Jumia.");
    return true;
  }

  const sid = tap.kind === "pick" ? ((change.candidates as string[] | null) ?? [])[tap.index] : String(change.product_sid ?? "");
  const ctx = await shopContext(userId, phone, "shop_whatsapp", "your live products");
  if (!ctx) return true;
  const { data: prow } = await db.from("jumia_products").select("*").eq("user_id", userId).eq("product_sid", sid ?? "").maybeSingle();
  if (!sid || !prow) {
    await sendTextIfConfigured(phone, "I couldn't find that product any more. Tell me again what to change.");
    return true;
  }
  const product = fromRow(prow as Record<string, unknown>);
  const live = change.change as LiveChange;

  // Picked from the list: the product is now known, the change is still
  // confirmed with its own tap. Live 2026-10-07, one tap on a list row sent
  // "end its sale" that the seller hadn't asked for.
  if (tap.kind === "pick") {
    await db.from("jumia_product_changes").update({
      product_sid: sid, seller_sku: product.sellerSku, name: label(product), updated_at: new Date().toISOString(),
    }).eq("id", tap.id);
    await sendButtonsIfConfigured(
      phone,
      confirmText([product], live, ctx),
      [{ id: `lchg:${tap.id}`, title: "Yes, change it ✅" }, { id: `lchgno:${tap.id}`, title: "No" }],
    );
    return true;
  }
  const sent = await sendLiveChange(ctx.token, product, live, { country: ctx.country, currency: ctx.currency });
  const now = new Date().toISOString();
  if (!sent.ok) {
    await db.from("jumia_product_changes").update({ status: "failed", error: sent.message, product_sid: sid, seller_sku: product.sellerSku, name: label(product), updated_at: now }).eq("id", tap.id);
    await sendTextIfConfigured(phone, `⚠️ Jumia didn't take that change to ${shorten(label(product), 80)}: ${sent.message}`);
    return true;
  }
  await db.from("jumia_product_changes").update({
    status: "sent", feed_id: sent.data.feedId, product_sid: sid, seller_sku: product.sellerSku, name: label(product), updated_at: now,
  }).eq("id", tap.id);
  await sendTextIfConfigured(phone, `✅ Sent to Jumia: *${shorten(label(product), 100)}*, ${describeLiveChange(live, product, ctx)}. Jumia usually applies it within a few minutes; I'll tell you if it refuses.`);
  return true;
}

/** What a change Jumia has applied does to the local copy. */
export async function recordApplied(userId: string, sid: string, change: LiveChange): Promise<void> {
  await createServerClient().from("jumia_products").update(localUpdate(change)).eq("user_id", userId).eq("product_sid", sid);
}

// ─── Answers ─────────────────────────────────────────────────────────────────

const stockText = (p: ShopProduct) => (p.stock == null ? "stock unknown" : p.stock === 0 ? "out of stock" : `${p.stock} left`);

/** Stock of the product(s) they name, or what's out of stock or low. */
export async function answerStock(userId: string, phone: string, query: string | null, filter: "out" | "low" | null): Promise<string> {
  const ctx = await shopContext(userId, phone, "shop_whatsapp", "your stock");
  if (!ctx) return "blocked";
  const products = await catalog(ctx);
  if (!products) return "no catalog";
  const active = products.filter((p) => p.status === "ACTIVE");
  if (query) {
    const found = findProducts(products, query);
    if (found.length === 0) {
      await sendTextIfConfigured(phone, `I couldn't find "${shorten(query, 60)}" among your Jumia products. Try its name as it shows on Jumia, or its SKU.`);
      return "not found";
    }
    await sendLong(phone, ["📦 Stock on Jumia", ...found.map((p) => `• ${shorten(label(p), 60)}: ${stockText(p)}`)].join("\n"));
    return `stock of ${found.length}`;
  }
  const out = active.filter((p) => p.stock === 0);
  const low = active.filter((p) => p.stock != null && p.stock > 0 && p.stock <= LOW_STOCK);
  const pick = filter === "low" ? low : filter === "out" ? out : [...out, ...low];
  if (pick.length === 0) {
    await sendTextIfConfigured(phone, filter === "out" ? "✅ Nothing is out of stock on Jumia." : `✅ None of your products is low on stock (${LOW_STOCK} or fewer).`);
    return "none";
  }
  const head = filter === "out" ? `🚫 Out of stock on Jumia (${pick.length})` : filter === "low" ? `⚠️ Low on stock (${pick.length})` : `⚠️ Out of stock or low (${pick.length})`;
  const lines = pick.slice(0, 15).map((p) => `• ${shorten(label(p), 60)}: ${stockText(p)}`);
  await sendLong(phone, [head, ...lines, ...(pick.length > 15 ? [`+${pick.length - 15} more. Ask me about one by name.`] : []), "", "Tell me the new stock to update one, e.g. \"set the fridge's stock to 10\"."].join("\n"));
  return `${pick.length} listed`;
}

/** Their products: an overview, or the inactive or rejected ones. */
export async function answerProducts(userId: string, phone: string, filter: "all" | "inactive" | "rejected"): Promise<string> {
  const ctx = await shopContext(userId, phone, "shop_whatsapp", "your live products");
  if (!ctx) return "blocked";
  const products = await catalog(ctx);
  if (!products) return "no catalog";
  const live = products.filter((p) => p.status !== "DELETED");
  const active = live.filter((p) => p.status === "ACTIVE");
  const inactive = live.filter((p) => p.status === "INACTIVE");
  const rejected = live.filter((p) => p.qcStatus === "REJECTED");
  const pending = live.filter((p) => p.qcStatus === "PENDING" || p.qcStatus === "NOT_READY_TO_QC");
  const out = active.filter((p) => p.stock === 0);

  if (filter === "inactive" || filter === "rejected") {
    const list = filter === "inactive" ? inactive : rejected;
    if (list.length === 0) {
      await sendTextIfConfigured(phone, filter === "inactive" ? "✅ All your Jumia products are on." : "✅ None of your Jumia products is rejected.");
      return "none";
    }
    const lines = list.slice(0, 40).map((p) => `• ${shorten(label(p), 60)}${filter === "rejected" && p.qcReason ? `: ${shorten(p.qcReason, 80)}` : ""}`);
    await sendLong(phone, [
      filter === "inactive" ? `⏸️ Turned off on Jumia (${list.length})` : `❌ Rejected by Jumia's quality check (${list.length})`,
      ...lines, ...(list.length > 40 ? [`+${list.length - 40} more`] : []),
      "", filter === "inactive" ? "Tell me which to turn on, e.g. \"turn on the blender\"." : "Fix them in Jumia Vendor Center, or list them again here.",
    ].join("\n"));
    return `${list.length} listed`;
  }
  await sendTextIfConfigured(phone, [
    `🛍️ Your Jumia shop: ${live.length} product${live.length === 1 ? "" : "s"}`,
    `• On: ${active.length}`,
    `• Off: ${inactive.length}`,
    `• Out of stock: ${out.length}`,
    `• Waiting for Jumia's check: ${pending.length}`,
    `• Rejected: ${rejected.length}`,
    "",
    "Ask me about any of them: stock, price, a sale, or turning one on or off.",
  ].join("\n"));
  return "overview";
}

const QC_WORDS: Record<string, string> = {
  APPROVED: "approved", PENDING: "waiting for Jumia's check", NOT_READY_TO_QC: "waiting for Jumia's check", REJECTED: "rejected",
};

/** One product's place on Jumia, for "is the drone live?". */
export function productInfoText(p: ShopProduct, ctx: { currency: string; jc?: JumiaCountry }, today: string): string {
  const cur = p.currency || ctx.currency;
  const amount = (n: number) => formatAmount(n, cur, ctx.jc);
  const on = p.status === "ACTIVE" ? (p.visible === false ? "on, but not shown to buyers yet" : "on (shown on Jumia)") : p.status === "INACTIVE" ? "off (hidden on Jumia)" : p.status === "DELETED" ? "deleted" : "unknown";
  const qc = p.qcStatus ? QC_WORDS[p.qcStatus] ?? p.qcStatus.toLowerCase() : null;
  const saleOn = p.salePrice != null && (!p.saleEnd || p.saleEnd.slice(0, 10) >= today);
  const live = p.status === "ACTIVE" && p.visible !== false && p.qcStatus === "APPROVED" && (p.stock == null || p.stock > 0);
  return [
    `${live ? "🟢" : "⚪"} *${shorten(label(p), 90)}* · SKU ${p.sellerSku}`,
    `• Status: ${on}`,
    ...(qc ? [`• Quality check: ${qc}${p.qcStatus === "REJECTED" && p.qcReason ? `: ${shorten(p.qcReason, 100)}` : ""}`] : []),
    `• Price: ${p.price != null ? amount(p.price) : "not set"}` +
      (saleOn ? ` · on sale at ${amount(p.salePrice!)}${p.saleStart && p.saleEnd ? ` (${shortDate(p.saleStart)} to ${shortDate(p.saleEnd)})` : ""}` : ""),
    `• Stock: ${stockText(p)}`,
    ...(p.status === "ACTIVE" && p.qcStatus === "APPROVED" && p.stock === 0 ? ["Buyers can't order it until it has stock."] : []),
  ].join("\n");
}

/** Where a product is on Jumia: on or off, its quality check, price, sale and stock, read fresh. */
export async function answerProductInfo(userId: string, phone: string, query: string): Promise<string> {
  const ctx = await shopContext(userId, phone, "shop_whatsapp", "your live products");
  if (!ctx) return "blocked";
  const products = await catalog(ctx);
  if (!products) return "no catalog";
  const found = findProducts(products, query);
  if (found.length === 0) {
    await sendTextIfConfigured(phone, `I couldn't find "${shorten(query, 60)}" among your ${products.length} Jumia products. Try its name as it shows on Jumia, or its SKU.`);
    return "not found";
  }
  const shown = await refreshProducts(ctx.token, ctx.country, found.slice(0, 3)).catch(() => found.slice(0, 3));
  await saveProducts(userId, shown).catch(() => undefined);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: ctx.jc?.timeZone ?? "UTC" }).format(new Date());
  await sendLong(phone, [
    ...shown.map((p) => productInfoText(p, ctx, today)),
    ...(found.length > 3 ? [`+${found.length - 3} more match "${shorten(query, 40)}". Name one more exactly, or its SKU.`] : []),
  ].join("\n\n"));
  return `info on ${shown.map((p) => p.sellerSku).join(", ")}`;
}

/**
 * What Jumia takes when a product sells and what the seller receives: its
 * commission by its category (Jumia's own tables, lib/marketing/country-fees.ts),
 * and the per-item fee where it's set by category. At the price they give,
 * else its sale price while the sale runs, else its price. A draft (in the
 * review step) is passed in; anything else is found in their Jumia shop.
 */
export async function answerFees(
  userId: string, phone: string, query: string, price: number | null,
  draft?: { name: string; price: number | null; categoryPath: string | null },
): Promise<string> {
  const ctx = await shopContext(userId, phone, "fee_calc_whatsapp", "Jumia's fees");
  if (!ctx) return "blocked";
  const fees = COUNTRY_FEES[ctx.country as JumiaCountryCode];
  const calculator = `${appUrl()}${calculatorPathFor(ctx.country)}`;
  if (!fees) {
    await sendCtaUrlIfConfigured(phone, "I don't have Jumia's fee table for your country yet. The calculator has the rates I know.", "Price calculator", calculator);
    return "no fee table";
  }
  let name: string;
  let basePrice: number | null;
  let categoryPath: string | null;
  let currency = ctx.currency;
  let onSale = false;
  if (draft) {
    name = draft.name;
    basePrice = draft.price;
    categoryPath = draft.categoryPath;
  } else {
    const products = await catalog(ctx);
    if (!products) return "no catalog";
    const found = findProducts(products, query);
    if (found.length === 0) {
      await sendTextIfConfigured(phone, `I couldn't find "${shorten(query, 60)}" among your Jumia products. Try its name as it shows on Jumia, or its SKU.`);
      return "not found";
    }
    if (new Set(found.map((m) => m.setSid ?? m.sid)).size > 1) {
      await sendLong(phone, [
        `"${shorten(query, 40)}" could be ${found.length} products. Which one?`,
        ...found.slice(0, 5).map((m) => `• ${shorten(label(m), 60)} (SKU ${m.sellerSku})`),
        "", "Ask again with its name as it shows on Jumia, or its SKU.",
      ].join("\n"));
      return `fees unclear: ${found.length}`;
    }
    const p = found[0];
    name = label(p);
    currency = p.currency || currency;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: ctx.jc?.timeZone ?? "UTC" }).format(new Date());
    onSale = p.salePrice != null && (!p.saleEnd || p.saleEnd.slice(0, 10) >= today) && (!p.saleStart || p.saleStart.slice(0, 10) <= today);
    basePrice = onSale ? p.salePrice : p.price;
    categoryPath = p.categoryCode ? (await getCategoryByCode(Number(p.categoryCode)).catch(() => null))?.path ?? null : null;
  }
  const at = price ?? basePrice;
  if (at == null || !(at > 0)) {
    await sendTextIfConfigured(phone, `What price should I work it out at? e.g. "how much do I get if I sell the ${shorten(name, 30)} at 300".`);
    return "no price";
  }
  const category = feeCategoryForPath(fees, categoryPath);
  if (!category) {
    await sendCtaUrlIfConfigured(phone, `I couldn't match *${shorten(name, 80)}*'s Jumia category${categoryPath ? ` (${shorten(categoryPath.split(">").pop()!.trim(), 40)})` : ""} to Jumia's fee table. Pick its category in the calculator to see what you'd receive at ${formatAmount(at, currency, ctx.jc)}.`, "Price calculator", calculator);
    return "no fee category";
  }
  const amount = (n: number) => formatAmount(n, currency, ctx.jc);
  const commission = commissionOn(fees, at, category.commission, "ds");
  const dsFee = itemFeeFor(fees, category, "ds", null);
  const jeFee = itemFeeFor(fees, category, "je", null);
  const lines = [
    `🧮 *${shorten(name, 80)}* sold at ${amount(at)}${onSale && price == null ? " (its sale price)" : ""}:`,
    `• Jumia commission (${category.name}, ${category.commission}%): ${amount(commission)}`,
  ];
  if (dsFee != null) {
    lines.push(`• ${capitalise(fees.feeName)} when you ship it yourself: ${amount(dsFee)}`);
    lines.push(`• You receive about *${amount(payoutAt(fees, at, dsFee, category.commission, "ds"))}*`);
    if (jeFee != null && jeFee !== dsFee) lines.push(`With Jumia Express (stock in Jumia's warehouse) the ${fees.feeName} is ${amount(jeFee)}, so about ${amount(payoutAt(fees, at, jeFee, category.commission, "je"))}.`);
  } else {
    const sizes = fees.itemFee.by === "size" ? fees.itemFee.sizes.map((s) => s.ds).filter((n): n is number => n != null) : [];
    lines.push(sizes.length > 0
      ? `• ${capitalise(fees.feeName)}: ${amount(Math.min(...sizes))} to ${amount(Math.max(...sizes))} by the item's size`
      : `• Plus Jumia's ${fees.feeName} per item`);
    lines.push(`• You receive about *${amount(at - commission)}* before the ${fees.feeName}`);
  }
  lines.push("", `Jumia's rates (${fees.effective}), VAT included. Your statement shows the exact figures.`);
  await sendCtaUrlIfConfigured(phone, lines.join("\n"), "Price calculator", calculator);
  return `fees ${category.name} at ${at}`;
}

const STATUS_NAMES: Record<string, string> = {
  PENDING: "Pending", READY_TO_SHIP: "Ready to ship", SHIPPED: "Shipped", DELIVERED: "Delivered", CANCELED: "Cancelled",
  CANCELLED: "Cancelled", RETURNED: "Returned", FAILED: "Failed delivery", MULTIPLE_STATUS: "Mixed",
};
export const statusName = (s: string) => STATUS_NAMES[s] ?? capitalise(s.toLowerCase().replace(/_/g, " "));

const shortDate = (iso: string | undefined | null, jc?: JumiaCountry) => {
  if (!iso) return "";
  const d = new Date(iso.includes("T") || iso.includes("Z") ? iso : iso.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: jc?.timeZone ?? "UTC" }).format(d);
};

/** One order by its number: where it is, item by item. */
export async function answerOrderStatus(userId: string, phone: string, number: string): Promise<string> {
  const ctx = await shopContext(userId, phone, "order_alerts", "your Jumia orders");
  if (!ctx) return "blocked";
  const r = await findOrderByNumber(ctx.token, number);
  if (!r.ok) {
    await sendTextIfConfigured(phone, `I couldn't read your Jumia orders: ${r.message}`);
    return "failed";
  }
  if (!r.data) {
    await sendTextIfConfigured(phone, `I couldn't find order #${number} in your Jumia orders from the last 3 months.`);
    return "not found";
  }
  const { order, items } = r.data;
  // Still waiting on the seller: the usual order view, with its buttons.
  if (items.some((i) => isToPack(i) || isPacked(i))) {
    if (await handleOrderMessage(userId, phone, `order:${order.id}`)) return "showed waiting order";
  }
  const total = order.totalAmountLocal ? formatAmount(Number(order.totalAmountLocal.value) || 0, order.totalAmountLocal.currency, ctx.jc) : "";
  const lines = items.map((i) => {
    const s = statusName(String(i.status ?? "").trim().toUpperCase().replace(/[^A-Z]+/g, "_"));
    return `• ${shorten(i.product?.name ?? "Item", 50)}: ${s}${i.trackingNumber ? ` (tracking ${i.trackingNumber})` : ""}`;
  });
  await sendLong(phone, [
    `📦 Order #${order.number}: ${statusName(orderStatusWord(order))}`,
    [shortDate(order.createdAt, ctx.jc) && `Ordered ${shortDate(order.createdAt, ctx.jc)}`, total].filter(Boolean).join(" · "),
    ...lines,
  ].join("\n"));
  return `order ${order.number}`;
}

export type Period = "today" | "yesterday" | "week" | "month" | "quarter";

/** The first day of `period` in the seller's own timezone, as YYYY-MM-DD. "quarter" is 90 days, as far back as Jumia's orders go. */
export function periodStart(period: Period, timeZone: string, now = new Date()): string {
  const back = period === "today" ? 0 : period === "yesterday" ? 1 : period === "week" ? 6 : period === "month" ? 29 : 89;
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(now.getTime() - back * 86_400_000));
}

/** The day after `period` ends (exclusive), YYYY-MM-DD: today for "yesterday", else tomorrow. */
export function periodEnd(period: Period, timeZone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(now.getTime() + (period === "yesterday" ? 0 : 1) * 86_400_000));
}

const PERIOD_WORDS: Record<Period, string> = {
  today: "today", yesterday: "yesterday", week: "in the last 7 days", month: "in the last 30 days", quarter: "in the last 90 days",
};

/**
 * Their orders and sales for today, yesterday, the last 7, 30 or 90 days, by
 * status; or, with statuses ("ready to ship and cancelled orders yesterday"),
 * the orders that moved to each in that time, one line each. Each status is
 * its own request, the way the worker's single-status reads were checked live.
 */
export async function answerSales(userId: string, phone: string, period: Period, status: string | string[] | null = null): Promise<string> {
  const ctx = await shopContext(userId, phone, "order_alerts", "your Jumia orders");
  if (!ctx) return "blocked";
  const tz = ctx.jc?.timeZone ?? "UTC";
  const when = PERIOD_WORDS[period];
  const statuses = (Array.isArray(status) ? status : status ? [status] : []).slice(0, 4);
  if (statuses.length > 0) {
    const parts: string[] = [];
    const counts: string[] = [];
    for (const s of statuses) {
      const r = await ordersWithStatus(ctx.token, s, periodStart(period, tz), periodEnd(period, tz));
      if (!r.ok) {
        await sendTextIfConfigured(phone, `I couldn't read your Jumia orders: ${r.message}`);
        return "failed";
      }
      const name = statusName(s).toLowerCase();
      counts.push(`${r.data.length} ${name}`);
      if (r.data.length === 0) {
        parts.push(`No ${name} Jumia orders ${when}.`);
        continue;
      }
      const max = statuses.length > 1 ? 8 : 15;
      const lines = r.data.slice(0, max).map((o) =>
        `• #${o.number}${o.totalAmountLocal ? ` · ${formatAmount(Number(o.totalAmountLocal.value) || 0, o.totalAmountLocal.currency, ctx.jc)}` : ""}` +
        (o.updatedAt || o.createdAt ? ` · ${shortDate(o.updatedAt ?? o.createdAt, ctx.jc)}` : ""));
      parts.push([
        `📦 ${r.data.length} ${name} Jumia order${r.data.length === 1 ? "" : "s"} ${when}`,
        ...lines, ...(r.data.length > max ? [`+${r.data.length - max} more`] : []),
      ].join("\n"));
    }
    const any = counts.some((c) => !c.startsWith("0 "));
    await sendLong(phone, [...parts, ...(any ? ["Ask me about one by its number for the details."] : [])].join("\n\n"));
    return counts.join(", ");
  }
  const r = await ordersCreatedSince(ctx.token, periodStart(period, tz), 10, periodEnd(period, tz));
  if (!r.ok) {
    await sendTextIfConfigured(phone, `I couldn't read your Jumia orders: ${r.message}`);
    return "failed";
  }
  const s = summarizeOrders(r.data);
  if (s.orders === 0) {
    await sendTextIfConfigured(phone, `No Jumia orders ${when}${period === "today" ? " yet" : ""}.`);
    return "none";
  }
  const order = ["PENDING", "READY_TO_SHIP", "SHIPPED", "DELIVERED", "RETURNED", "FAILED", "CANCELED"];
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
  const parts = Object.entries(s.byStatus)
    .sort(([a], [b]) => rank(a) - rank(b))
    .map(([k, n]) => `${statusName(k)} ${n}`);
  await sendTextIfConfigured(phone, [
    `📊 ${s.orders}${s.orders >= 1000 ? "+" : ""} Jumia order${s.orders === 1 ? "" : "s"} ${when}` + (s.currency ? ` · ${formatAmount(s.value, s.currency, ctx.jc)}` : ""),
    parts.join(" · "),
    ...(s.currency ? ["(The total leaves out cancelled orders.)"] : []),
  ].join("\n"));
  return `${s.orders} orders`;
}

/** How many products they listed with PandaWorld in the period, by where each one is now. No Jumia call. */
export async function answerListings(userId: string, phone: string, period: Period): Promise<string> {
  const country = jumiaCountryByCode(await sellerCountry(userId).catch(() => null));
  const tz = country?.timeZone ?? "UTC";
  const from = periodStart(period, tz);
  const to = periodEnd(period, tz);
  const { data } = await createServerClient().from("listings").select("status, created_at").eq("user_id", userId).gt("created_at", `${from}T00:00:00`);
  const rows = ((data ?? []) as { status: string; created_at: string }[]).filter((r) => r.created_at.slice(0, 10) >= from && r.created_at.slice(0, 10) < to);
  const when = PERIOD_WORDS[period];
  if (rows.length === 0) {
    await sendTextIfConfigured(phone, `You haven't listed any products with PandaWorld ${when}. Tell me how many you'd like to list.`);
    return "none";
  }
  const count = (...st: string[]) => rows.filter((r) => st.includes(r.status)).length;
  const parts = [
    [count("live"), "live on Jumia"],
    [count("pending_approval", "processing"), "waiting for Jumia"],
    [count("draft", "awaiting_review"), "drafts not sent yet"],
    [count("failed"), "held or rejected"],
  ].filter(([n]) => (n as number) > 0).map(([n, what]) => `${n} ${what}`);
  await sendTextIfConfigured(phone, `🛍️ ${rows.length} product${rows.length === 1 ? "" : "s"} listed with PandaWorld ${when}: ${parts.join(", ")}.`);
  return `${rows.length} listings`;
}

/** Their last payout and the statement still open. */
export async function answerPayouts(userId: string, phone: string): Promise<string> {
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
  const amount = (n: number | null, cur: string) => (n == null ? "?" : formatAmount(n, cur || ctx.currency, ctx.jc));
  const lastPaid = r.data.find((s) => s.paid);
  const open = r.data.find((s) => !s.paid);
  const lines = ["💰 Your Jumia payouts"];
  if (lastPaid) {
    lines.push(`Last paid: *${amount(lastPaid.amount, lastPaid.currency)}*, ${shortDate(lastPaid.updatedAt ?? lastPaid.createdAt, ctx.jc)}` +
      (lastPaid.reference ? ` (ref ${lastPaid.reference})` : "") + ` · statement ${lastPaid.number}`);
  }
  if (open) {
    lines.push(`Not paid yet: *${amount(open.amount, open.currency)}* · statement ${open.number} from ${shortDate(open.createdAt, ctx.jc)}`);
    const detail = [
      open.itemRevenue != null ? `sales ${amount(open.itemRevenue, open.currency)}` : null,
      open.feesTotal != null ? `fees ${amount(open.feesTotal, open.currency)}` : null,
      open.refunds ? `refunds ${amount(open.refunds, open.currency)}` : null,
    ].filter(Boolean);
    if (detail.length) lines.push(`(${detail.join(", ")})`);
  }
  await sendTextIfConfigured(phone, lines.join("\n"));
  return "payouts";
}

/**
 * For a new-order alert: each ordered product now at LOW_STOCK or below on
 * Jumia, read live (by the sids in the local catalog; nothing when it was
 * never read). Null when none is low.
 */
export async function lowStockNote(userId: string, token: string, orders: { items: { product?: { sellerSku?: string; name?: string } }[] }[]): Promise<string | null> {
  const skus = Array.from(new Set(orders.flatMap((o) => o.items.map((i) => i.product?.sellerSku)).filter((s): s is string => !!s)));
  if (skus.length === 0) return null;
  const { data } = await createServerClient().from("jumia_products").select("product_sid, seller_sku, name, variation").eq("user_id", userId).in("seller_sku", skus);
  const rows = (data ?? []) as { product_sid: string; seller_sku: string; name: string; variation: string | null }[];
  if (rows.length === 0) return null;
  const stock = await fetchStock(token, Date.now() + 8_000, rows.map((r) => r.product_sid));
  if (!stock.ok) return null;
  const low = rows
    .map((r) => ({ r, n: stock.data.get(r.product_sid) }))
    .filter((x): x is { r: typeof rows[number]; n: number } => x.n != null && x.n <= LOW_STOCK);
  if (low.length === 0) return null;
  await createServerClient().from("jumia_products").upsert(
    low.map((x) => ({ user_id: userId, product_sid: x.r.product_sid, seller_sku: x.r.seller_sku, name: x.r.name, stock: x.n })),
    { onConflict: "user_id,product_sid" },
  );
  return ["⚠️ Low stock on Jumia:", ...low.map((x) => `• ${shorten(x.r.name, 50)}${x.r.variation && x.r.variation !== "..." ? ` (${x.r.variation})` : ""}: ${x.n === 0 ? "out of stock" : `${x.n} left`}`),
    "Tell me the new stock to update it, e.g. \"set its stock to 10\"."].join("\n");
}

