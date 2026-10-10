/**
 * The Listing Assistant's command menu (owner, 2026-10-07): "Type / for
 * commands" in the message box, and the + button beside Upload. Each
 * command sends the words the bot already knows (lib/whatsapp/commands.ts,
 * the same on WhatsApp), or puts the start of one in the box to finish
 * ("polish " and the product number). The menu shows no prices (owner,
 * 2026-10-07: "remove the credit explanation at the far right"): the billed
 * ones say what they cost when they run (lib/whatsapp/chat-commands.ts), a
 * change to live products on its confirm tap.
 */

export interface PaletteCommand {
  /** What's typed after "/". */
  slash: string;
  /** Other words typed after "/" for it ("/change" from before it was "/edit"). */
  aliases?: string[];
  title: string;
  hint:  string;
  /** Sent as it is. */
  send?: string;
  /** Put in the box to finish (a product number, what to change). */
  fill?: string;
  /** What a finished one looks like, said when only the fill is sent (one that means nothing alone). */
  example?: string;
  /** Done by the page itself, after it asks (clearing the chat). */
  action?: "clear";
}

export const PALETTE: PaletteCommand[] = [
  { slash: "orders",     title: "Orders",             hint: "Orders waiting to be packed",               send: "orders" },
  { slash: "sales",      title: "Sales today",        hint: "Today's orders and money",                  send: "sales today" },
  { slash: "week",       title: "Sales this week",    hint: "The last 7 days",                           send: "sales week" },
  { slash: "shop",       title: "My products",        hint: "ON, OFF and rejected on Jumia",             send: "shop" },
  { slash: "stock",      title: "Out of stock",       hint: "Products to restock",                       send: "out of stock" },
  { slash: "payouts",    title: "Payouts",            hint: "Last paid and what's waiting",              send: "payouts" },
  { slash: "report",     title: "Shop health report", hint: "A full check of your shop, with what to do", send: "report" },
  { slash: "polish",     title: "Polish photos",      hint: "4 product photos from yours: add the product number", fill: "polish " },
  // Owner, 2026-10-07: "change the /change to edit on Jumia ... make it edit live on Jumia".
  { slash: "edit",       aliases: ["change"], title: "Edit live on Jumia", hint: "Stock, price, a sale, ON or OFF: say which product and what", fill: "Change ", example: "Change the price of the gold medal to 500" },
  { slash: "credits",    title: "My credits",         hint: "Your balance",                              send: "credits" },
  { slash: "status",     title: "Where am I",         hint: "Your batch and what's next",                send: "status" },
  { slash: "restart",    title: "Restart",            hint: "Start a new batch",                         send: "restart" },
  { slash: "help",       title: "How it works",       hint: "Listing step by step",                      send: "how it works" },
  { slash: "clear",      title: "Clear chat",         hint: "Start fresh, like the first time",          action: "clear" },
  { slash: "disconnect", title: "Disconnect Jumia",   hint: "Asks you to confirm first",                 send: "disconnect" },
];

const named = (c: PaletteCommand, name: string) => c.slash === name || (c.aliases ?? []).includes(name);

/** The commands a "/..." being typed could mean, in menu order. */
export function matchingCommands(typed: string): PaletteCommand[] {
  const q = typed.replace(/^\//, "").trim().toLowerCase().split(/\s+/)[0] ?? "";
  if (!q) return PALETTE;
  return PALETTE.filter((c) =>
    [c.slash, ...(c.aliases ?? [])].some((s) => s.startsWith(q)) || c.title.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)));
}

/** The command a typed "/name ..." names, if any. */
export function slashCommand(typed: string): PaletteCommand | null {
  const m = typed.trim().match(/^\/(\S+)/);
  return m ? PALETTE.find((c) => named(c, m[1].toLowerCase())) ?? null : null;
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
  const cmd = PALETTE.find((c) => named(c, name.toLowerCase()));
  if (!cmd) return `${name} ${rest}`.trim();
  if (cmd.fill) return `${cmd.fill}${rest}`.trim();
  if (cmd.action) return "";
  return rest ? `${cmd.send} ${rest}`.trim() : cmd.send ?? name;
}

/**
 * A command's start sent with nothing after it ("Change"): the bot can't
 * tell what's meant (owner's test, 2026-10-07: a bare "Change"
 * was read as restarting). The page says what to add instead of sending.
 */
export function unfinishedFill(text: string): PaletteCommand | null {
  const t = text.trim().toLowerCase();
  return PALETTE.find((c) => c.fill && c.example && c.fill.trim().toLowerCase() === t) ?? null;
}
