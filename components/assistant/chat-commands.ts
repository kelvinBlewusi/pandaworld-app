/**
 * The Listing Assistant's command menu (owner, 2026-10-07): "Type / for
 * commands" in the message box, and the + button beside Upload. Each
 * command sends the words the bot already knows (lib/whatsapp/commands.ts,
 * the same on WhatsApp), or puts the start of one in the box to finish
 * ("polish " and the product number). The billed ones say their price;
 * they're charged when they run (lib/whatsapp/chat-commands.ts), a change
 * to live products on its confirm tap.
 */

import { LIVE_CHANGE_CREDIT_COST, POLISH_CREDIT_COST, REPORT_CREDIT_COST } from "@/lib/billing/credit-packs";

export interface PaletteCommand {
  /** What's typed after "/". */
  slash: string;
  title: string;
  hint:  string;
  /** Sent as it is. */
  send?: string;
  /** Put in the box to finish (a product number, what to change). */
  fill?: string;
  /** Its price, for the billed ones. */
  credits?: string;
}

export const PALETTE: PaletteCommand[] = [
  { slash: "orders",     title: "Orders",             hint: "Orders waiting to be packed",               send: "orders" },
  { slash: "sales",      title: "Sales today",        hint: "Today's orders and money",                  send: "sales today" },
  { slash: "week",       title: "Sales this week",    hint: "The last 7 days",                           send: "sales week" },
  { slash: "shop",       title: "My products",        hint: "On, off and rejected on Jumia",             send: "shop" },
  { slash: "stock",      title: "Out of stock",       hint: "Products to restock",                       send: "out of stock" },
  { slash: "payouts",    title: "Payouts",            hint: "Last paid and what's waiting",              send: "payouts" },
  { slash: "report",     title: "Shop health report", hint: "A full check of your shop, with what to do", send: "report", credits: `${REPORT_CREDIT_COST} credits` },
  { slash: "polish",     title: "Polish photos",      hint: "4 product photos from yours: add the product number", fill: "polish ", credits: `${POLISH_CREDIT_COST} credits a photo` },
  { slash: "change",     title: "Change a live product", hint: "Stock, price, a sale, on or off: say which and what", fill: "Change ", credits: `${LIVE_CHANGE_CREDIT_COST} a change` },
  { slash: "credits",    title: "My credits",         hint: "Your balance",                              send: "credits" },
  { slash: "status",     title: "Where am I",         hint: "Your batch and what's next",                send: "status" },
  { slash: "restart",    title: "Restart",            hint: "Start a new batch",                         send: "restart" },
  { slash: "help",       title: "How it works",       hint: "Listing step by step",                      send: "how it works" },
  { slash: "disconnect", title: "Disconnect Jumia",   hint: "Asks you to confirm first",                 send: "disconnect" },
];

/** The commands a "/..." being typed could mean, in menu order. */
export function matchingCommands(typed: string): PaletteCommand[] {
  const q = typed.replace(/^\//, "").trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (!q) return PALETTE;
  return PALETTE.filter((c) => c.slash.startsWith(q) || c.title.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)));
}

/**
 * What a typed "/command ..." sends: the command's own words with what was
 * typed after it ("/polish 2" → "polish 2"), or the text without its "/"
 * when it names no command.
 */
export function slashToText(typed: string): string {
  const m = typed.trim().match(/^\/(\S+)\s*(.*)$/);
  if (!m) return typed.trim();
  const [, name, rest] = m;
  const cmd = PALETTE.find((c) => c.slash === name.toLowerCase());
  if (!cmd) return `${name} ${rest}`.trim();
  if (cmd.fill) return `${cmd.fill}${rest}`.trim();
  return rest ? `${cmd.send} ${rest}`.trim() : cmd.send ?? name;
}
