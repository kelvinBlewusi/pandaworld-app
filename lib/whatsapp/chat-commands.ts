/**
 * The chat's commands (owner, 2026-10-07), the same words on WhatsApp and in
 * the Jumia Listing Assistant, where the / and + menus send them
 * (components/assistant/chat-commands.ts). WhatsApp stays a command flow,
 * not a conversation ("let's not make it chatty ... only update it for the
 * extra features linked to the packs"): "menu" lists these as a WhatsApp
 * list, each row the command's own words.
 *
 * Billed ones: "report" (REPORT_CREDIT_COST) and "polish N"
 * (POLISH_CREDIT_COST an image); a change to live products is billed on its
 * confirm tap (lib/whatsapp/shop.ts). The rest are free.
 */

import { createServerClient } from "@/lib/supabase/server";
import { POLISH_CREDIT_COST, REPORT_CREDIT_COST } from "@/lib/billing/credit-packs";
import { sendListIfConfigured, sendTextIfConfigured } from "@/lib/whatsapp/client";
import type { GlobalCommand, ShopRead } from "@/lib/whatsapp/commands";
import type { WhatsAppSession } from "@/lib/whatsapp/session";
import { creditsReply } from "@/lib/whatsapp/assistant";
import { answerPayouts, answerProducts, answerSales, answerStock } from "@/lib/whatsapp/shop";
import { answerHealthReport } from "@/lib/whatsapp/shop-health";
import { POLISH_COST, polishOnRequest } from "@/lib/whatsapp/chat-polish";

type ChatCommand = Extract<GlobalCommand, { type: "menu" | "credits" | "polish" | "report" | "shop_read" }>;

export const isChatCommand = (cmd: GlobalCommand): cmd is ChatCommand =>
  cmd.type === "menu" || cmd.type === "credits" || cmd.type === "polish" || cmd.type === "report" || cmd.type === "shop_read";

/** The menu's rows: each id is the command's words (WhatsApp list, at most 10). */
export const MENU_ROWS = [
  { id: "orders",       title: "Orders to pack",     description: "Pack, ready to ship or cancel" },
  { id: "sales today",  title: "Sales today",        description: "Orders and money today" },
  { id: "sales week",   title: "Sales this week",    description: "The last 7 days" },
  { id: "shop",         title: "My products",        description: "On, off and rejected on Jumia" },
  { id: "out of stock", title: "Out of stock",       description: "Products to restock" },
  { id: "payouts",      title: "Payouts",            description: "Last paid and what's waiting" },
  { id: "report",       title: "Shop health report", description: `A full check of your shop · ${REPORT_CREDIT_COST} credits` },
  { id: "credits",      title: "My credits",         description: "Balance and buying credits" },
  { id: "status",       title: "Where am I",         description: "Your batch and what's next" },
  { id: "how it works", title: "How it works",       description: "Listing step by step" },
];

export function menuText(): string {
  return "📋 Here's what I can do. Tap one, or type its words any time.\n\n" +
    `To polish a product's photos, type *polish* and its number, e.g. *polish 2* (${POLISH_COST} credits for 4 photos, ${POLISH_CREDIT_COST} each). ` +
    "To list, say how many products. *restart* starts over, *disconnect* disconnects Jumia.";
}

const READS: Record<ShopRead, (userId: string, phone: string) => Promise<unknown>> = {
  shop:         (u, p) => answerProducts(u, p, "all"),
  out_of_stock: (u, p) => answerStock(u, p, null, "out"),
  low_stock:    (u, p) => answerStock(u, p, null, "low"),
  sales_today:  (u, p) => answerSales(u, p, "today"),
  sales_week:   (u, p) => answerSales(u, p, "week"),
  payouts:      (u, p) => answerPayouts(u, p),
};

export async function runChatCommand(cmd: ChatCommand, userId: string, phone: string, session: WhatsAppSession): Promise<void> {
  switch (cmd.type) {
    case "menu":
      await sendListIfConfigured(phone, menuText(), "Open menu", MENU_ROWS);
      return;
    case "credits":
      await creditsReply(userId, phone);
      return;
    case "report":
      await answerHealthReport(userId, phone);
      return;
    case "shop_read":
      await READS[cmd.what](userId, phone);
      return;
    case "polish":
      await polishCommand(userId, phone, session, cmd.seq);
      return;
  }
}

/** "polish 2": that product of the batch in progress (or the one just sent, which says it's with Jumia). */
async function polishCommand(userId: string, phone: string, session: WhatsAppSession, seq: number | null): Promise<void> {
  const batchId = session.batchId ?? session.lastSubmittedBatchId ?? null;
  if (!batchId) {
    await sendTextIfConfigured(phone, `📸 Polish works on a product you're listing: send its photos, then *polish* and its number, e.g. *polish 1* (${POLISH_COST} credits for 4 photos).`);
    return;
  }
  const { data } = await createServerClient()
    .from("listings")
    .select("id, whatsapp_seq")
    .eq("user_id", userId)
    .eq("whatsapp_batch_id", batchId);
  const rows = ((data ?? []) as { id: string; whatsapp_seq: number | null }[]).sort((a, b) => (a.whatsapp_seq ?? 0) - (b.whatsapp_seq ?? 0));
  const pick = seq != null ? rows.find((r) => r.whatsapp_seq === seq) : rows.length === 1 ? rows[0] : null;
  if (!pick) {
    await sendTextIfConfigured(phone, rows.length === 0
      ? "📸 There's no product in this batch yet: send its photos first."
      : seq != null
        ? `📸 There's no product ${seq} in this batch (it has ${rows.length}). Send *polish* with its number, e.g. *polish 1*.`
        : `📸 Which product? Send *polish* with its number, e.g. *polish 1* (${POLISH_COST} credits for 4 photos).`);
    return;
  }
  await polishOnRequest(userId, phone, pick.id);
}
