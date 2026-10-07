/**
 * The WhatsApp assistant: free text understood by AI, carried out by our
 * own code (owner, 2026-10-06; piloted on admin accounts and the user ids
 * in app_settings `assistant_users`).
 *
 * The owner's spec: "we will maintain the way the images are sent ... but
 * anything else can be a conversation where the intent of the user is
 * understood and the AI executes the right code", and "the current flow
 * will be maintained and the conversational flow will only come to play if
 * users try to talk to it like they did not know the current flow". So:
 *
 *   - Never while photos are being collected: there, text is a product's
 *     notes, as it always was.
 *   - Only for text the usual flow doesn't recognise. The buttons, "submit
 *     all", a product number, the answer to a question the bot asked, and
 *     a plain "2: price 150" all work as before (lib/whatsapp/intake.ts).
 *   - The AI only picks an action (interpret): our code checks every part
 *     of it and does the work, with the same rules as the rest of the bot.
 *     Every price, quantity and word it sets must be in the seller's own
 *     message (a variation may also be one of the category's options, so
 *     "Large" can become "L"), and a price under Jumia's minimum is refused.
 *   - When a change could be about more than one product ("change the
 *     quantity of the fridge to 20" with two fridges), it asks which,
 *     and the tap or the number applies it (answerPendingQuestion).
 *   - Submitting and starting over are offered as a button to tap, never
 *     done on the AI's word alone.
 *   - Anything else gets the AI's own reply, not a set message (owner,
 *     2026-10-06): what it can do for this seller (from capabilities() and
 *     their pack, credits and country), an answer to a question about
 *     Jumia or PandaWorld, or "I don't understand that, try something
 *     different" for what's outside them. It ends by asking what they'd like
 *     to do for their shop. Links come only from assistantLinks, as a
 *     button; a web address it writes itself is removed. The fixed flow
 *     starts only when the seller says they want to list.
 *
 * Every message it reads goes in whatsapp_assistant_log with what it made
 * of it, to see where it misunderstands. Calls are counted in ai_usage as
 * the "assistant" feature.
 */

import { createServerClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/is-admin";
import { callGeminiBackend } from "@/lib/ai/gemini-client";
import { withAiUsageContext } from "@/lib/ai/usage";
import { availableCredits, isUnmetered } from "@/lib/billing/extension-credits";
import { LIVE_LISTING_CREDIT_COST } from "@/lib/billing/credit-packs";
import { creditReach } from "@/lib/billing/credit-status";
import { checkRestrictedBrand } from "@/lib/jumia/prohibited-catalog";
import { priceMinimumForUser, isBelowMinimum, money } from "@/lib/jumia/price-minimums";
import {
  sendButtonsIfConfigured, sendCtaUrlIfConfigured, sendListIfConfigured, sendTextIfConfigured,
} from "@/lib/whatsapp/client";
import {
  COUNT_QUICK_PICKS, MAX_BATCH_SIZE, buyCreditsUrl, extractSalePrice, focusedEditorUrl, whatsappListingsUrl,
} from "@/lib/whatsapp/batch";
import { helpMessage } from "@/lib/whatsapp/onboarding";
import { appUrl } from "@/lib/whatsapp/app-url";
import { CHROME_WEB_STORE_URL } from "@/lib/constants/support";
import { jumiaCountryByCode } from "@/lib/marketing/countries";
import { sellerCountry } from "@/lib/jumia/unlistable-categories";
import { currentPack, featureAccess, featureMinPackName, type FeatureId } from "@/lib/billing/features";
import { answerOrderStatus, answerPayouts, answerProducts, answerSales, answerStock, proposeLiveChange } from "@/lib/whatsapp/shop";
import type { LiveChange } from "@/lib/jumia/shop";
import { INTERACTIVE_BODY_MAX, splitForText } from "@/lib/whatsapp/text-limits";
import { handleOrderMessage } from "@/lib/whatsapp/orders";
import { updateSession, type AssistantPending, type WhatsAppSession } from "@/lib/whatsapp/session";
import { parseVariations, saveVariations, variationOptions } from "@/lib/whatsapp/variation-question";
import { carryPriceToVariants, carryStockToVariants, chatPrice, shopCurrencyForUser } from "@/lib/whatsapp/listing-edits";
import type { ListingRow } from "@/lib/supabase/types";

/** Small and quick, like the review step's older fallback (lib/whatsapp/intent.ts). */
export const ASSISTANT_MODEL = "gemini-2.5-flash-lite";

/** A "which product?" question older than this is no longer an answer's target. */
const PENDING_TTL_MS = 30 * 60_000;

/** Statuses a product can still be changed in chat: not sent yet, or held. */
const EDITABLE = new Set(["draft", "awaiting_review", "failed"]);

// ─── Who has it ───────────────────────────────────────────────────────────

/**
 * The pilot: admins, and the user ids in app_settings `assistant_users`.
 * `["*"]` there switches it on for every seller.
 */
export async function assistantEnabled(userId: string): Promise<boolean> {
  if (isAdmin(userId)) return true;
  try {
    const { data } = await createServerClient().from("app_settings").select("value").eq("key", "assistant_users").maybeSingle();
    const ids = data?.value;
    return Array.isArray(ids) && (ids.includes("*") || ids.includes(userId));
  } catch {
    return false;
  }
}

// ─── What the AI is told ──────────────────────────────────────────────────

/**
 * Where the seller is. review: drafts waiting to be submitted. sent: the
 * whole batch just went to Jumia. idle: between batches.
 */
export type Stage = "review" | "sent" | "idle";

export interface ProductFacts {
  seq:        number;
  listing:    ListingRow;
  variations: string[];
  /** The category's variation options (sizes, capacities...), empty when it takes any text. */
  options:    string[];
}

/** A change to one product, as checked: only what the seller asked for. */
export interface Changes {
  price?:      number;
  quantity?:   number;
  /** The full list the product should have afterwards, in the seller's words or the category's options. */
  variations?: string[];
  title?:      string;
  brand?:      string;
  color?:      string;
  /** A sale price: read from the message itself, with its dates (extractSalePrice). */
  sale?:       boolean;
  /** Something they want changed that chat can't change: sent to the editor. */
  other?:      string;
}

export interface EditPart {
  seqs:    number[];
  changes: Changes;
  /** The seller's words could mean any of `seqs`: asked which. */
  ask:     boolean;
}

export type AssistantAction =
  | { type: "edit"; edits: EditPart[]; dropped: string[] }
  | { type: "submit"; seqs: number[] | "all" }
  | { type: "list"; count: number }
  | { type: "restart" }
  | { type: "review" }
  | { type: "orders" }
  | { type: "credits" }
  | { type: "help" }
  | { type: "reply"; text: string; link: string | null }
  | { type: "live_change"; product: string; change: LiveChange }
  | { type: "stock"; product: string | null; filter: "out" | "low" | null }
  | { type: "shop"; filter: "all" | "inactive" | "rejected" }
  | { type: "order_status"; number: string }
  | { type: "sales"; period: "today" | "week" | "month" }
  | { type: "payouts" }
  | { type: "unclear" };

const STATUS_WORDS: Record<string, string> = {
  draft:            "draft, not sent yet",
  awaiting_review:  "draft, not sent yet",
  failed:           "held, not sent",
  processing:       "sent, with Jumia",
  pending_approval: "sent, waiting for Jumia's review",
  live:             "live on Jumia",
};

function productLine(p: ProductFacts, currency: string): string {
  const l = p.listing;
  const parts = [
    `${p.seq}. "${l.title ?? "(no name yet)"}" (${STATUS_WORDS[l.status] ?? l.status})`,
    `price ${l.selling_price != null ? `${currency} ${l.selling_price}` : "not set"}`,
    `quantity ${l.quantity ?? "not set"}`,
    l.brand ? `brand ${l.brand}` : null,
    l.color ? `colour ${l.color}` : null,
    l.category_path ? `category ${l.category_path.split(">").pop()!.trim()}` : null,
    `variation(s): ${p.variations.length > 0 ? p.variations.join(", ") : "none"}`,
    p.options.length > 0
      ? `its category's variation options: ${p.options.slice(0, 40).join(", ")}${p.options.length > 40 ? ", ..." : ""}`
      : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

const STAGE_TEXT: Record<Stage, string> = {
  review: "The products below are drafted and waiting for the seller to check them and submit them to Jumia.",
  sent:   "The seller has just submitted the products below to Jumia. They're no longer drafts: once live, their stock, price, sale and on/off can be changed with live_change; anything else in Jumia Vendor Center.",
  idle:   "The seller is between batches: no products are being listed right now. To start, they say how many products they're listing.",
};

/**
 * What PandaWorld does, for the AI's replies: every line is something the
 * code does (lib/whatsapp/intake.ts, orders.ts, credit-gate.ts, the
 * extension), so the AI never promises what isn't there.
 */
function capabilities(): string {
  return [
    `- List products on Jumia from WhatsApp: the seller says how many (1 to ${MAX_BATCH_SIZE}), sends each product's photos with the price and notes as the caption, and AI drafts each listing (name, description, category, details) for them to check and submit. Two ways to send: all at once, or guided step by step.`,
    "- Ask for what Jumia needs that the photos don't show: a missing price, weight or other required detail, the variation, the category when unsure.",
    "- Edit drafts in chat before they're submitted: price, quantity, variations or sizes, name, brand, colour, a sale price with its dates. Anything else in the editor on the review page.",
    "- Submit to Jumia and report back when each product goes live or is rejected; fix common rejections itself (banned words, restricted brands) and guide the seller through the rest with Fix & resubmit (QC fixes: Standard pack and up).",
    "- Orders on WhatsApp (Pro pack and up): alerts for new Jumia orders, grouped and quiet at night; \"orders\" shows orders waiting to be packed; pack them and get the shipping label PDF, mark them ready to ship, or cancel; where any order is, by its number; orders and sales for today, the week or the month; a message when orders are delivered, returned, fail delivery or are cancelled.",
    "- Their live Jumia products (Pro pack and up), found by name among everything in their shop: change a product's stock, price, a sale price with its dates, or turn it on or off, with one tap to confirm; how many are left; what's out of stock or low; which products are turned off or rejected by Jumia's quality check; a low-stock warning with new orders.",
    "- Payouts (Pro pack and up): the last Jumia payout and the statement not yet paid; a message when Jumia pays.",
    `- Credits: tell the balance; a WhatsApp listing costs ${LIVE_LISTING_CREDIT_COST} credits, charged only when it goes live on Jumia; warn when running low. Credits are bought on the dashboard.`,
    "- The PandaWorld Chrome extension fills Jumia's Vendor Center product form on a laptop; image polish and a fee calculator in it on Pro.",
    "- A free Jumia price calculator, Jumia commission rates, how-to guides and an FAQ on the website.",
    "- Words the bot always knows: \"status\" (where they are), \"restart\", \"help\", \"orders\", \"disconnect\" (Jumia).",
    "- Other changes to products already on Jumia (name, photos, description, category) are made in Jumia Vendor Center.",
  ].join("\n");
}

/** A page the assistant can send as a button. */
export interface AssistantLink { label: string; url: string; what: string }

/**
 * The only links the assistant sends ("send me the link to your home
 * page", owner 2026-10-06). It picks one by key and the seller gets a
 * button; a web address it writes itself is removed (cleanReply).
 */
export function assistantLinks(opts: { batchId?: string | null; countrySlug?: string | null } = {}): Record<string, AssistantLink> {
  const base = appUrl();
  return {
    home:            { label: "Home page",         url: `${base}/`, what: "PandaWorld's home page" },
    pricing:         { label: "Credit packs",      url: `${base}/pricing`, what: "credit packs and what each one includes" },
    dashboard:       { label: "Dashboard",         url: buyCreditsUrl(), what: "their dashboard: credits, buying credits, notices" },
    listings:        { label: "My listings",       url: `${base}/extension/listings`, what: "all their PandaWorld listings" },
    review:          { label: "Review listings",   url: whatsappListingsUrl(opts.batchId ?? undefined), what: opts.batchId ? "this batch's drafts, to check and edit" : "their WhatsApp drafts" },
    settings:        { label: "Settings",          url: `${base}/extension/settings`, what: "account settings, the Jumia connection" },
    faq:             { label: "FAQ",               url: `${base}/faq`, what: "frequently asked questions" },
    guides:          { label: "How-to guides",     url: `${base}/how-to`, what: "all the step-by-step guides" },
    guide_whatsapp:  { label: "WhatsApp guide",    url: `${base}/how-to/list-on-jumia-from-whatsapp`, what: "how to list from WhatsApp, with an example" },
    guide_connect:   { label: "Connect guide",     url: `${base}/how-to/connect-jumia-vendor-center`, what: "how to connect Jumia Vendor Center" },
    guide_extension: { label: "Extension guide",   url: `${base}/how-to/chrome-extension-autofill`, what: "how to list from a laptop with the extension" },
    extension:       { label: "Get the extension", url: CHROME_WEB_STORE_URL, what: "the PandaWorld Chrome extension on the Chrome Web Store" },
    calculator:      { label: "Price calculator",  url: `${base}/jumia-price-calculator`, what: "Jumia selling price and fee calculator" },
    commission:      { label: "Commission rates",  url: `${base}/jumia-commission-rates`, what: "Jumia's commission rates by category" },
    ...(opts.countrySlug ? { country: { label: "Selling on Jumia", url: `${base}/sell-on-jumia/${opts.countrySlug}`, what: "selling on Jumia in their country" } } : {}),
    vendor_center:   { label: "Vendor Center",     url: "https://vendorcenter.jumia.com", what: "Jumia Vendor Center, where products already with Jumia are changed" },
    privacy:         { label: "Privacy policy",    url: `${base}/privacy`, what: "privacy policy" },
    terms:           { label: "Terms",             url: `${base}/terms`, what: "terms of service" },
  };
}

/** What's true for this seller: their pack, what it gives them, their credits and country. Best-effort. */
export async function sellerFacts(userId: string): Promise<{ lines: string[]; countrySlug: string | null }> {
  const lines: string[] = [];
  let countrySlug: string | null = null;
  try {
    const country = jumiaCountryByCode(await sellerCountry(userId).catch(() => null));
    if (country) { lines.push(`- Country: ${country.name}`); countrySlug = country.slug; }
    if (await isUnmetered(userId)) {
      lines.push("- Not charged credits: every feature is on for them.");
      return { lines, countrySlug };
    }
    const pack = await currentPack(userId).catch(() => null);
    lines.push(pack ? `- Pack: ${capitalise(pack.id)} (the last one they bought)` : "- No pack bought yet: on their free sign-up credits.");
    const access = async (f: FeatureId) => {
      const a = await featureAccess(userId, f).catch(() => ({ ok: false as const, blockedBy: "pack" as const }));
      return a.ok ? "on" : a.blockedBy === "credits" ? "paused until they buy credits" : `not on their pack (${featureMinPackName(f)} and up)`;
    };
    lines.push(`- Orders and shipping labels on WhatsApp: ${await access("shipping_labels")}`);
    lines.push(`- Live products, stock and payouts on WhatsApp: ${await access("shop_whatsapp")}`);
    lines.push(`- QC rejection fixes: ${await access("qc_fix")}`);
    const credits = Math.max(0, Math.round((await availableCredits(userId)) * 100) / 100);
    lines.push(`- Credits: ${credits} available, ${creditReach(credits)}`);
  } catch (e) {
    console.warn(`[assistant] seller facts for ${userId}: ${(e as Error).message}`);
  }
  return { lines, countrySlug };
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export interface PromptContext {
  products: ProductFacts[];
  currency: string;
  seller:   string[];
  links:    Record<string, AssistantLink>;
  hintSeq?: number;
}

export function buildPrompt(stage: Stage, message: string, ctx: PromptContext): string {
  const { products, currency, seller, links, hintSeq } = ctx;
  return [
    "You are PandaWorld's assistant on WhatsApp. PandaWorld lists sellers' products on Jumia (Africa's online marketplace) and helps them run their Jumia shop.",
    "You choose ONE action as JSON, and PandaWorld's code checks it and carries it out.",
    "",
    `Where the seller is: ${STAGE_TEXT[stage]}`,
    ...(products.length > 0 ? ["", "Products (the number is the product number):", ...products.map((p) => productLine(p, currency))] : []),
    ...(seller.length > 0 ? ["", "About this seller:", ...seller] : []),
    "",
    "What PandaWorld can do (all true; never claim anything else):",
    capabilities(),
    "",
    "Links you can send (put the key in \"link\"; the seller gets a button):",
    ...Object.entries(links).map(([key, l]) => `- ${key}: ${l.what}`),
    "",
    `The seller's message: "${message.replace(/"/g, "'").slice(0, 600)}"`,
    ...(hintSeq != null ? [`(They started it with product number ${hintSeq}.)`] : []),
    "",
    "Reply with ONLY one JSON object, no markdown, one of:",
    '{"type":"edit","edits":[{"products":[<numbers>],"changes":{...},"ask":false}]} - change products. One entry per different change.',
    '  "changes" holds ONLY what the seller asked to change: "price" (number), "quantity" (whole number), "variations" (the full list',
    '  the product should have afterwards: the seller\'s words for each, plus its current ones if they are adding), "title", "brand", "color"',
    '  (text copied exactly from the message), "sale": true (a sale or discount price), "other": "<the field>" (anything else they want changed).',
    "  Every number and word must come from the seller's message. Never guess or invent a value.",
    '  "products": the products the seller means, found from the product number or from how they describe it ("the fridge" = the',
    "  product whose name is a fridge). Several if they say all, both or each.",
    '  "ask": true when the change is clear but their words fit more than one product and they did not say all of them: then "products"',
    "  lists every product it could be. With one product only, it is that one.",
    '{"type":"submit","products":"all" or [<numbers>]} - send drafts to Jumia',
    '{"type":"list","count":<number>} - the seller wants to list new products now and says how many. Add up kinds:',
    '  "2 shirts and a fridge" is 3. Without a number, use restart.',
    '{"type":"restart"} - they want to list something (no number given), start a new batch, or start over',
    '{"type":"review"} - see or open their drafts or listings',
    '{"type":"orders"} - their Jumia orders waiting to be packed',
    '{"type":"live_change","product":"<the seller\'s words for the product>","stock":<number>} - change a product already live on Jumia',
    '  (never one of the drafts above). Instead of "stock", exactly one of: "price":<number>, "sale":true (a sale price with its',
    '  dates, read from the message), "sale":"end" (end its sale), "active":true or false (turn it on or off). Values from the message only.',
    '{"type":"stock","product":"<their words>" or null,"filter":"out" or "low" or null} - how many are left of a product, or what is out of stock or low',
    '{"type":"shop","filter":"all" or "inactive" or "rejected"} - their Jumia products: an overview, the ones turned off, or the ones rejected',
    '{"type":"order_status","number":"<the order number from the message>"} - where one order is',
    '{"type":"sales","period":"today" or "week" or "month"} - how many orders or sales they had',
    '{"type":"payouts"} - money from Jumia: the last payout, what\'s not paid yet, statements',
    '{"type":"credits"} - their credit balance (sent with a Buy credits button)',
    '{"type":"reply","text":"<your message>","link":"<a key above, or null>"} - everything else. You write the message:',
    "  - Greetings, thanks, small talk, \"what can you do\", or something you can't match: in your own words (vary it, never a set",
    "    script), greet them back if they greeted, give a short numbered list of what you can do for them, tailored to their pack",
    "    (say when a feature needs a pack they don't have), and end by asking what they'd like to do for their Jumia shop.",
    "  - A question about selling on Jumia, their shop or PandaWorld: answer it from what's above. Don't state fees, commission",
    "    rates, prices, dates or Jumia rules that aren't given above: send the link that has them instead.",
    "  - A request for a page or link: one short line, with \"link\" set. Never write a web address in the text.",
    "  - Anything outside Jumia, their shop and PandaWorld, or something PandaWorld can't do: say plainly that you don't understand",
    "    that or can't help with it, suggest something you can do, and ask them to try something different.",
    "  Write for WhatsApp: short and warm, at most 600 characters, *bold* with single asterisks, numbered lists as \"1.\" lines.",
    "  Reply in the language the seller wrote in.",
  ].join("\n");
}

// ─── Checking what the AI said ────────────────────────────────────────────

/** Every number written in the message: "1,500" is 1500, "2k" is 2000 (and 2). */
export function messageNumbers(text: string): number[] {
  const out: number[] = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = parseFloat(m[1].replace(/,(?=\d{3}\b)/g, ""));
    if (!Number.isFinite(n)) continue;
    out.push(n);
    if (m[2]) out.push(n * 1000);
  }
  return out;
}

const squashSpaces = (s: string) => s.toLowerCase().replace(/[\s"'“”‘’]+/g, " ").trim();

/** Whether `value` is written in the message (any case, any spacing). */
export function saidInMessage(value: string, message: string): boolean {
  const v = squashSpaces(value);
  return v.length > 0 && squashSpaces(message).includes(v);
}

/** Whether `word` is a whole word of the message ("L" is not in "Large"). */
function wordInMessage(word: string, message: string): boolean {
  const w = word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return w.length > 0 && new RegExp(`(^|[^\\p{L}\\p{N}])${w}($|[^\\p{L}\\p{N}])`, "iu").test(message);
}

/**
 * The changes, keeping only what the message backs up. `dropped` names
 * what the AI gave that the message doesn't say, so the seller can be
 * asked to say it plainly.
 */
export function verifyChanges(
  raw: unknown,
  message: string,
  known: { options: string[]; variations: string[] },
): { changes: Changes; dropped: string[] } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const changes: Changes = {};
  const dropped: string[] = [];
  const numbers = messageNumbers(message);
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? parseFloat(v.replace(/,/g, "")) : NaN);

  if (r.price != null) {
    const n = num(r.price);
    if (n > 0 && numbers.includes(n)) changes.price = n; else dropped.push("price");
  }
  if (r.quantity != null) {
    const n = num(r.quantity);
    if (Number.isInteger(n) && n > 0 && numbers.includes(n)) changes.quantity = n; else dropped.push("quantity");
  }
  if (Array.isArray(r.variations)) {
    const words = r.variations.filter((v): v is string => typeof v === "string").map((v) => v.trim().slice(0, 60)).filter(Boolean);
    const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());
    const backed = words.filter((w) =>
      wordInMessage(w, message) || lower(known.options).includes(w.toLowerCase()) || lower(known.variations).includes(w.toLowerCase()));
    // One the message doesn't back is never quietly left out of the list:
    // the product would lose a variation nobody asked to remove.
    if (backed.length > 0 && backed.length === words.length) changes.variations = Array.from(new Set(backed));
    else if (words.length > 0) dropped.push("variations");
  }
  for (const key of ["title", "brand", "color"] as const) {
    const v = r[key];
    if (typeof v !== "string" || !v.trim()) continue;
    if (saidInMessage(v, message)) changes[key] = v.trim().replace(/\s+/g, " ");
    else dropped.push(key === "title" ? "name" : key === "color" ? "colour" : key);
  }
  if (r.sale === true) changes.sale = true;
  if (typeof r.other === "string" && r.other.trim()) changes.other = r.other.trim().slice(0, 60);
  return { changes, dropped };
}

const hasChanges = (c: Changes) => Object.keys(c).length > 0;

const COUNT_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};

/**
 * Whether the message gives this many products: the number is in it (as
 * digits or a word), or its numbers add up to it, counting "a"/"an" as
 * one ("2 shirts and a fridge" is 3).
 */
export function countBacked(count: number, message: string): boolean {
  const lower = message.toLowerCase();
  const words = (lower.match(/[a-z]+/g) ?? []).filter((w) => w in COUNT_WORDS).map((w) => COUNT_WORDS[w]);
  const values = [...messageNumbers(message).filter((n) => Number.isInteger(n)), ...words];
  if (values.includes(count)) return true;
  const sum = values.reduce((a, b) => a + b, 0);
  const articles = (lower.match(/\b(?:an?|another)\s+(?!few\b|lot\b|bit\b|couple\b|number\b)[a-z]/g) ?? []).length;
  return values.length + articles >= 1 && (sum === count || sum + articles === count);
}

/**
 * The AI's own message, made safe to send: any web address that isn't one
 * of our links is removed (it could be made up), and it's cut to fit a
 * WhatsApp message with a button.
 */
export function cleanReply(text: string, links: Record<string, AssistantLink>): string {
  const allowed = new Set(Object.values(links).map((l) => l.url.replace(/\/$/, "")));
  const cleaned = text
    .replace(/\b(?:https?:\/\/|www\.)[^\s)]+/gi, (u) => {
      const bare = u.replace(/[.,!?;:]+$/, "");
      return allowed.has(bare.replace(/\/$/, "")) ? u : "";
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,!?])/g, "$1")
    .trim();
  return cleaned.length > 900 ? `${cleaned.slice(0, 899).replace(/\s+\S*$/, "")}…` : cleaned;
}

/** Whether the seller's message names the product: at least one of its words is in it. */
export function productBacked(product: string, message: string): boolean {
  const said = new Set(message.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2));
  return product.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length >= 2 && (said.has(w) || said.has(w.replace(/s$/, "")) || said.has(`${w}s`)));
}

/** The AI's reply as an action our code can carry out, or unclear. */
export function parseAction(
  raw: string, message: string, products: ProductFacts[], links: Record<string, AssistantLink> = {}, currency = "GHS",
): AssistantAction {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { type: "unclear" };
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(match[0]) as Record<string, unknown>; } catch { return { type: "unclear" }; }

  const known = new Set(products.map((p) => p.seq));
  const seqsOf = (v: unknown): number[] =>
    Array.isArray(v) ? Array.from(new Set(v.map(Number).filter((n) => known.has(n)))) : [];

  switch (parsed.type) {
    case "restart": case "review": case "orders": case "credits": case "help":
      return { type: parsed.type as "restart" | "review" | "orders" | "credits" | "help" };
    case "reply":
    case "answer": {
      const link = typeof parsed.link === "string" && parsed.link in links ? parsed.link : null;
      const text = typeof parsed.text === "string" ? cleanReply(parsed.text, links) : "";
      if (!text) return link ? { type: "reply", text: `Here's the ${links[link].label.toLowerCase()}:`, link } : { type: "unclear" };
      return { type: "reply", text, link };
    }
    case "live_change": {
      const product = typeof parsed.product === "string" ? parsed.product.trim().slice(0, 120) : "";
      if (!product || !productBacked(product, message)) return { type: "unclear" };
      const numbers = messageNumbers(message);
      if (parsed.stock != null) {
        const n = Number(parsed.stock);
        const outWords = /\b(out of stock|sold out|none left|finished|no more)\b/i.test(message);
        return Number.isInteger(n) && n >= 0 && (numbers.includes(n) || (n === 0 && outWords))
          ? { type: "live_change", product, change: { kind: "stock", stock: n } } : { type: "unclear" };
      }
      if (parsed.price != null) {
        const n = Number(parsed.price);
        return n > 0 && numbers.includes(n) ? { type: "live_change", product, change: { kind: "price", price: n } } : { type: "unclear" };
      }
      if (parsed.sale === "end") return { type: "live_change", product, change: { kind: "sale", sale: null } };
      if (parsed.sale === true) {
        const sale = extractSalePrice(message, new Date(), currency);
        if (sale?.startDate && sale.endDate) {
          return { type: "live_change", product, change: { kind: "sale", sale: { price: sale.salePrice, start: sale.startDate, end: sale.endDate } } };
        }
        return { type: "reply", link: null, text: "A sale on Jumia needs its price and both dates in one message, e.g. \"put the fridge on sale at 4000 from 10 Oct to 20 Oct\"." };
      }
      if (typeof parsed.active === "boolean") return { type: "live_change", product, change: { kind: "status", active: parsed.active } };
      return { type: "unclear" };
    }
    case "stock": {
      const product = typeof parsed.product === "string" && parsed.product.trim() && productBacked(parsed.product, message) ? parsed.product.trim().slice(0, 120) : null;
      const filter = parsed.filter === "out" || parsed.filter === "low" ? parsed.filter : null;
      return { type: "stock", product, filter };
    }
    case "shop":
      return { type: "shop", filter: parsed.filter === "inactive" || parsed.filter === "rejected" ? parsed.filter : "all" };
    case "order_status": {
      const number = String(parsed.number ?? "").replace(/\D/g, "");
      return number.length >= 5 && message.replace(/\D/g, " ").split(/\s+/).includes(number)
        ? { type: "order_status", number } : { type: "unclear" };
    }
    case "sales":
      return { type: "sales", period: parsed.period === "today" || parsed.period === "month" ? parsed.period : "week" };
    case "payouts":
      return { type: "payouts" };
    case "list": {
      const count = Number(parsed.count);
      return Number.isInteger(count) && count >= 1 && countBacked(count, message) ? { type: "list", count } : { type: "unclear" };
    }
    case "submit": {
      if (parsed.products === "all") return { type: "submit", seqs: "all" };
      const seqs = seqsOf(parsed.products);
      return seqs.length > 0 ? { type: "submit", seqs: seqs.sort((a, b) => a - b) } : { type: "unclear" };
    }
    case "edit": {
      if (products.length === 0 || !Array.isArray(parsed.edits)) return { type: "unclear" };
      const edits: EditPart[] = [];
      const dropped = new Set<string>();
      for (const e of parsed.edits as Record<string, unknown>[]) {
        if (!e || typeof e !== "object") continue;
        let seqs = seqsOf(e.products);
        // Nothing named: the only product, or any of them.
        if (seqs.length === 0) seqs = products.map((p) => p.seq);
        const of = products.filter((p) => seqs.includes(p.seq));
        const { changes, dropped: d } = verifyChanges(e.changes, message, {
          options:    of.flatMap((p) => p.options),
          variations: of.flatMap((p) => p.variations),
        });
        d.forEach((x) => dropped.add(x));
        if (!hasChanges(changes)) continue;
        const ask = seqs.length > 1 && (e.ask === true || seqsOf(e.products).length === 0);
        edits.push({ seqs: seqs.sort((a, b) => a - b), changes, ask });
      }
      return edits.length > 0 || dropped.size > 0 ? { type: "edit", edits, dropped: Array.from(dropped) } : { type: "unclear" };
    }
    default:
      return { type: "unclear" };
  }
}

// ─── Reading the products ─────────────────────────────────────────────────

async function batchListings(batchId: string, userId: string): Promise<ListingRow[]> {
  const { data, error } = await createServerClient()
    .from("listings")
    .select("*")
    .eq("whatsapp_batch_id", batchId)
    .eq("user_id", userId)
    .order("whatsapp_seq", { ascending: true });
  if (error) console.warn(`[assistant] loading batch ${batchId} failed: ${error.message}`);
  return ((data ?? []) as ListingRow[]).sort((a, b) => (a.whatsapp_seq ?? 0) - (b.whatsapp_seq ?? 0));
}

export async function productFacts(listings: ListingRow[]): Promise<ProductFacts[]> {
  if (listings.length === 0) return [];
  const { data } = await createServerClient()
    .from("variants")
    .select("listing_id, variation")
    .in("listing_id", listings.map((l) => l.id));
  const byListing = new Map<string, string[]>();
  for (const v of (data ?? []) as { listing_id: string; variation: string | null }[]) {
    if (!v.variation?.trim() || v.variation === "...") continue;
    byListing.set(v.listing_id, [...(byListing.get(v.listing_id) ?? []), v.variation.trim()]);
  }
  return Promise.all(listings.map(async (l, i) => ({
    seq:        l.whatsapp_seq ?? i + 1,
    listing:    l,
    variations: byListing.get(l.id) ?? [],
    options:    await variationOptions(Number(l.category_code)).catch(() => [] as string[]),
  })));
}

// ─── Asking the AI ────────────────────────────────────────────────────────

export async function interpret(
  userId: string,
  stage: Stage,
  products: ProductFacts[],
  message: string,
  opts: { batchId?: string | null; hintSeq?: number } = {},
): Promise<{ action: AssistantAction; links: Record<string, AssistantLink> }> {
  const [currency, seller] = await Promise.all([shopCurrencyForUser(userId), sellerFacts(userId)]);
  const links = assistantLinks({ batchId: opts.batchId, countrySlug: seller.countrySlug });
  const prompt = buildPrompt(stage, message, { products, currency, seller: seller.lines, links, hintSeq: opts.hintSeq });
  const { text } = await withAiUsageContext({ feature: "assistant", userId }, () =>
    callGeminiBackend(ASSISTANT_MODEL, [{ text: prompt }]));
  return { action: parseAction(text, message, products, links, currency), links };
}

// ─── Carrying it out ──────────────────────────────────────────────────────

/** "quantity 20", "variation L", for the reply and the "which?" question. */
function describeChanges(c: Changes): string {
  return [
    c.price != null ? `price ${c.price}` : null,
    c.quantity != null ? `quantity ${c.quantity}` : null,
    c.variations ? `variation${c.variations.length > 1 ? "s" : ""} ${c.variations.join(", ")}` : null,
    c.title ? `name "${c.title}"` : null,
    c.brand ? `brand ${c.brand}` : null,
    c.color ? `colour ${c.color}` : null,
    c.sale ? "sale price" : null,
  ].filter(Boolean).join(", ");
}

export interface ApplyResult { done: string[]; problems: string[]; editor: boolean }

/** One product's changes, with the same rules as the rest of the bot. */
export async function applyChanges(userId: string, listing: ListingRow, changes: Changes, message: string): Promise<ApplyResult> {
  const result: ApplyResult = { done: [], problems: [], editor: false };
  if (!EDITABLE.has(listing.status)) {
    result.problems.push("it's already with Jumia, so it's changed in Jumia Vendor Center");
    return result;
  }

  const update: Record<string, unknown> = {};
  const sources = { ...((listing.field_sources as Record<string, string> | null) ?? {}) };

  if (changes.price != null) {
    const minimum = await priceMinimumForUser(userId);
    if (isBelowMinimum(changes.price, minimum)) {
      result.problems.push(`${money(changes.price, minimum.currency)} is below the lowest price Jumia allows (${money(minimum.min, minimum.currency)}), so the price stays as it was`);
    } else {
      update.selling_price = changes.price;
      result.done.push(`price ${await chatPrice(userId, changes.price)}`);
    }
  }
  if (changes.quantity != null) {
    update.quantity = changes.quantity;
    result.done.push(`quantity ${changes.quantity}`);
  }
  if (changes.title) {
    if (changes.title.length < 15) result.problems.push(`Jumia needs a name of at least 15 characters, and "${changes.title}" has ${changes.title.length}`);
    else { update.title = changes.title.slice(0, 255); sources.title = "user"; result.done.push(`name "${changes.title}"`); }
  }
  if (changes.brand) {
    if (checkRestrictedBrand(changes.brand, listing.category_path).status === "forbidden") {
      result.problems.push(`Jumia doesn't allow the brand ${changes.brand} in this category`);
    } else {
      update.brand = changes.brand.slice(0, 100); sources.brand = "user"; result.done.push(`brand ${changes.brand}`);
    }
  }
  if (changes.color) {
    update.color = changes.color.slice(0, 60); sources.color = "user"; result.done.push(`colour ${changes.color}`);
  }
  if (changes.sale) {
    // Jumia needs the sale price and both dates together, as in handleEdit.
    const sale = extractSalePrice(message, new Date(), await shopCurrencyForUser(userId));
    if (sale && sale.startDate && sale.endDate) {
      update.sale_price = sale.salePrice; update.sale_start_date = sale.startDate; update.sale_end_date = sale.endDate;
      result.done.push(`sale price ${await chatPrice(userId, sale.salePrice)} from ${sale.startDate} to ${sale.endDate}`);
    } else {
      result.problems.push(sale
        ? "a sale price needs its start and end dates with it, e.g. \"sale 80 from 20 Oct to 30 Oct\""
        : "I couldn't read the sale price: send it like \"sale 80 from 20 Oct to 30 Oct\"");
    }
  }

  if (Object.keys(update).length > 0) {
    const { error } = await createServerClient()
      .from("listings")
      .update({ ...update, field_sources: sources, updated_at: new Date().toISOString() })
      .eq("id", listing.id)
      .eq("user_id", userId);
    if (error) {
      console.warn(`[assistant] saving listing ${listing.id} failed: ${error.message}`);
      return { done: [], problems: ["I couldn't save that just now. Send it again in a moment"], editor: false };
    }
    if (update.selling_price != null) await carryPriceToVariants(listing.id, listing.selling_price, changes.price!);
    if (update.quantity != null) {
      const followed = await carryStockToVariants(listing.id, listing.quantity, changes.quantity!);
      if (followed > 1) result.done[result.done.indexOf(`quantity ${changes.quantity}`)] = `quantity ${changes.quantity} for each of its ${followed} variations`;
    }
  }

  // Variations last, so new rows take the price and stock just set.
  if (changes.variations) {
    const options = await variationOptions(Number(listing.category_code)).catch(() => [] as string[]);
    const parsed = parseVariations(options, changes.variations.join(", "));
    if (!parsed.ok) {
      const shown = options.length > 12 ? `${options.slice(0, 12).join(", ")}...` : options.join(", ");
      result.problems.push(`${parsed.unknown.join(", ")} isn't one of this category's options${shown ? ` (${shown})` : ""}`);
    } else if (await saveVariations(listing.id, parsed.values)) {
      result.done.push(`variation${parsed.values.length > 1 ? "s" : ""} ${parsed.values.join(", ")}`);
    } else {
      result.problems.push("I couldn't save the variations just now. Send them again in a moment");
    }
  }

  if (changes.other) {
    result.problems.push(`I can't change the ${changes.other} in chat yet: tap *Edit product*`);
    result.editor = true;
  }
  return result;
}

function productLabel(p: ProductFacts, total: number): string {
  const name = p.listing.title ? ` (${p.listing.title.length > 40 ? `${p.listing.title.slice(0, 39)}…` : p.listing.title})` : "";
  return total > 1 ? `Product ${p.seq}${name}` : (p.listing.title ?? "Your product");
}

/** Apply `changes` to these products; the reply lines and the product to open in the editor, if any. */
async function applyToProducts(
  userId: string, products: ProductFacts[], seqs: number[], changes: Changes, message: string,
): Promise<{ lines: string[]; editorFor: string | null; changed: number }> {
  const lines: string[] = [];
  let editorFor: string | null = null;
  let changed = 0;
  for (const seq of seqs) {
    const p = products.find((x) => x.seq === seq);
    if (!p) continue;
    const r = await applyChanges(userId, p.listing, changes, message);
    const label = productLabel(p, products.length);
    if (r.done.length > 0) { lines.push(`✅ ${label}: ${r.done.join(", ")}.`); changed++; }
    for (const problem of r.problems) lines.push(`⚠️ ${label}: ${problem}.`);
    if (r.editor) editorFor = p.listing.id;
  }
  return { lines, editorFor, changed };
}

const SUBMIT_ALL   = { id: "submit all", title: "Submit all ✅" };
const REVIEW       = { id: "review", title: "Review listings" };
const START_ANOTHER = { id: "start another", title: "Start another ➕" };

/** Over Meta's 1,024 characters an interactive message fails: the lines go first as text. */
async function fitBody(phone: string, lines: string[], short: string): Promise<string> {
  const body = lines.join("\n");
  if (body.length <= INTERACTIVE_BODY_MAX) return body;
  for (const part of splitForText(body)) await sendTextIfConfigured(phone, part);
  return short;
}

async function sendEditReply(phone: string, lines: string[], editorFor: string | null): Promise<void> {
  const body = await fitBody(phone, lines, editorFor ? "For the rest, edit it here:" : "Anything else to change?");
  if (editorFor) await sendCtaUrlIfConfigured(phone, body, "Edit product", focusedEditorUrl(editorFor));
  else await sendButtonsIfConfigured(phone, body, [SUBMIT_ALL, REVIEW]);
}

/** "Which product do you mean?", with the change kept until the answer comes. */
async function askWhich(
  phone: string, batchId: string, products: ProductFacts[], part: EditPart, message: string, lead: string[],
): Promise<void> {
  const candidates = products.filter((p) => part.seqs.includes(p.seq));
  const change = describeChanges(part.changes);
  const pending: AssistantPending = { batchId, seqs: candidates.map((p) => p.seq), changes: part.changes as Record<string, unknown>, message, at: new Date().toISOString() };
  // The other questions' pointers go: a number now answers this one.
  await updateSession(phone, { assistantPending: pending, awaitingPriceFor: null, awaitingValueFor: null });

  const short = (t: string | null) => !t ? "(no name yet)" : t.length > 40 ? `${t.slice(0, 39)}…` : t;
  const question = [
    `Which product do you mean${change ? ` (${change})` : ""}?`,
    ...candidates.map((p) => `${p.seq}. ${short(p.listing.title)}`),
    "",
    "Tap it, or reply with its number.",
  ];
  let body = [...lead, ...(lead.length > 0 ? [""] : []), ...question].join("\n");
  if (body.length > INTERACTIVE_BODY_MAX) {
    // What was changed goes first as text; the question stays with its taps.
    if (lead.length > 0) for (const part of splitForText(lead.join("\n"))) await sendTextIfConfigured(phone, part);
    body = await fitBody(phone, question, `Which product do you mean${change ? ` (${change})` : ""}? Tap it, or reply with its number.`);
  }
  const all = candidates.length === 2 ? "Both" : `All ${candidates.length}`;
  if (candidates.length === 2) {
    await sendButtonsIfConfigured(phone, body, [
      ...candidates.map((p) => ({ id: `apick:${p.seq}`, title: `${p.seq}. ${p.listing.title ?? "Product"}`.slice(0, 20) })),
      { id: "apick:all", title: all },
    ]);
    return;
  }
  const rows = candidates.slice(0, 9).map((p) => ({
    id: `apick:${p.seq}`,
    title: `Product ${p.seq}`,
    description: (p.listing.title ?? "").slice(0, 72) || undefined,
  }));
  await sendListIfConfigured(phone, body, "Choose product", [...rows, { id: "apick:all", title: all }]);
}

async function logTurn(userId: string, stage: Stage, message: string, action: AssistantAction | null, outcome: string): Promise<void> {
  try {
    await createServerClient().from("whatsapp_assistant_log").insert({ user_id: userId, stage, message: message.slice(0, 1000), action, outcome });
  } catch (e) {
    console.warn(`[assistant] log failed: ${(e as Error).message}`);
  }
}

async function creditsReply(userId: string, phone: string): Promise<void> {
  if (await isUnmetered(userId)) {
    await sendTextIfConfigured(phone, "Your account isn't charged credits right now, so list as much as you like.");
    return;
  }
  const available = Math.max(0, await availableCredits(userId));
  const shown = Math.round(available * 100) / 100;
  await sendCtaUrlIfConfigured(
    phone,
    `You have ${shown} credit${shown === 1 ? "" : "s"}: ${creditReach(shown)}. A listing costs ${LIVE_LISTING_CREDIT_COST} credits when it goes live on Jumia.`,
    "Buy credits",
    buyCreditsUrl(),
  );
}

/**
 * handled: the assistant replied. default: nothing it should do here, so
 * the usual reply for this step goes out. failed: the AI couldn't be
 * reached, so the usual handling runs instead. { list }: between batches,
 * the seller wants to list this many products; the caller starts the
 * batch the usual way (credits checked, then the photo flow).
 */
export type AssistantOutcome = "handled" | "default" | "failed" | { list: number };

/**
 * Understand `text` and act on it. `stage` says where the seller is (see
 * Stage); `hintSeq`, the product number they started the message with.
 */
export async function runAssistant(
  userId: string,
  phone: string,
  session: WhatsAppSession,
  text: string,
  stage: Stage,
  hintSeq?: number,
): Promise<AssistantOutcome> {
  // A button id from an older message ("apick:2", "value:3") isn't words to understand.
  if (/^[a-z_]+:\S+$/i.test(text.trim())) return "default";
  const batchId = stage === "review" ? session.batchId : stage === "sent" ? session.lastSubmittedBatchId : null;
  let action: AssistantAction;
  let links: Record<string, AssistantLink>;
  let products: ProductFacts[] = [];
  try {
    products = batchId ? await productFacts(await batchListings(batchId, userId)) : [];
    ({ action, links } = await interpret(userId, stage, products, text, { batchId, hintSeq }));
  } catch (e) {
    console.warn(`[assistant] interpreting for ${userId} failed: ${(e as Error).message}`);
    await logTurn(userId, stage, text, null, `failed: ${(e as Error).message}`);
    return "failed";
  }
  console.info(`[assistant] ${userId} (${stage}): ${action.type}`);

  if (action.type === "list" && stage !== "review") {
    await logTurn(userId, stage, text, action, `list ${action.count}`);
    return { list: action.count };
  }

  const outcome = await carryOut(userId, phone, stage, batchId, products, action, text, links);
  await logTurn(userId, stage, text, action, outcome);
  return outcome === "default" ? "default" : "handled";
}

async function carryOut(
  userId: string, phone: string, stage: Stage, batchId: string | null, products: ProductFacts[], action: AssistantAction, text: string,
  links: Record<string, AssistantLink>,
): Promise<string> {
  switch (action.type) {
    case "edit": {
      if (stage !== "review" || !batchId) return "default";
      const clear = action.edits.filter((e) => !e.ask);
      const ambiguous = action.edits.find((e) => e.ask);
      const lines: string[] = [];
      let editorFor: string | null = null;
      for (const part of clear) {
        const r = await applyToProducts(userId, products, part.seqs, part.changes, text);
        lines.push(...r.lines);
        editorFor = r.editorFor ?? editorFor;
      }
      if (action.dropped.length > 0) {
        lines.push(`⚠️ I couldn't find the ${action.dropped.join(" or ")} in your message: write ${action.dropped.length > 1 ? "them" : "it"} out, e.g. "quantity 20".`);
      }
      if (ambiguous) {
        await askWhich(phone, batchId, products, ambiguous, text, lines);
        return `asked which of ${ambiguous.seqs.join(", ")}`;
      }
      if (lines.length === 0) return "default";
      await sendEditReply(phone, lines, editorFor);
      return lines.join(" | ");
    }
    case "submit": {
      if (stage !== "review") return "default";
      const all = action.seqs === "all" || action.seqs.length === products.length;
      const which = all ? (products.length === 1 ? "your product" : `all ${products.length} products`) : `product${(action.seqs as number[]).length > 1 ? "s" : ""} ${(action.seqs as number[]).join(", ")}`;
      await sendButtonsIfConfigured(phone, `Send ${which} to Jumia?`, [
        { id: all ? "submit all" : `submit ${(action.seqs as number[]).join(" ")}`, title: "Yes, submit ✅" },
        REVIEW,
      ]);
      return "offered submit";
    }
    case "list":   // in review: like starting over, offered as a tap
    case "restart": {
      if (stage === "review") {
        await sendButtonsIfConfigured(phone, "Start a new batch? Drafts you haven't sent stay on your review page.", [START_ANOTHER, REVIEW]);
      } else {
        await sendButtonsIfConfigured(phone, "Let's list! How many products are you listing today?", COUNT_QUICK_PICKS);
      }
      return "offered restart";
    }
    case "review": {
      if (!batchId) return "default";
      await sendCtaUrlIfConfigured(phone, stage === "review" ? "Here's your batch:" : "Here are the products you sent:", "Review listings", whatsappListingsUrl(batchId));
      return "sent review link";
    }
    case "orders":
      return (await handleOrderMessage(userId, phone, "orders")) ? "showed orders" : "default";
    case "credits":
      await creditsReply(userId, phone);
      return "sent credits";
    case "help":
      await sendButtonsIfConfigured(phone, helpMessage(), [
        { id: "status", title: "Status" },
        { id: "restart", title: "Restart 🔄" },
        { id: "disconnect", title: "Disconnect" },
      ]);
      return "sent help";
    case "live_change":
      return proposeLiveChange(userId, phone, action.product, action.change);
    case "stock":
      return answerStock(userId, phone, action.product, action.filter);
    case "shop":
      return answerProducts(userId, phone, action.filter);
    case "order_status":
      return answerOrderStatus(userId, phone, action.number);
    case "sales":
      return answerSales(userId, phone, action.period);
    case "payouts":
      return answerPayouts(userId, phone);
    case "reply": {
      // The AI's own words. With a link, it's the button; in review, the
      // reply keeps the step's own two buttons.
      const link = action.link ? links[action.link] : null;
      if (link) await sendCtaUrlIfConfigured(phone, action.text, link.label, link.url);
      else if (stage === "review") await sendButtonsIfConfigured(phone, action.text, [SUBMIT_ALL, REVIEW]);
      else await sendTextIfConfigured(phone, action.text);
      return link ? `replied with ${action.link}` : "replied";
    }
    case "unclear":
      return "default";
  }
}

/**
 * The answer to askWhich's question: a tap (`apick:2`, `apick:all`), a
 * product number or several, or "both"/"all". False for anything else:
 * the caller drops the question and handles the message as usual.
 */
export async function answerPendingQuestion(
  userId: string, phone: string, session: WhatsAppSession, text: string,
): Promise<boolean> {
  const pending = session.assistantPending;
  if (!pending) return false;
  if (pending.batchId !== session.batchId || Date.now() - new Date(pending.at).getTime() > PENDING_TTL_MS) return false;

  const t = text.trim();
  const listings = await batchListings(pending.batchId, userId);
  const inBatch = new Set(listings.map((l, i) => l.whatsapp_seq ?? i + 1));
  let seqs: number[] | null = null;
  if (/^apick:all$/i.test(t) || /^(all|both|all of them|all \d+|each|each of them|every one|everything)[.!]?$/i.test(t)) {
    seqs = pending.seqs;
  } else {
    const tap = /^apick:(\d+)$/i.exec(t);
    const typed = /^(?:products?\s*)?#?\d{1,2}(?:\s*(?:,|&|and)\s*#?\d{1,2})*[.!]?$/i.test(t) ? (t.match(/\d{1,2}/g) ?? []).map(Number) : null;
    const picked = tap ? [Number(tap[1])] : typed;
    if (picked) seqs = picked.filter((n) => inBatch.has(n));
  }
  if (!seqs || seqs.length === 0) return false;

  await updateSession(phone, { assistantPending: null });
  const products = await productFacts(listings);
  const r = await applyToProducts(userId, products, seqs, pending.changes as Changes, pending.message);
  const lines = r.lines.length > 0 ? r.lines : ["Nothing changed there."];
  await sendEditReply(phone, lines, r.editorFor);
  await logTurn(userId, "review", text, null, `answered which: ${seqs.join(", ")}: ${lines.join(" | ")}`);
  return true;
}

// ─── When the usual edit is enough ────────────────────────────────────────

/** Words naming something handleEdit can't change: these go to the assistant. */
const OTHER_FIELD_RE = /\b(variations?|variants?|sizes?|colou?rs?|title|name|rename|brand|material|model|weight|description|category|all|both|each)\b/i;

/**
 * Whether the review step's usual edit (handleEdit: price, stock, a sale
 * price) covers this text on its own, so it stays the instant, free path
 * the seller already knows: "2: price 150", "quantity 20". Given whether
 * handleEdit's own extractors found anything in it.
 */
export function plainQuickEdit(text: string, found: boolean): boolean {
  return found && !OTHER_FIELD_RE.test(text);
}
