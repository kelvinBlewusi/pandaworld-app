/**
 * Changing a drafted product from chat: what the review step's edits
 * (handleEdit, applyChatPrice in lib/whatsapp/intake.ts) and the assistant
 * (lib/whatsapp/assistant.ts) share, so both change a product the same way.
 */

import { createServerClient } from "@/lib/supabase/server";
import { COUNTRY_CURRENCY, DEFAULT_JUMIA_COUNTRY, currencySymbol } from "@/lib/jumia/api";
import { sellerCountry } from "@/lib/jumia/unlistable-categories";

/** The seller's shop currency ISO code ("GHS", "NGN", ...) for a user
 *  already in hand — best-effort, defaults to GHS on any lookup failure so
 *  a currency-copy hiccup never blocks price parsing itself. PandaWorld
 *  lists Jumia sellers across Africa, not just Ghana — extractPrice/
 *  extractSalePrice (lib/whatsapp/batch.ts) used to always assume GHS
 *  regardless of the seller's actual shop. */
export async function shopCurrencyForUser(userId: string): Promise<string> {
  try {
    const db = createServerClient();
    const { data } = await db
      .from("jumia_connections")
      .select("country")
      .eq("user_id", userId)
      .maybeSingle();
    return COUNTRY_CURRENCY[(data?.country as string | null) ?? DEFAULT_JUMIA_COUNTRY] ?? "GHS";
  } catch {
    return "GHS";
  }
}

/**
 * A price as the chat shows it: in the seller's own currency ("GH₵150",
 * "₦2,000", "KSh 500") when their shop's country is known, and the bare
 * number when it isn't, never another country's currency (owner's request,
 * 2026-10-03: "GHS 150"). shopCurrencyForUser's GHS fallback is right for
 * reading a price, not for showing one.
 */
export async function chatPrice(userId: string, amount: number): Promise<string> {
  const country = await sellerCountry(userId).catch(() => null);
  const code = country ? COUNTRY_CURRENCY[country] : undefined;
  const shown = amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (!code) return shown;
  const symbol = currencySymbol(code);
  return /[A-Za-z]$/.test(symbol) ? `${symbol} ${shown}` : `${symbol}${shown}`;
}

/**
 * A price set in chat reaches the product's variants too. Jumia gets each
 * variant's own price when it has one, over the listing's
 * (mapListingToJumiaProducts), and a draft's variants are made at the
 * listing's price (runAutoAnalyze), so without this a sized product priced
 * again in chat still went to Jumia at the drafted price. A variant priced
 * separately in the editor keeps its own. Best-effort: the listing's price
 * is already saved.
 */
export async function carryPriceToVariants(listingId: string, oldPrice: unknown, newPrice: number): Promise<void> {
  const old = Number(oldPrice);
  if (!(old > 0) || old === newPrice) return;
  const db = createServerClient();
  try {
    const { data } = await db.from("variants").select("id, global_price").eq("listing_id", listingId);
    const following = ((data ?? []) as { id: string; global_price: unknown }[]).filter((v) => Number(v.global_price) === old);
    for (const v of following) {
      const { error } = await db.from("variants").update({ global_price: newPrice }).eq("id", v.id);
      if (error) throw new Error(error.message);
    }
  } catch (e) {
    console.warn(`[listing-edits] couldn't carry the price to listing ${listingId}'s variants: ${(e as Error).message}`);
  }
}

export interface SaleTerms { salePrice: number; startDate: string; endDate: string }

/**
 * The same for a sale set in chat ("sale 100 from 20 Oct to 28 Oct"). A
 * variant's own sale beats the listing's in the push and is what the editor
 * shows, so a sale saved on the listing alone was invisible in the draft
 * once its variants had one (owner's test, 2026-10-07). Followed by the
 * variants with no sale, those at the listing's previous one, and all of
 * them when they share one sale; a variant given its own in the editor
 * keeps it. Returns how many followed.
 */
export async function carrySaleToVariants(
  listingId: string,
  old: { sale_price?: unknown; sale_start_date?: unknown; sale_end_date?: unknown },
  sale: SaleTerms,
): Promise<number> {
  const db = createServerClient();
  const key = (p: unknown, s: unknown, e: unknown) => (p == null ? "" : `${Number(p)}|${s ?? ""}|${e ?? ""}`);
  const before = key(old.sale_price, old.sale_start_date, old.sale_end_date);
  try {
    const { data } = await db.from("variants").select("id, sale_price, sale_start_date, sale_end_date").eq("listing_id", listingId);
    const rows = (data ?? []) as { id: string; sale_price: unknown; sale_start_date: unknown; sale_end_date: unknown }[];
    const keys = rows.map((v) => key(v.sale_price, v.sale_start_date, v.sale_end_date));
    const shared = new Set(keys).size === 1;
    const following = rows.filter((_, i) => shared || keys[i] === "" || keys[i] === before);
    for (const v of following) {
      const { error } = await db.from("variants")
        .update({ sale_price: sale.salePrice, sale_start_date: sale.startDate, sale_end_date: sale.endDate })
        .eq("id", v.id);
      if (error) throw new Error(error.message);
    }
    return following.length;
  } catch (e) {
    console.warn(`[listing-edits] couldn't carry the sale to listing ${listingId}'s variants: ${(e as Error).message}`);
    return 0;
  }
}

/** A sale at or above a new price is no sale: Jumia refuses it. Cleared from the variants as from the listing. */
export async function dropVariantSalesFrom(listingId: string, price: number): Promise<void> {
  const db = createServerClient();
  try {
    const { data } = await db.from("variants").select("id, sale_price").eq("listing_id", listingId);
    for (const v of (data ?? []) as { id: string; sale_price: unknown }[]) {
      if (v.sale_price == null || Number(v.sale_price) < price) continue;
      const { error } = await db.from("variants").update({ sale_price: null, sale_start_date: null, sale_end_date: null }).eq("id", v.id);
      if (error) throw new Error(error.message);
    }
  } catch (e) {
    console.warn(`[listing-edits] couldn't clear listing ${listingId}'s variant sales: ${(e as Error).message}`);
  }
}

/**
 * The same for stock. Jumia takes a variant's stock from the variant alone
 * (`stock: v.quantity ?? 1` in mapListingToJumiaProducts), and drafting
 * makes every product at least one variant at the listing's quantity, so a
 * quantity changed in chat ("2: quantity 20") used to change nothing Jumia
 * saw (found 2026-10-06). Variants still at the old quantity follow; one
 * given its own stock in the editor keeps it. Returns how many followed.
 */
export async function carryStockToVariants(listingId: string, oldQuantity: unknown, newQuantity: number): Promise<number> {
  const old = oldQuantity == null ? null : Number(oldQuantity);
  if (old === newQuantity) return 0;
  const db = createServerClient();
  try {
    const { data } = await db.from("variants").select("id, quantity").eq("listing_id", listingId);
    const rows = (data ?? []) as { id: string; quantity: unknown }[];
    // A listing with no quantity of its own was drafted at 1 (runAutoAnalyze).
    const following = rows.filter((v) => Number(v.quantity ?? 1) === (old ?? 1));
    for (const v of following) {
      const { error } = await db.from("variants").update({ quantity: newQuantity }).eq("id", v.id);
      if (error) throw new Error(error.message);
    }
    return following.length;
  } catch (e) {
    console.warn(`[listing-edits] couldn't carry the stock to listing ${listingId}'s variants: ${(e as Error).message}`);
    return 0;
  }
}
