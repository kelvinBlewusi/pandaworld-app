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
import { availableCredits, isUnmetered, listingCreditCost } from "@/lib/billing/extension-credits";
import { LABEL_CREDIT_COST, LIVE_CHANGE_CREDIT_COST, LIVE_LISTING_CREDIT_COST, NOTICE_CREDIT_COST, POLISH_CREDIT_COST, REPORT_CREDIT_COST } from "@/lib/billing/credit-packs";

/** Image polish makes four photos (lib/gemini-image.ts PRODUCT_SHOTS). */
const PRODUCT_SHOT_COUNT = 4;
import { creditReach } from "@/lib/billing/credit-status";
import { checkRestrictedBrand } from "@/lib/jumia/prohibited-catalog";
import { priceMinimumForUser, isBelowMinimum, money } from "@/lib/jumia/price-minimums";
import {
  sendButtonsIfConfigured, sendCtaUrlIfConfigured, sendListIfConfigured, sendTextIfConfigured,
} from "@/lib/whatsapp/client";
import {
  COUNT_QUICK_PICKS, MAX_BATCH_SIZE, buyCreditsUrl, extractDateRange, extractSalePrice, findDateIn, focusedEditorUrl, whatsappListingsUrl,
} from "@/lib/whatsapp/batch";
import { helpMessage } from "@/lib/whatsapp/onboarding";
import { appUrl } from "@/lib/whatsapp/app-url";
import { CHROME_WEB_STORE_URL, COMMUNITY_WHATSAPP_URL } from "@/lib/constants/support";
import { siteGuide } from "@/lib/whatsapp/site-guide";
import { jumiaCountryByCode } from "@/lib/marketing/countries";
import { sellerCountry } from "@/lib/jumia/unlistable-categories";
import { currentPack, featureAccess, featureMinPackName, type FeatureId } from "@/lib/billing/features";
import {
  BULK_MAX, MAX_GROUP, answerFees, answerListings, answerOrderStatus, answerPayouts, answerProductInfo, answerProducts, answerSales, answerStock,
  proposeBulkChange, proposeContentChange, proposeLiveChange, type BulkScope, type ContentRequest,
} from "@/lib/whatsapp/shop";
import {
  answerBrand, answerCategoryNeeds, answerLinkedShops, answerPayoutDetail, answerReport, answerWarehouseStock, proposeWarehouseOrder,
  proposeWarehouseShipped, type ReportKind,
} from "@/lib/whatsapp/shop-insights";
import type { LiveChange } from "@/lib/jumia/shop";
import { INTERACTIVE_BODY_MAX, splitForText } from "@/lib/whatsapp/text-limits";
import { ALLOWANCE_TOLD, allowanceText, assistantGate, assistantSwitchedOn } from "@/lib/whatsapp/assistant-limits";
import { isWebAddress } from "@/lib/whatsapp/channel";
import { handleOrderMessage } from "@/lib/whatsapp/orders";
import { resetSession, updateSession, type AssistantPending, type LiveValueAsk, type WhatsAppSession } from "@/lib/whatsapp/session";
import { parseVariations, saveVariations, variationOptions } from "@/lib/whatsapp/variation-question";
import { carryPriceToVariants, carrySaleToVariants, carryStockToVariants, chatPrice, shopCurrencyForUser } from "@/lib/whatsapp/listing-edits";
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
  // The kill switch (lib/whatsapp/assistant-limits.ts): off for everyone.
  if (!(await assistantSwitchedOn())) return false;
  if (isAdmin(userId)) return true;
  try {
    const { data } = await createServerClient().from("app_settings").select("value").eq("key", "assistant_users").maybeSingle();
    const ids = data?.value;
    return Array.isArray(ids) && (ids.includes("*") || ids.includes(userId));
  } catch {
    return false;
  }
}

/**
 * Whether the conversational assistant answers this message: in the Jumia
 * Listing Assistant on the website, every seller (owner, 2026-10-07: "the
 * conversational style should only be for the chat"); on WhatsApp, the
 * pilot only ("let's not make it chatty or conversational for users"), and
 * everyone else gets the WhatsApp flow and its commands. The kill switch
 * turns both off.
 */
export async function assistantFor(userId: string, phone: string): Promise<boolean> {
  if (isWebAddress(phone)) return assistantSwitchedOn();
  return assistantEnabled(userId);
}

// ─── What the AI is told ──────────────────────────────────────────────────

/**
 * Where the seller is. review: drafts waiting to be submitted. sent: the
 * whole batch just went to Jumia. idle: between batches. starting: a batch
 * was just started and no photo has come yet (a question asked there is
 * answered; anything else is the first product's notes, as always).
 */
export type Stage = "review" | "sent" | "idle" | "starting";

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
  /** `awaiting`: the reply asks for a live product's new stock or price, so a bare number next answers it. */
  | { type: "reply"; text: string; link: string | null; awaiting?: { field: "stock" | "price"; products: string[]; fromContext?: boolean } }
  /** `others`: more products for the same change (one tap, one feed); `all`: every product their words fit. */
  | { type: "live_change"; product: string; change: LiveChange; fromContext?: boolean; others?: string[]; all?: boolean }
  | { type: "product_info"; product: string }
  | { type: "fees"; product: string; price: number | null }
  | { type: "stock"; product: string | null; filter: "out" | "low" | null }
  | { type: "shop"; filter: "all" | "inactive" | "rejected" }
  | { type: "order_status"; number: string }
  /** One status ("CANCELED"), or several (["READY_TO_SHIP", "CANCELED"]). */
  | { type: "sales"; period: Period; status: string | string[] | null }
  | { type: "listings"; period: Period }
  | { type: "payouts" }
  /** Their statements one line each, or one in detail (fees, refunds). */
  | { type: "payout_detail"; mode: "history" | "breakdown"; statement: string | null }
  | { type: "report"; kind: ReportKind; period: Period }
  /** One change to every product a rule picks ("10% off all perfumes"). */
  | { type: "bulk"; scope: BulkScope; words: string | null; change: LiveChange }
  /** A live product's name, description, highlights or brand. */
  | { type: "content_change"; product: string; request: ContentRequest }
  | { type: "brand_check"; brand: string; product: string | null }
  | { type: "category_info"; product: string }
  | { type: "shops" }
  | { type: "warehouse_stock"; product: string }
  | { type: "warehouse_order"; items: { product: string; quantity: number }[]; date: string | null }
  | { type: "warehouse_shipped"; po: string; tracking: string; carrier: string | null }
  /** The chat's billed commands (owner, 2026-10-07): run when asked, charged when they run. */
  | { type: "polish"; seq: number | null }
  | { type: "health_report" }
  | { type: "note" }
  | { type: "unclear" };

/** "quarter" is the last 90 days: as far back as Jumia's orders go. */
export type Period = "today" | "yesterday" | "week" | "month" | "quarter";
const PERIODS = new Set<Period>(["today", "yesterday", "week", "month", "quarter"]);
const asPeriod = (v: unknown, fallback: Period): Period => (PERIODS.has(v as Period) ? (v as Period) : fallback);

/** The order statuses a seller can ask about, as Jumia names them. */
const ORDER_STATUSES: Record<string, string> = {
  cancelled: "CANCELED", canceled: "CANCELED", cancel: "CANCELED", delivered: "DELIVERED", returned: "RETURNED", returns: "RETURNED",
  return: "RETURNED", failed: "FAILED", failed_delivery: "FAILED", pending: "PENDING", shipped: "SHIPPED", ready_to_ship: "READY_TO_SHIP",
  ready: "READY_TO_SHIP", rts: "READY_TO_SHIP",
};

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
  sent:   "The seller has just submitted the products below to Jumia. They're no longer drafts: once live, their stock, price, sale and on/off are changed with live_change, and their name, description, highlights or brand with content_change.",
  idle:   "The seller is between batches: no products are being listed right now. To start, they say how many products they're listing.",
  starting: "The seller has just started listing a batch and hasn't sent any photo yet. A message here is normally information about the first product (price, sizes, colours, condition): for that, answer note.",
};

/**
 * What PandaWorld does, for the AI's replies: every line is something the
 * code does (lib/whatsapp/intake.ts, orders.ts, credit-gate.ts, the
 * extension), so the AI never promises what isn't there.
 */
function capabilities(listingCost = LIVE_LISTING_CREDIT_COST): string {
  return [
    `- List products on Jumia from WhatsApp: the seller says how many (1 to ${MAX_BATCH_SIZE}), sends each product's photos with the price and notes as the caption, and AI drafts each listing (name, description, category, details) for them to check and submit. Two ways to send: all at once, or guided step by step.`,
    "- Ask for what Jumia needs that the photos don't show: a missing price, weight or other required detail, the variation, the category when unsure.",
    "- Edit drafts in chat before they're submitted: price, quantity, variations or sizes, name, brand, colour, a sale price with its dates. Anything else in the editor on the review page.",
    "- Chatting is free on every pack. Every pack, free credits included: listing, orders (see, pack, ready to ship, cancel), reading their shop (products, stock, sales, reports, payouts, fees), image polish and the shop health report; only the commands below that cost credits are charged. Only these need a pack: changes to live Jumia products from the chat, Jumia QC rejection alerts and guided fixes and shipping label PDFs on WhatsApp (Standard and up); order alerts on WhatsApp and the extension's fee calculator (Pro and up). Everything pauses at 0 credits.",
    "- Submit to Jumia and report back when each product goes live or is rejected; fix common rejections itself (banned words, restricted brands) and guide the seller through the rest with Fix & resubmit. After Jumia accepts a listing, its quality-check verdict is followed up (and the credits returned if QC rejects it) with the Standard pack and up.",
    "- Orders: \"orders\" shows orders waiting to be packed; pack them, mark them ready to ship, or cancel, here or on WhatsApp; where any order is, by its number; orders and sales for today, the week, the month or 90 days. Shipping label PDFs only on WhatsApp (Standard pack and up). Pro and up also: alerts for new Jumia orders on WhatsApp, grouped and quiet at night, and a message when orders are delivered, returned, fail delivery or are cancelled.",
    `- Their live Jumia products, found by name among everything in their shop: change a product's stock, price, a sale price with its dates, or turn it on or off, with one tap to confirm, for one product or several named together (up to ${MAX_GROUP}); where a product is (on or off, Jumia's quality check, price, sale, stock); how many are left; what's out of stock or low; which products are turned off or rejected by Jumia's quality check.`,
    `- Rules for many products at once, shown in full before one tap: prices up or down by a percentage, a sale a percentage off (with dates), a stock or price, ending sales, turning on or off; for all their products, the ones out of stock, low, off or on, or all that match words ("all perfumes"); up to ${BULK_MAX} products.`,
    "- A live product's name, description, highlights or brand: the seller's own text, or rewritten by AI from what Jumia has now, shown before one tap. Jumia checks content changes again. Photos and category of live products are changed in Vendor Center.",
    "- Reports: best sellers, products with no sale, what runs out soon at the rate it sells, returns and failed deliveries, for the last 7, 30 or 90 days.",
    "- Payouts: the last Jumia payout and the statement not yet paid; every statement of the last 90 days; one statement's fees, refunds and balances. A message when Jumia pays: Pro and up.",
    "- Before listing: whether a brand is on Jumia and allowed in a category; what a kind of product needs on Jumia (its category, the details asked, variation options, commission).",
    "- The shops under their Jumia account. Jumia's warehouse (for sellers who stock it): what it holds of a product, a delivery order into it (products and quantities, with a tap), and telling Jumia one has shipped with its tracking number.",
    "- Fees: what Jumia takes when one of their products sells (commission for its category, the per-item shipping contribution) and what they receive, at its price or a price they give.",
    `- Credits: tell the balance; a WhatsApp listing or an extension autofill costs ${listingCost} credits for this seller, a listing charged only when it goes live on Jumia; a shipping label ${LABEL_CREDIT_COST} credits (the same label again is free), a confirmed change to live products ${LIVE_CHANGE_CREDIT_COST} (back if Jumia refuses it), an order-updates message ${NOTICE_CREDIT_COST}; new-order alerts, payout messages and chatting are free (chat replies have a daily limit by pack); warn when running low. Credits are bought on the dashboard.`,
    "- The PandaWorld Chrome extension fills Jumia's Vendor Center product form on a laptop; image polish and a fee calculator in it on Pro.",
    "- A free Jumia price calculator, Jumia commission rates, how-to guides and an FAQ on the website.",
    `- Image polish: ${PRODUCT_SHOT_COUNT} product photos made from the seller's own (main on white, angle, lifestyle, detail), ${POLISH_CREDIT_COST} credits each, for a product being listed (\"polish 2\"), or by itself when the product's note asks for polished photos. They go first on the listing, the seller's own after.`,
    `- The shop health report: a full check of their shop from live Jumia data, a score out of 100, what's working, what isn't and what to do, ${REPORT_CREDIT_COST} credits.`,
    "- Commands (type / in the Listing Assistant or tap +; \"menu\" on WhatsApp): orders, sales today, sales week, shop, out of stock, payouts, report, polish and a product number, credits, status, restart, how it works, disconnect. Only polish, the report and confirmed changes to live products cost credits; chatting and everything else is free.",
    "- Words the bot always knows: \"status\" (where they are), \"restart\", \"help\", \"menu\", \"orders\", \"disconnect\" (Jumia).",
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
    assistant:       { label: "Listing Assistant", url: `${base}/extension/assistant`, what: "the Jumia Listing Assistant: this chat on the website" },
    listings:        { label: "Autofill activity", url: `${base}/extension/listings`, what: "the products the Chrome extension autofilled" },
    calculator_app:  { label: "Calculator",        url: `${base}/extension/calculator`, what: "the fee calculator in their dashboard" },
    connect_jumia:   { label: "Connect Jumia",     url: `${base}/onboarding/connect`, what: "the page to connect their Jumia account" },
    review:          { label: "Review listings",   url: whatsappListingsUrl(opts.batchId ?? undefined), what: opts.batchId ? "this batch's drafts, to check and edit" : "their WhatsApp drafts" },
    settings:        { label: "Settings",          url: `${base}/extension/settings`, what: "settings: the Jumia connection, WhatsApp, the API key" },
    faq:             { label: "FAQ",               url: `${base}/faq`, what: "frequently asked questions" },
    guides:          { label: "How-to guides",     url: `${base}/how-to`, what: "all the step-by-step guides" },
    guide_whatsapp:  { label: "WhatsApp guide",    url: `${base}/how-to/list-on-jumia-from-whatsapp`, what: "how to list from WhatsApp, with an example" },
    guide_connect:   { label: "Connect guide",     url: `${base}/how-to/connect-jumia-vendor-center`, what: "how to connect Jumia Vendor Center" },
    guide_link_whatsapp: { label: "Link WhatsApp guide", url: `${base}/how-to/link-whatsapp`, what: "how to link a WhatsApp number" },
    guide_extension: { label: "Extension guide",   url: `${base}/how-to/chrome-extension-autofill`, what: "how to list from a laptop with the extension" },
    extension:       { label: "Get the extension", url: CHROME_WEB_STORE_URL, what: "the PandaWorld Chrome extension on the Chrome Web Store" },
    calculator:      { label: "Price calculator",  url: `${base}/jumia-price-calculator`, what: "Jumia selling price and fee calculator" },
    commission:      { label: "Commission rates",  url: `${base}/jumia-commission-rates`, what: "Jumia's commission rates by category" },
    ...(opts.countrySlug ? { country: { label: "Selling on Jumia", url: `${base}/sell-on-jumia/${opts.countrySlug}`, what: "selling on Jumia in their country" } } : {}),
    vendor_center:   { label: "Vendor Center",     url: "https://vendorcenter.jumia.com", what: "Jumia Vendor Center, where products already with Jumia are changed" },
    privacy:         { label: "Privacy policy",    url: `${base}/privacy`, what: "privacy policy" },
    terms:           { label: "Terms",             url: `${base}/terms`, what: "terms of service" },
    community:       { label: "Community group",   url: COMMUNITY_WHATSAPP_URL, what: "PandaWorld's community WhatsApp group" },
  };
}

/** What's true for this seller: their pack, what it gives them, their credits and country. Best-effort. */
export async function sellerFacts(userId: string): Promise<{ lines: string[]; countrySlug: string | null }> {
  const lines: string[] = [];
  let countrySlug: string | null = null;
  try {
    const country = jumiaCountryByCode(await sellerCountry(userId).catch(() => null));
    if (country) { lines.push(`- Country: ${country.name}`); countrySlug = country.slug; }
    const { data: conn } = await createServerClient().from("jumia_connections").select("store_name, seller_name").eq("user_id", userId).maybeSingle();
    const shopName = (conn as { store_name?: string | null; seller_name?: string | null } | null)?.store_name
      ?? (conn as { seller_name?: string | null } | null)?.seller_name;
    if (shopName) lines.push(`- Their Jumia shop: ${shopName}`);
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
    // Every plan reads its shop and handles its orders (owner, 2026-10-07); live changes, QC, labels and the alerts need a pack.
    lines.push(`- The chat's shop features (products, orders, reports, payouts, fees): ${await access("shop_whatsapp")}`);
    lines.push(`- Changes to live Jumia products from the chat: ${await access("shop_changes")}`);
    lines.push(`- Jumia QC rejection alerts and guided fixes: ${await access("qc_fix")}`);
    lines.push(`- Shipping label PDFs on WhatsApp: ${await access("shipping_labels")}`);
    lines.push(`- Order alerts on WhatsApp (new orders, order updates, payouts): ${await access("order_alerts")}`);
    const credits = Math.max(0, Math.round((await availableCredits(userId)) * 100) / 100);
    lines.push(`- Credits: ${credits} available, ${creditReach(credits, await listingCreditCost(userId))}`);
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
  /** The last messages, oldest first: "Seller: …" / "Bot: …". */
  conversation?: string[];
  /** What a listing costs this seller (their country's price). */
  listingCost?: number;
  /** The Listing Assistant on the website (lib/whatsapp/channel.ts), not WhatsApp. */
  web?: boolean;
}

export function buildPrompt(stage: Stage, message: string, ctx: PromptContext): string {
  const { products, currency, seller, links, hintSeq, conversation = [], listingCost, web } = ctx;
  return [
    web
      ? "You are PandaWorld's Jumia Listing Assistant, a chat on the PandaWorld website. PandaWorld lists sellers' products on Jumia (Africa's online marketplace) and helps them run their Jumia shop."
      : "You are PandaWorld's assistant on WhatsApp. PandaWorld lists sellers' products on Jumia (Africa's online marketplace) and helps them run their Jumia shop.",
    ...(web ? [
      "This chat works like the WhatsApp bot: the seller uploads product photos with the image button, adds the price and notes as text, and you draft, edit and submit them to Jumia.",
      "Orders work here too: the orders action shows the ones waiting, with buttons to pack them, mark them ready to ship or cancel them. Here, NOT available: shipping labels and new-order alerts, which are on WhatsApp only (or labels in Vendor Center): for those, say so in a reply.",
    ] : []),
    "You choose ONE action as JSON, and PandaWorld's code checks it and carries it out.",
    "",
    `Where the seller is: ${STAGE_TEXT[stage]}`,
    ...(products.length > 0 ? ["", "Products (the number is the product number):", ...products.map((p) => productLine(p, currency))] : []),
    ...(seller.length > 0 ? ["", "About this seller:", ...seller] : []),
    "",
    "What PandaWorld can do (all true; never claim anything else):",
    capabilities(listingCost),
    "",
    siteGuide(),
    "",
    "Links you can send (put the key in \"link\"; the seller gets a button):",
    ...Object.entries(links).map(([key, l]) => `- ${key}: ${l.what}`),
    "",
    ...(conversation.length > 0 ? ["Recent conversation (oldest first; \"Bot\" is you):", ...conversation, ""] : []),
    `The seller's new message: "${message.replace(/"/g, "'").slice(0, 600)}"`,
    ...(hintSeq != null ? [`(They started it with product number ${hintSeq}.)`] : []),
    "",
    "Rules:",
    "- Read the new message with the recent conversation: a short reply (\"yes\", \"five\", \"do it\", \"why?\", \"the 43 one\") answers the bot's last message.",
    "- If one of the actions below does what they ask, return it. Never reply that you can or will check or do something: do it with the action.",
    "- Never promise anything for later (to remember, to message them, to make sure, to look into it): you only do the actions here, now. If something went wrong, say plainly what you can do now.",
    "- A product they name that isn't one of the drafts above is a product already in their Jumia shop: use live_change, product_info, stock or fees for it, never edit.",
    "- A question about a product (is it live, on, active, approved, in stock, on sale?) is product_info, never live_change: only change a product when they ask for the change.",
    "- A change to many products by a rule (all, every, everything, a percentage) is bulk; to products they name one by one, live_change.",
    "- \"How many products are on / off / live\" is shop (the overview), never product_info.",
    "- Sellers make typos (\"ordrs\" is orders, \"payed\" is paid, \"tun on\" is turn on) and write in many languages.",
    "",
    "Reply with ONLY one JSON object, no markdown, one of:",
    '{"type":"edit","edits":[{"products":[<numbers>],"said":"<their words for the product, or null>","changes":{...},"ask":false}]} - change drafts above. One entry per different change.',
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
    '{"type":"live_change","product":"<their words for the product>","stock":<number>} - change a product already in their Jumia shop',
    '  (never one of the drafts above). Instead of "stock", exactly one of: "price":<number>, "sale_price":<number> (put it on sale at',
    '  that price; the dates are read from the message), "sale":"end" (end its sale), "active":true or false (turn it on or off).',
    '  The same change to several products: "products":["<words for one>","<words for another>"] instead of "product". "all":true',
    '  when they say all or every one of something ("all the hard hats").',
    '  Values from the message, or from the seller\'s own recent messages when this one names the products. "product" may come from the',
    '  recent conversation when the message says "it", "them" or nothing.',
    '{"type":"product_info","product":"<their words>"} - where one of their Jumia products is: on or off, quality check, price, sale, stock',
    '{"type":"fees","product":"<their words>","price":<number from the message> or null} - what Jumia takes and what they receive when it sells',
    '{"type":"stock","product":"<their words>" or null,"filter":"out" or "low" or null} - how many are left of a product, or what is out of stock or low',
    '{"type":"shop","filter":"all" or "inactive" or "rejected"} - their Jumia products: an overview, the ones turned off, or the ones rejected',
    '{"type":"order_status","number":"<the order number from the message>"} - where one order is',
    '{"type":"sales","period":"today" or "yesterday" or "week" or "month" or "quarter","status":null or one or a list of "cancelled", "delivered",',
    '  "returned", "failed", "pending", "ready_to_ship", "shipped"} - their Jumia orders and sales; with statuses, those orders. "quarter" is',
    '  the last 90 days, the furthest back Jumia goes: use it for "3 months", "90 days" or "ever".',
    '{"type":"listings","period":"today" or "yesterday" or "week" or "month" or "quarter"} - how many products they listed with PandaWorld',
    '{"type":"payouts"} - money from Jumia: the last payout, what\'s not paid yet',
    '{"type":"payout_detail","mode":"history" or "breakdown","statement":"<a statement number from the message>" or null} - every statement of',
    '  the last 90 days (history), or one statement\'s fees, refunds and balances (breakdown; the newest when no number)',
    '{"type":"report","kind":"best_sellers" or "slow_movers" or "restock" or "returns","period":"week" or "month" or "quarter"} - best sellers;',
    '  products with no sale; what runs out soon and needs restocking; returns and failed deliveries',
    '{"type":"bulk","scope":"all" or "out_of_stock" or "low_stock" or "inactive" or "active" or "matching","words":"<their words for the',
    '  products, for matching>" or null, plus exactly one of: "price_pct":<+/- number> (prices up or down by that %), "sale_pct":<number>',
    '  (a sale that % off; dates from the message), "stock":<number>, "price":<number>, "sale_price":<number>, "sale":"end", "active":true or false}',
    '  - one change to many products by a rule. "matching" with "words" for "all the perfumes".',
    '{"type":"content_change","product":"<their words>","name":"<new name copied from the message>" or null,"description":"<copied>" or',
    '  null,"highlights":"<copied>" or null,"brand":"<copied>" or null,"rewrite":["name","description","highlights"] or []} - a live product\'s',
    '  name, description, highlights or brand. "rewrite" lists what they ask you to write or improve for them.',
    '{"type":"brand_check","brand":"<the brand from the message>","product":"<the kind of product>" or null} - is a brand on Jumia, allowed?',
    '{"type":"category_info","product":"<the kind of product>"} - what Jumia needs to list it: category, details, variations, commission',
    '{"type":"shops"} - the shops under their Jumia account',
    '{"type":"warehouse_stock","product":"<their words>"} - what Jumia\'s warehouse holds of a product',
    '{"type":"warehouse_order","items":[{"product":"<their words>","quantity":<number>}]} - send stock to Jumia\'s warehouse (a delivery order)',
    '{"type":"warehouse_shipped","po":"<purchase order number from the message>","tracking":"<tracking number from the message>","carrier":"<from',
    '  the message>" or null} - tell Jumia a delivery order to its warehouse has shipped',
    '{"type":"credits"} - their credit balance (sent with a Buy credits button)',
    `{"type":"polish","product":<the product number from the message> or null} - polish a product's photos: ${PRODUCT_SHOT_COUNT} new product photos made from theirs (main on white, angle, lifestyle, detail), ${POLISH_CREDIT_COST} credits each`,
    `{"type":"health_report"} - a full health check of their whole shop from live Jumia data: what's working, what isn't, what to do (${REPORT_CREDIT_COST} credits). "How is my shop doing?" is this; best sellers or returns alone are "report".`,
    ...(stage === "starting" ? ['{"type":"note"} - their message is information about the product they are about to send (price, sizes, colours, condition)'] : []),
    '{"type":"reply","text":"<your message>","link":"<a key above, or null>"} - everything else. You write the message:',
    "  - \"What can you do\", a hello (\"hi\", \"hello there\"), or something you can't match: in your own words (vary it, never a set",
    "    script), a short numbered list (4 to 6 lines) of what you can do for them, and end by asking what they'd like to do for their Jumia shop.",
    "  - A question about them (their shop's name, country, pack, what's on): answer it from About this seller.",
    "  - Thanks or ok: a short, friendly line; no list.",
    "  - Greet only if they greeted you in this message. Mention a pack only for a feature their pack doesn't have (see About this seller).",
    "  - A question about selling on Jumia, their shop or PandaWorld: answer it from what's above. Don't state fees, commission",
    "    rates, prices, dates or Jumia rules that aren't given above: send the link that has them instead.",
    "  - A request for a page or link: one short line, with \"link\" set. Never write a web address in the text.",
    "  - How to do something on PandaWorld, or where to find it (link WhatsApp, connect Jumia, the extension, the API key, buying",
    "    credits, a page): the steps from the website guide above, in order, as \"1.\" lines with the page's own button words, and",
    "    \"link\" set to the page or guide (the key in [brackets]). Only steps the guide gives; up to 900 characters for steps.",
    "  - Anything outside Jumia, their shop and PandaWorld, or something PandaWorld can't do: say plainly that you don't understand",
    "    that or can't help with it, suggest something you can do, and ask them to try something different.",
    "  Write for WhatsApp: short and warm, at most 600 characters (steps up to 900), *bold* with single asterisks, numbered lists as \"1.\" lines.",
    "  Reply in the language the seller wrote in.",
    "",
    "Examples (message → JSON):",
    '"has jumia paid me?" or "shop statement" → {"type":"payouts"}',
    '"any orders cancelled today?" → {"type":"sales","period":"today","status":"cancelled"}',
    '"check cancelled orders yesterday" → {"type":"sales","period":"yesterday","status":"cancelled"}',
    '"check for ready to ship and cancelled orders yesterday" → {"type":"sales","period":"yesterday","status":["ready_to_ship","cancelled"]}',
    '"how many orders did I get this week" → {"type":"sales","period":"week","status":null}',
    '"did I have orders today?" → {"type":"sales","period":"today","status":null}',
    '"how much has my shop made in 90 days" → {"type":"sales","period":"quarter","status":null}',
    '"returns" or "did I have returns" → {"type":"sales","period":"month","status":"returned"}',
    '"orders to pack" or "show my orders" → {"type":"orders"}',
    '"is the drone live?" or "is the dron active" → {"type":"product_info","product":"drone"}',
    '"how much will I receive if the creatine sells?" → {"type":"fees","product":"creatine","price":null}',
    '"what does jumia charge if I sell the boot at 120" → {"type":"fees","product":"boot","price":120}',
    '"set the stock of the freezer, the blender and the chainsaw to 10" → {"type":"live_change","products":["freezer","blender","chainsaw"],"stock":10}',
    '"also tun on the drone" → {"type":"live_change","product":"drone","active":true}',
    '"hi there" → {"type":"reply","text":"Hi! 👋 Here\'s what I can do for your shop:\\n1. …\\n2. …\\n…\\nWhat would you like to do today?","link":null}',
    '"what\'s my shop name?" → {"type":"reply","text":"Your Jumia shop is <the name in About this seller>.","link":null}',
    '"how do I regenerate my key?" → {"type":"reply","text":"1. Open your Extension Dashboard.\\n2. On the API key card, tap *Regenerate key* and confirm.\\n3. Copy the new key and paste it into the extension again: the old one stops working.","link":"dashboard"}',
    '"how many listings have I done today?" → {"type":"listings","period":"today"}',
    '"check if I have stock for creatine" → {"type":"stock","product":"creatine","filter":null}',
    '"what is out of stock" → {"type":"stock","product":null,"filter":"out"}',
    '"set my wellington boot stock to 30" → {"type":"live_change","product":"wellington boot","stock":30}',
    '"put the boots on sale at 100 from 10 Oct to 20 Oct" → {"type":"live_change","product":"boots","sale_price":100}',
    '"turn off the blender" → {"type":"live_change","product":"blender","active":false}',
    '"ordrs" → {"type":"orders"}',
    '(draft 2 is a wig) "make the wig 120" → {"type":"edit","edits":[{"products":[2],"said":"wig","changes":{"price":120},"ask":false}]}',
    '(no draft is a gold medal) "set the gold medal to 25" → {"type":"live_change","product":"gold medal","price":25}',
    '(the bot just said the most is 20 at a time) "let\'s do five then" → {"type":"list","count":5}',
    '"thanks" → {"type":"reply","text":"You\'re welcome! 🙌","link":null}',
    '"how many of my products are on and off" → {"type":"shop","filter":"all"}',
    '"what are my best sellers this month" → {"type":"report","kind":"best_sellers","period":"month"}',
    '"which products haven\'t sold" → {"type":"report","kind":"slow_movers","period":"month"}',
    '"what should I restock" → {"type":"report","kind":"restock","period":"month"}',
    '"show my payout history" → {"type":"payout_detail","mode":"history","statement":null}',
    '"what fees did jumia take on my last statement" → {"type":"payout_detail","mode":"breakdown","statement":null}',
    '"raise all my prices by 5%" → {"type":"bulk","scope":"all","words":null,"price_pct":5}',
    '"10% off all perfumes this weekend" → {"type":"bulk","scope":"matching","words":"perfumes","sale_pct":10}',
    '"turn off everything that\'s out of stock" → {"type":"bulk","scope":"out_of_stock","words":null,"active":false}',
    '"end the sale on all products" → {"type":"bulk","scope":"all","words":null,"sale":"end"}',
    '"rewrite the description of the wellington boot" → {"type":"content_change","product":"wellington boot","name":null,"description":null,"highlights":null,"brand":null,"rewrite":["description"]}',
    '"change the blender\'s name to Silver Crest 3 in 1 Blender 1.5L" → {"type":"content_change","product":"blender","name":"Silver Crest 3 in 1 Blender 1.5L","description":null,"highlights":null,"brand":null,"rewrite":[]}',
    '"is Lattafa a brand on jumia?" → {"type":"brand_check","brand":"Lattafa","product":null}',
    '"what does jumia need to list a perfume" → {"type":"category_info","product":"perfume"}',
    '"how many kettles are in jumia\'s warehouse" → {"type":"warehouse_stock","product":"kettles"}',
    '"send 50 of the kettle to jumia warehouse on 20 Oct" → {"type":"warehouse_order","items":[{"product":"kettle","quantity":50}]}',
    '"PO 123AB shipped, tracking DHL998877" → {"type":"warehouse_shipped","po":"123AB","tracking":"DHL998877","carrier":null}',
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
    // A word nothing backs is the AI's own: left out. The product's current
    // variations always count as backed, so none is lost that way.
    if (backed.length > 0) changes.variations = Array.from(new Set(backed));
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
  // Under WhatsApp's 1,024 for a message with a button: steps (site-guide.ts) can run to 900.
  return cleaned.length > 1000 ? `${cleaned.slice(0, 999).replace(/\s+\S*$/, "")}…` : cleaned;
}

const DRAFT_STOP = new Set([
  "the", "my", "a", "an", "of", "for", "to", "on", "in", "and", "with", "it", "its", "this", "that", "these", "those", "product",
  "products", "item", "items", "one", "ones", "you", "drafted", "draft", "just", "submitted", "please", "first", "second", "third",
  "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "last", "number", "no",
]);
const draftWords = (s: string) =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !DRAFT_STOP.has(w)).map((w) => (w.length > 3 ? w.replace(/s$/, "") : w));

/**
 * Whether the seller's words for a product fit this draft's name: more than
 * half of them are in it ("the wigs" fits "Kinky Curly Wig"; "gold medal"
 * doesn't fit "… Earrings - Shell Inlay, Gold Tone"). Words like "the
 * second one" name no product and fit any.
 */
export function fitsDraft(said: string, title: string | null): boolean {
  const want = draftWords(said);
  if (want.length === 0) return true;
  const have = draftWords(title ?? "");
  const hits = want.filter((w) => have.some((h) => h === w || (w.length >= 4 && h.length >= 4 && (h.startsWith(w) || w.startsWith(h)))));
  return hits.length / want.length > 0.5;
}

/** "this month", "you choose the dates": a sale window the seller leaves to us. */
const DELEGATED_MONTH = /\b(this|the|current)\s+month\b|\bend of (the )?month\b|\byou (can )?(choose|pick|decide|set)\b|\bany dates?\b|\bchoose (your own|the|any)\b/i;
const DELEGATED_WEEK = /\b(this|the|current)\s+week\b|\bfor (a|one) week\b/i;
const WEEKEND = /\b(this|the|coming|next)\s+weekend\b|\bover the weekend\b/i;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The sale window from the message: its dates, or one the seller left to us (to the end of this month or week). */
export function saleWindow(message: string, now: Date): { start: string; end: string } | null {
  const r = extractDateRange(message, now);
  if (r.startDate && r.endDate) return { start: r.startDate, end: r.endDate };
  if (r.endDate && r.endDate >= isoDay(now)) return { start: isoDay(now), end: r.endDate };
  if (WEEKEND.test(message)) {
    // Saturday to Sunday; from today when it's already the weekend.
    const day = now.getUTCDay();
    const toSat = day === 6 || day === 0 ? 0 : 6 - day;
    const toSun = day === 0 ? 0 : 7 - day;
    return { start: isoDay(new Date(now.getTime() + toSat * 86_400_000)), end: isoDay(new Date(now.getTime() + toSun * 86_400_000)) };
  }
  if (DELEGATED_WEEK.test(message)) return { start: isoDay(now), end: isoDay(new Date(now.getTime() + 6 * 86_400_000)) };
  if (DELEGATED_MONTH.test(message)) {
    return { start: isoDay(now), end: isoDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))) };
  }
  return null;
}

const END_SALE_WORDS = /\b(end|ends|stop|remove|cancel|no longer|take off|turn off)\b[^.?!]*\b(sale|discount|promo)|\b(sale|discount|promo)\b[^.?!]*\b(end|ended|off|over|stop)\b/i;
const OFF_WORDS = /\b(off|deactivate|disable|hide|unpublish|inactive|pause|stop selling|unlist)\b/i;
/** Typos included: "also tun on the drone" was refused (live, 2026-10-07). Not "on sale". */
const ON_WORDS = /\b(turn|tun|trun|tur|switch|put|set|get|bring)\b[^.?!]*\bon\b(?!\s+(sale|discount|promo))|\b(back on|on again)\b|\b(activate|enable|unhide|publish|republish|reactivate|resume|unpause)\b|\b(active|live|visible) again\b|\bmake (it |them )?(active|live|visible)\b|\bgo live\b/i;

/**
 * A question about a product's state ("is the drone live?", "is the dron
 * active"), not a request to change it: answered with product_info. "Can you
 * turn on the drone?" is a request.
 */
export function isStateQuestion(text: string): boolean {
  const t = text.trim();
  if (/^(is|are|was|were|has|have|does|do|did|check if|check whether)\b/i.test(t)) return true;
  return /\?\s*$/.test(t) && !/^(can|could|would|will|please|pls|kindly)\b/i.test(t)
    && !/\b(turn|tun|switch|activate|enable|deactivate|disable|put|set|make|change)\b/i.test(t);
}

/**
 * Whether the seller's message names the product: at least one of its words
 * is in it, or starts the same for 4 letters or more ("dron" for "drones").
 */
export function productBacked(product: string, message: string): boolean {
  const said = new Set(message.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2));
  const typed = Array.from(said).filter((s) => s.length >= 4);
  return product.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length >= 2 && (
    said.has(w) || said.has(w.replace(/s$/, "")) || said.has(`${w}s`)
    || (w.length >= 4 && typed.some((s) => w.startsWith(s) || s.startsWith(w)))));
}

/** Words that name no product: "those products", "all of them", "the other ones". */
const FILLER = new Set([
  "the", "my", "a", "an", "of", "those", "these", "that", "this", "them", "it", "its", "they", "their", "products", "product", "items",
  "item", "listings", "listing", "ones", "one", "shop", "store", "jumia", "on", "in", "all", "every", "everything", "other", "others",
  "rest", "apart", "from", "except", "each", "both", "stuff", "things", "thing", "remaining",
]);
const BULK_WORDS = /\b(all|every|everything|other|others|rest|remaining)\b/i;
/** Whether the words name a product at all. */
export function namesAProduct(words: string): boolean {
  return words.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length >= 2 && !FILLER.has(w));
}

/**
 * "the freezer and the blender, chainsaw": each product of a list the AI gave
 * as one. "And" splits only before "the"/"my"/"also", so "Salt and Pepper
 * Grinder" stays one product.
 */
export const splitProducts = (s: string) =>
  s.split(/\s*[,;]\s*|\s+and\s+(?=(?:the|my|also|a|an)\b)/i).map((x) => x.replace(/^(?:and|also)\s+/i, "").trim()).filter((x) => namesAProduct(x));

/** The seller's own last few messages in the conversation ("Seller: …" lines). */
const sellerLines = (context: string, n = 3) =>
  context.split("\n").filter((l) => l.startsWith("Seller:")).slice(-n).map((l) => l.slice(7)).join("\n");

/**
 * A live change, checked: the products (named in the message, or in the
 * conversation when it says "it"/"them"), and the value, from the message,
 * or from the seller's own recent messages when this one only names the
 * products ("update those to 10 each", then "the freezer and the blender").
 */
function liveChangeAction(
  parsed: Record<string, unknown>, message: string, context: string, now: Date, currency: string,
): AssistantAction {
  const ask = (text: string, awaiting?: { field: "stock" | "price"; products: string[]; fromContext?: boolean }): AssistantAction =>
    ({ type: "reply", text, link: null, ...(awaiting ? { awaiting } : {}) });
  const raw = [
    ...(Array.isArray(parsed.products) ? parsed.products : []),
    ...(typeof parsed.product === "string" ? [parsed.product] : []),
  ].filter((p): p is string => typeof p === "string").map((p) => p.trim().slice(0, 120)).filter(Boolean);
  const named = Array.from(new Set(raw.flatMap((p) => (namesAProduct(p) ? [p] : []))));
  const all = parsed.all === true || BULK_WORDS.test(message);

  // "off all products", "turn off all the other products": the whole shop.
  if (named.length === 0) {
    if (all || raw.some((p) => BULK_WORDS.test(p))) {
      return ask(`Which products? Say it as a rule, e.g. "turn off everything out of stock", "raise all prices by 5%" or "10% off all perfumes this weekend", and I'll show you the list before anything changes.`);
    }
    return ask("Which products do you mean? Tell me their names as they show on Jumia, e.g. \"set the stock of the freezer and the blender to 10\".");
  }
  const inMessage = named.filter((p) => productBacked(p, message));
  const inContext = named.filter((p) => !inMessage.includes(p) && productBacked(p, context));
  const products = [...inMessage, ...inContext];
  const fromContext = inMessage.length === 0 && inContext.length > 0;
  if (products.length === 0) return ask("Which product do you mean? Tell me its name as it shows on Jumia, e.g. \"set the Hisense fridge's stock to 20\".");
  const [product, ...others] = products;
  const live = (change: LiveChange): AssistantAction => ({
    type: "live_change", product, change,
    ...(fromContext ? { fromContext } : {}),
    ...(others.length > 0 ? { others } : {}),
    // "all the hard hats": every product it fits. Said in the message, not only the AI's word.
    ...(/\b(all|every)\b/i.test(message) ? { all: true } : {}),
  });
  const own = messageNumbers(message);
  const numbers = own.length > 0 ? own : messageNumbers(sellerLines(context));
  const awaiting = (field: "stock" | "price") => ({ field, products, ...(fromContext ? { fromContext } : {}) });
  const it = products.length > 1 ? "their" : "its";

  if (parsed.stock != null) {
    const n = Number(parsed.stock);
    const outWords = /\b(out of stock|sold out|none left|finished|no more)\b/i.test(message);
    return Number.isInteger(n) && n >= 0 && (numbers.includes(n) || (n === 0 && outWords))
      ? live({ kind: "stock", stock: n }) : ask(`What should ${it} stock be? Send the number, e.g. "10".`, awaiting("stock"));
  }
  if (parsed.price != null) {
    const n = Number(parsed.price);
    return n > 0 && numbers.includes(n) ? live({ kind: "price", price: n }) : ask(`What should ${it} price be? Send the number, e.g. "150".`, awaiting("price"));
  }
  if (parsed.sale === "end") {
    return END_SALE_WORDS.test(message) ? live({ kind: "sale", sale: null }) : { type: "unclear" };
  }
  if (parsed.sale_price != null || parsed.sale === true) {
    const n = Number(parsed.sale_price);
    const price = n > 0 && numbers.includes(n) ? n : extractSalePrice(message, now, currency)?.salePrice ?? null;
    if (price == null) return ask("What sale price? e.g. \"put it on sale at 80 from 10 Oct to 20 Oct\".");
    const window = saleWindow(message, now) ?? (own.length === 0 ? saleWindow(sellerLines(context, 2), now) : null);
    if (!window) return ask(`A sale on Jumia needs its dates. Send them with the price, e.g. "sale ${price} from 10 Oct to 20 Oct", or say "sale ${price} this month".`);
    return live({ kind: "sale", sale: { price, start: window.start, end: window.end } });
  }
  if (parsed.active === true || parsed.active === false) {
    // "is the drone live?": a question, answered, nothing changed.
    if (isStateQuestion(message)) return { type: "product_info", product };
    if (parsed.active === false) return OFF_WORDS.test(message) ? live({ kind: "status", active: false }) : { type: "unclear" };
    return ON_WORDS.test(message) ? live({ kind: "status", active: true }) : { type: "unclear" };
  }
  return ask("What should I change on it? Its stock, price, a sale price with dates, or turning it on or off.");
}

const PCT_RE = /(\d+(?:\.\d+)?)\s*(?:%|percent|per cent|pct)/i;
const DOWN_WORDS = /\b(reduce|lower|cut|decrease|drop|down|less|slash|minus)\b/i;
const UP_WORDS = /\b(raise|increase|up|more|add|higher|hike|plus)\b/i;
const RULE_WORDS = /\b(all|every|everything|whole|entire|each)\b|%|\bpercent\b/i;
const BULK_SCOPES = new Set<BulkScope>(["all", "out_of_stock", "low_stock", "inactive", "active", "matching"]);
/** What a scope must be backed by in the message (the AI's word alone isn't enough). */
const SCOPE_WORDS_RE: Partial<Record<BulkScope, RegExp>> = {
  out_of_stock: /\b(out of stock|sold out|no stock|zero stock|0 stock|finished)\b/i,
  low_stock:    /\blow\b/i,
  inactive:     /\b(off|inactive|disabled|hidden|deactivated|paused)\b/i,
  active:       /\b(on|active|live|enabled|visible)\b/i,
};

/**
 * A rule for many products ("10% off all perfumes this weekend"), checked:
 * the message must say it's for many (all, every, a percentage), its scope
 * must be in the message, and every number and date must be written in it.
 */
export function bulkAction(parsed: Record<string, unknown>, message: string, now: Date, currency: string): AssistantAction {
  const ask = (text: string): AssistantAction => ({ type: "reply", text, link: null });
  if (!RULE_WORDS.test(message)) return { type: "unclear" };
  let scope: BulkScope = BULK_SCOPES.has(parsed.scope as BulkScope) ? (parsed.scope as BulkScope) : "all";
  const words = typeof parsed.words === "string" && parsed.words.trim() ? parsed.words.trim().slice(0, 80) : null;
  if (scope === "matching") {
    if (!words || !namesAProduct(words) || !productBacked(words, message)) {
      return ask("Which products? Say it as a rule, e.g. \"10% off all perfumes\" or \"turn off everything out of stock\".");
    }
  } else {
    const backed = SCOPE_WORDS_RE[scope];
    if (backed && !backed.test(message)) scope = "all";
  }
  const numbers = messageNumbers(message);
  const pctMatch = message.match(PCT_RE);
  const pctValue = pctMatch ? parseFloat(pctMatch[1]) : null;
  let change: LiveChange | null = null;

  if (parsed.price_pct != null) {
    if (pctValue == null || !(pctValue > 0) || pctValue > 90) return ask("By what percentage? e.g. \"raise all prices by 5%\".");
    const sign = DOWN_WORDS.test(message) ? -1 : UP_WORDS.test(message) ? 1 : Math.sign(Number(parsed.price_pct)) || 1;
    change = { kind: "price_pct", pct: sign * pctValue };
  } else if (parsed.sale_pct != null) {
    if (pctValue == null || !(pctValue > 0) || pctValue > 90) return ask("How much off? e.g. \"10% off all perfumes this weekend\".");
    const window = saleWindow(message, now);
    if (!window) return ask(`A sale on Jumia needs its dates. Say them with it, e.g. "${pctValue}% off ${words ? `all ${words}` : "everything"} from 10 Oct to 20 Oct", or "this weekend".`);
    change = { kind: "sale_pct", pct: pctValue, start: window.start, end: window.end };
  } else if (parsed.stock != null) {
    const n = Number(parsed.stock);
    const outWords = /\b(out of stock|sold out|none left|finished|no more)\b/i.test(message);
    if (!(Number.isInteger(n) && n >= 0 && (numbers.includes(n) || (n === 0 && outWords)))) return ask("What should their stock be? Send it with the rule, e.g. \"set all the kettles' stock to 10\".");
    change = { kind: "stock", stock: n };
  } else if (parsed.price != null) {
    const n = Number(parsed.price);
    if (!(n > 0 && numbers.includes(n)) || pctValue != null) return ask("What price? e.g. \"set all the phone cases to 50\".");
    change = { kind: "price", price: n };
  } else if (parsed.sale_price != null) {
    const n = Number(parsed.sale_price);
    const price = n > 0 && numbers.includes(n) ? n : extractSalePrice(message, now, currency)?.salePrice ?? null;
    if (price == null) return ask("What sale price? e.g. \"all the phone cases on sale at 40 this weekend\".");
    const window = saleWindow(message, now);
    if (!window) return ask(`A sale on Jumia needs its dates, e.g. "sale ${price} from 10 Oct to 20 Oct".`);
    change = { kind: "sale", sale: { price, start: window.start, end: window.end } };
  } else if (parsed.sale === "end") {
    if (!END_SALE_WORDS.test(message)) return { type: "unclear" };
    change = { kind: "sale", sale: null };
  } else if (parsed.active === true || parsed.active === false) {
    if (parsed.active === false ? !OFF_WORDS.test(message) : !ON_WORDS.test(message)) return { type: "unclear" };
    change = { kind: "status", active: parsed.active };
  }
  if (!change) return ask("What should change on them? e.g. \"raise all prices by 5%\", \"turn off everything out of stock\", \"10% off all perfumes this weekend\".");
  return { type: "bulk", scope, words: scope === "matching" ? words : null, change };
}

const REWRITE_WORDS = /\b(rewrite|re-write|improve|better|write|redo|re-do|optimi[sz]e|polish|fix|make (it|the \w+) (better|nicer|attractive|catchy|professional))\b/i;

/** A live product's content change, checked: its text copied from the message, or a rewrite they asked for. */
export function contentAction(parsed: Record<string, unknown>, message: string, context: string): AssistantAction {
  const ask = (text: string): AssistantAction => ({ type: "reply", text, link: null });
  const product = typeof parsed.product === "string" ? parsed.product.trim().slice(0, 120) : "";
  if (!namesAProduct(product) || !(productBacked(product, message) || productBacked(product, context))) {
    return ask("Which product? Tell me its name as it shows on Jumia, e.g. \"rewrite the description of the Hisense fridge\".");
  }
  const request: ContentRequest = {};
  for (const key of ["name", "description", "highlights", "brand"] as const) {
    const v = parsed[key];
    if (typeof v === "string" && v.trim() && saidInMessage(v, message)) request[key] = v.trim();
  }
  const rewrite = (Array.isArray(parsed.rewrite) ? parsed.rewrite : [])
    .filter((f): f is "name" | "description" | "highlights" => f === "name" || f === "description" || f === "highlights")
    .filter((f) => !request[f]);
  if (rewrite.length > 0 && REWRITE_WORDS.test(message)) { request.rewrite = Array.from(new Set(rewrite)); request.instructions = message.slice(0, 400); }
  if (Object.keys(request).length === 0) {
    return ask("What should I change on it? Write the new name, or say \"rewrite its description\", e.g. \"change the blender's name to Silver Crest 3 in 1 Blender 1.5L\".");
  }
  return { type: "content_change", product, request };
}

/** "How many of my products are on", "...live on Jumia, on and off": the shop's overview. */
const SHOP_COUNT = /\bhow many\b[^.?!]*\b(products?|items?|listings?)\b[^.?!]*\b(on|off|live|active|inactive|turned|deactivated|enabled|disabled)\b|\bhow many\b[^.?!]*\b(products?|items?)\b[^.?!]*\b(do i have|have i got|in my (shop|store)|on jumia)\b/i;

/** The AI's reply as an action our code can carry out, or unclear. */
export function parseAction(
  raw: string, message: string, products: ProductFacts[], links: Record<string, AssistantLink> = {}, currency = "GHS",
  opts: { context?: string; stage?: Stage; now?: Date } = {},
): AssistantAction {
  const action = parseActionRaw(raw, message, products, links, currency, opts);
  // Owner's test, 2026-10-07: "How many of my products are on" went to a
  // product search, and "...live on JUMIA is on and off" was answered "I
  // can't tell you". The overview has those counts.
  if (SHOP_COUNT.test(message) && !/\b(out of stock|low|sold|orders?|listed|list(ed)? (today|this))\b/i.test(message)
    && (action.type === "product_info" || action.type === "reply" || action.type === "unclear" || action.type === "stock")) {
    return { type: "shop", filter: "all" };
  }
  return action;
}

function parseActionRaw(
  raw: string, message: string, products: ProductFacts[], links: Record<string, AssistantLink> = {}, currency = "GHS",
  opts: { context?: string; stage?: Stage; now?: Date } = {},
): AssistantAction {
  const now = opts.now ?? new Date();
  const context = opts.context ?? "";
  const ask = (text: string): AssistantAction => ({ type: "reply", text, link: null });
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
    case "live_change":
      return liveChangeAction(parsed, message, context, now, currency);
    case "product_info":
    case "info": {
      const product = typeof parsed.product === "string" ? parsed.product.trim().slice(0, 120) : "";
      if (!namesAProduct(product)) return ask("Which product? Tell me its name as it shows on Jumia, e.g. \"is the Hisense fridge live?\".");
      return productBacked(product, message) || productBacked(product, context)
        ? { type: "product_info", product } : ask("Which product? Tell me its name as it shows on Jumia, e.g. \"is the Hisense fridge live?\".");
    }
    case "fees":
    case "calculator": {
      const product = typeof parsed.product === "string" ? parsed.product.trim().slice(0, 120) : "";
      const n = Number(parsed.price);
      const price = n > 0 && messageNumbers(message).includes(n) ? n : null;
      if (!namesAProduct(product) || !(productBacked(product, message) || productBacked(product, context))) {
        return ask("Which product? Tell me its name, e.g. \"how much do I get if the creatine sells\", or send its price and category to the calculator.");
      }
      return { type: "fees", product, price };
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
      const said = (t: string) => t.replace(/\D/g, " ").split(/\s+/).includes(number);
      return number.length >= 5 && (said(message) || said(context))
        ? { type: "order_status", number } : ask("Which order? Send its number, e.g. \"where is order 355926919\".");
    }
    case "sales": {
      const asStatus = (v: unknown) => (typeof v === "string" ? ORDER_STATUSES[v.toLowerCase().trim().replace(/[\s-]+/g, "_")] ?? null : null);
      const list = Array.from(new Set((Array.isArray(parsed.status) ? parsed.status : [parsed.status]).map(asStatus).filter((s): s is string => !!s)));
      // "past time", "ever": as far back as Jumia goes.
      const period = parsed.period === "all" || parsed.period === "ever" || parsed.period === "90days" ? "quarter" : asPeriod(parsed.period, "week");
      return { type: "sales", period, status: list.length === 0 ? null : list.length === 1 ? list[0] : list };
    }
    case "listings":
      return { type: "listings", period: asPeriod(parsed.period, "today") };
    case "note":
      return opts.stage === "starting" ? { type: "note" } : { type: "unclear" };
    case "payouts":
      return { type: "payouts" };
    case "payout_detail": {
      const statement = typeof parsed.statement === "string" && parsed.statement.trim() && saidInMessage(parsed.statement, message)
        ? parsed.statement.trim().slice(0, 40) : null;
      return { type: "payout_detail", mode: parsed.mode === "history" ? "history" : "breakdown", statement };
    }
    case "report": {
      const kinds = new Set<ReportKind>(["best_sellers", "slow_movers", "restock", "returns"]);
      if (!kinds.has(parsed.kind as ReportKind)) return { type: "unclear" };
      return { type: "report", kind: parsed.kind as ReportKind, period: asPeriod(parsed.period, "month") };
    }
    case "bulk":
      return bulkAction(parsed, message, now, currency);
    case "content_change":
      return contentAction(parsed, message, context);
    case "brand_check": {
      const brand = typeof parsed.brand === "string" ? parsed.brand.trim().slice(0, 60) : "";
      if (!brand || !saidInMessage(brand, message)) return ask("Which brand? e.g. \"is Lattafa a brand on Jumia?\".");
      const product = typeof parsed.product === "string" && parsed.product.trim() && productBacked(parsed.product, message) ? parsed.product.trim().slice(0, 80) : null;
      return { type: "brand_check", brand, product };
    }
    case "category_info": {
      const product = typeof parsed.product === "string" ? parsed.product.trim().slice(0, 80) : "";
      return product && productBacked(product, message) ? { type: "category_info", product } : ask("What kind of product? e.g. \"what does Jumia need to list a perfume?\".");
    }
    case "shops":
      return { type: "shops" };
    case "polish": {
      const n = typeof parsed.product === "number" ? parsed.product : parseInt(String(parsed.product ?? ""), 10);
      return { type: "polish", seq: Number.isInteger(n) && n > 0 && new RegExp(`\\b${n}\\b`).test(message) ? n : null };
    }
    case "health_report": case "health": case "shop_health":
      return { type: "health_report" };
    case "warehouse_stock": {
      const product = typeof parsed.product === "string" ? parsed.product.trim().slice(0, 120) : "";
      return namesAProduct(product) && productBacked(product, message)
        ? { type: "warehouse_stock", product } : ask("Which product? e.g. \"how many kettles are in Jumia's warehouse?\".");
    }
    case "warehouse_order": {
      const numbers = messageNumbers(message);
      const items = (Array.isArray(parsed.items) ? parsed.items : []).flatMap((i) => {
        const r = (i && typeof i === "object" ? i : {}) as Record<string, unknown>;
        const product = typeof r.product === "string" ? r.product.trim().slice(0, 120) : "";
        const quantity = Number(r.quantity);
        return namesAProduct(product) && productBacked(product, message) && Number.isInteger(quantity) && quantity > 0 && numbers.includes(quantity)
          ? [{ product, quantity }] : [];
      });
      if (items.length === 0) return ask("Which products, and how many of each? e.g. \"send 50 of the kettle to Jumia's warehouse on 20 Oct\".");
      return { type: "warehouse_order", items, date: findDateIn(message, now) };
    }
    case "warehouse_shipped": {
      const po = typeof parsed.po === "string" ? parsed.po.trim().slice(0, 40) : "";
      const tracking = typeof parsed.tracking === "string" ? parsed.tracking.trim().slice(0, 60) : "";
      if (!po || !tracking || !saidInMessage(po, message) || !saidInMessage(tracking, message)) {
        return ask("Send the delivery order's number and its tracking number, e.g. \"PO 123AB shipped, tracking DHL998877\".");
      }
      const carrier = typeof parsed.carrier === "string" && parsed.carrier.trim() && saidInMessage(parsed.carrier, message) ? parsed.carrier.trim().slice(0, 60) : null;
      return { type: "warehouse_shipped", po, tracking, carrier };
    }
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
      if (!Array.isArray(parsed.edits)) return { type: "unclear" };
      if (products.length === 0) {
        // No drafts here: "the stock of the freezer, the blender and the
        // chainsaw should be made 10" came back as an edit (live,
        // 2026-10-07). It's about products in their Jumia shop.
        const e = (parsed.edits as Record<string, unknown>[]).find((x) => x && typeof x.said === "string" && x.changes && typeof x.changes === "object");
        if (!e) return { type: "unclear" };
        const c = e.changes as Record<string, unknown>;
        const value = c.quantity != null ? { stock: c.quantity } : c.price != null ? { price: c.price } : null;
        return value ? liveChangeAction({ products: splitProducts(String(e.said)), ...value }, message, context, now, currency) : { type: "unclear" };
      }
      const edits: EditPart[] = [];
      const dropped = new Set<string>();
      const misnamed: { said: string; changes: unknown }[] = [];
      for (const e of parsed.edits as Record<string, unknown>[]) {
        if (!e || typeof e !== "object") continue;
        let seqs = seqsOf(e.products);
        // The draft must be the product they named: "set the gold medal to
        // 25" once changed a draft of gold-tone earrings (live, 2026-10-07).
        const said = typeof e.said === "string" ? e.said.trim() : "";
        if (said && seqs.length > 0) {
          const fits = seqs.filter((seq) => fitsDraft(said, products.find((p) => p.seq === seq)?.listing.title ?? null));
          if (fits.length === 0) { misnamed.push({ said, changes: e.changes }); continue; }
          seqs = fits;
        }
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
      if (edits.length === 0 && misnamed.length > 0) {
        // Not one of the drafts: a product already in their Jumia shop.
        const m = misnamed[0];
        const c = (m.changes && typeof m.changes === "object" ? m.changes : {}) as Record<string, unknown>;
        const numbers = messageNumbers(message);
        const price = Number(c.price);
        const qty = Number(c.quantity);
        if (productBacked(m.said, message)) {
          if (price > 0 && numbers.includes(price)) return { type: "live_change", product: m.said, change: { kind: "price", price } };
          if (Number.isInteger(qty) && qty >= 0 && numbers.includes(qty)) return { type: "live_change", product: m.said, change: { kind: "stock", stock: qty } };
        }
        return ask(`"${m.said.slice(0, 60)}" isn't one of the drafts here. Say which draft by its number, or, for a product already on Jumia, e.g. "set the ${m.said.slice(0, 40)}'s price to 150".`);
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

/** Models app_settings `assistant_model` may switch to; anything else is ignored. */
const MODELS = new Set(["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3.1-flash-lite"]);

/** The model the assistant uses: app_settings `assistant_model`, else ASSISTANT_MODEL. */
export async function assistantModel(): Promise<string> {
  try {
    const { data } = await createServerClient().from("app_settings").select("value").eq("key", "assistant_model").maybeSingle();
    return typeof data?.value === "string" && MODELS.has(data.value) ? data.value : ASSISTANT_MODEL;
  } catch {
    return ASSISTANT_MODEL;
  }
}

/**
 * The last messages with this seller, oldest first, as "Seller: …" / "Bot:
 * …" lines, without the one being answered. Taps on buttons read as such.
 */
export async function recentConversation(phone: string, current: string, max = 8): Promise<string[]> {
  try {
    const { data } = await createServerClient()
      .from("whatsapp_message_log")
      .select("direction, message_type, body_text, created_at")
      .eq("phone_number", phone)
      .order("created_at", { ascending: false })
      .limit(max + 1);
    const rows = ((data ?? []) as { direction: string; message_type: string | null; body_text: string | null; created_at: string }[])
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const lastIn = rows[rows.length - 1];
    if (lastIn && lastIn.direction === "inbound" && (lastIn.body_text ?? "").trim() === current.trim()) rows.pop();
    return rows.slice(-max).map((r) => {
      const body = (r.body_text ?? "").trim();
      const shown = !body ? (r.message_type === "image" ? "[a photo]" : "[a message]")
        : /^[a-z_]+:\S+$/i.test(body) ? "[tapped a button]" : body.replace(/\s+/g, " ").slice(0, 300);
      return `${r.direction === "inbound" ? "Seller" : "Bot"}: ${shown}`;
    });
  } catch {
    return [];
  }
}

export async function interpret(
  userId: string,
  stage: Stage,
  products: ProductFacts[],
  message: string,
  opts: { batchId?: string | null; hintSeq?: number; conversation?: string[]; web?: boolean } = {},
): Promise<{ action: AssistantAction; links: Record<string, AssistantLink>; raw: string }> {
  const [currency, seller, model, listingCost] = await Promise.all([
    shopCurrencyForUser(userId), sellerFacts(userId), assistantModel(), listingCreditCost(userId).catch(() => LIVE_LISTING_CREDIT_COST),
  ]);
  const links = assistantLinks({ batchId: opts.batchId, countrySlug: seller.countrySlug });
  const conversation = opts.conversation ?? [];
  const prompt = buildPrompt(stage, message, { products, currency, seller: seller.lines, links, hintSeq: opts.hintSeq, conversation, listingCost, web: opts.web });
  const { text } = await withAiUsageContext({ feature: "assistant", userId }, () =>
    callGeminiBackend(model, [{ text: prompt }], model.startsWith("gemini-3") ? { preferBackend: "ai-studio" } : {}));
  const action = parseAction(text, message, products, links, currency, { context: conversation.join("\n"), stage });
  return { action, links, raw: text };
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
    if (update.sale_price != null) {
      await carrySaleToVariants(listing.id, listing, {
        salePrice: update.sale_price as number, startDate: update.sale_start_date as string, endDate: update.sale_end_date as string,
      });
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

async function logTurn(userId: string, stage: Stage, message: string, action: AssistantAction | null, outcome: string, raw?: string): Promise<void> {
  try {
    await createServerClient().from("whatsapp_assistant_log").insert({
      user_id: userId, stage, message: message.slice(0, 1000), action, outcome, ...(raw != null ? { raw: raw.slice(0, 2000) } : {}),
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn(`[assistant] log failed: ${(e as Error).message}`);
  }
}

/** The live product the seller last changed (or chose to), within half an hour: what "it" means next. */
async function lastChangedSid(userId: string): Promise<string | null> {
  const { data } = await createServerClient().from("jumia_product_changes").select("product_sid, created_at").eq("user_id", userId)
    .order("created_at", { ascending: false }).limit(5);
  const rows = ((data ?? []) as { product_sid: string | null; created_at: string }[])
    .filter((r) => r.product_sid && Date.now() - new Date(r.created_at).getTime() < 30 * 60_000)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return rows[0]?.product_sid ?? null;
}

export async function creditsReply(userId: string, phone: string): Promise<void> {
  if (await isUnmetered(userId)) {
    await sendTextIfConfigured(phone, "Your account isn't charged credits right now, so list as much as you like.");
    return;
  }
  const available = Math.max(0, await availableCredits(userId));
  const shown = Math.round(available * 100) / 100;
  const cost = await listingCreditCost(userId);
  await sendCtaUrlIfConfigured(
    phone,
    `You have ${shown} credit${shown === 1 ? "" : "s"}: ${creditReach(shown, cost)}. A listing costs ${cost} credits when it goes live on Jumia.`,
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

  // The day's allowance and the global ceiling (lib/whatsapp/assistant-limits.ts):
  // past them, the fixed flow answers ("failed" runs the usual handling).
  // The seller is told once a day; that message is the whole reply.
  const gate = await assistantGate(userId).catch(() => ({ ok: true }) as const);
  if (!gate.ok) {
    if (gate.reason === "allowance" && !gate.told) {
      await sendTextIfConfigured(phone, allowanceText(gate.allowance));
      await logTurn(userId, stage, text, null, ALLOWANCE_TOLD);
      return "handled";
    }
    console.info(`[assistant] ${userId}: ${gate.reason === "ceiling" ? "daily ceiling reached" : "over daily allowance"}, fixed flow`);
    return "failed";
  }

  const batchId = stage === "review" ? session.batchId : stage === "sent" ? session.lastSubmittedBatchId : null;
  let action: AssistantAction;
  let links: Record<string, AssistantLink>;
  let raw: string;
  let products: ProductFacts[] = [];
  try {
    const conversation = await recentConversation(phone, text);
    products = batchId ? await productFacts(await batchListings(batchId, userId)) : [];
    ({ action, links, raw } = await interpret(userId, stage, products, text, { batchId, hintSeq, conversation, web: isWebAddress(phone) }));
  } catch (e) {
    console.warn(`[assistant] interpreting for ${userId} failed: ${(e as Error).message}`);
    await logTurn(userId, stage, text, null, `failed: ${(e as Error).message}`);
    return "failed";
  }
  console.info(`[assistant] ${userId} (${stage}): ${action.type}`);

  if (action.type === "list" && stage !== "review" && stage !== "starting") {
    await logTurn(userId, stage, text, action, `list ${action.count}`, raw);
    return { list: action.count };
  }

  const outcome = await carryOut(userId, phone, stage, batchId, products, action, text, links, session);
  await logTurn(userId, stage, text, action, outcome, raw);
  // Starting a batch: after answering, where they are (a reply carries it already).
  if (stage === "starting" && action.type !== "reply" && outcome !== "default" && outcome !== "stopped batch" && outcome !== "kept batch") {
    await sendTextIfConfigured(phone, startingNudge(session));
  }
  return outcome === "default" ? "default" : "handled";
}

async function carryOut(
  userId: string, phone: string, stage: Stage, batchId: string | null, products: ProductFacts[], action: AssistantAction, text: string,
  links: Record<string, AssistantLink>, session: WhatsAppSession,
): Promise<string> {
  switch (action.type) {
    case "note":
      return "default";
    case "listings":
      return answerListings(userId, phone, action.period);
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
        const EXAMPLES: Record<string, string> = {
          price: "price 150", quantity: "quantity 20", variations: "variation Large", name: "name Hisense 205L Double Door Fridge",
          colour: "colour Blue", brand: "brand Hisense",
        };
        const examples = action.dropped.map((d) => `"${EXAMPLES[d] ?? d}"`).join(" or ");
        lines.push(`⚠️ I couldn't see the new ${action.dropped.join(" or ")} in your message. Write it out, e.g. ${examples}.`);
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
      if (stage === "starting") {
        if (action.type === "list") {
          await sendTextIfConfigured(phone, `You're set up for ${session.batchSize ?? 1} product${session.batchSize === 1 ? "" : "s"}. Say *restart* to change the number.`);
          return "kept batch";
        }
        await resetSession(phone);
        await sendTextIfConfigured(phone, "OK, I've stopped this batch. Tell me what you'd like to do for your Jumia shop, or how many products you're listing when you're ready.");
        return "stopped batch";
      }
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
      return proposeLiveChange(userId, phone, action.others ? [action.product, ...action.others] : action.product, action.change, {
        preferSid: action.fromContext ? await lastChangedSid(userId) : null,
        ...(action.all ? { all: true } : {}),
      });
    case "product_info":
      return answerProductInfo(userId, phone, action.product);
    case "fees": {
      // A draft here ("what will I get for the wig?") is worked out from the draft.
      const draft = products.find((p) => fitsDraft(action.product, p.listing.title) && namesAProduct(action.product) && draftWords(action.product).length > 0);
      return answerFees(userId, phone, action.product, action.price, draft ? {
        name: draft.listing.title ?? "Your product", price: draft.listing.selling_price ?? null, categoryPath: draft.listing.category_path ?? null,
      } : undefined);
    }
    case "stock":
      return answerStock(userId, phone, action.product, action.filter);
    case "shop":
      return answerProducts(userId, phone, action.filter);
    case "order_status":
      return answerOrderStatus(userId, phone, action.number);
    case "sales":
      return answerSales(userId, phone, action.period, action.status);
    case "payouts":
      return answerPayouts(userId, phone);
    case "payout_detail":
      return answerPayoutDetail(userId, phone, action.mode, action.statement);
    case "report":
      return answerReport(userId, phone, action.kind, action.period);
    case "bulk":
      return proposeBulkChange(userId, phone, action.scope, action.words, action.change);
    case "content_change":
      return proposeContentChange(userId, phone, action.product, action.request);
    case "brand_check":
      return answerBrand(userId, phone, action.brand, action.product);
    case "category_info":
      return answerCategoryNeeds(userId, phone, action.product);
    case "shops":
      return answerLinkedShops(userId, phone);
    case "polish": {
      const { runChatCommand } = await import("@/lib/whatsapp/chat-commands");
      await runChatCommand({ type: "polish", seq: action.seq }, userId, phone, session);
      return "polish";
    }
    case "health_report": {
      const { answerHealthReport } = await import("@/lib/whatsapp/shop-health");
      return answerHealthReport(userId, phone);
    }
    case "warehouse_stock":
      return answerWarehouseStock(userId, phone, action.product);
    case "warehouse_order":
      return proposeWarehouseOrder(userId, phone, action.items, action.date);
    case "warehouse_shipped":
      return proposeWarehouseShipped(userId, phone, action.po, action.tracking, action.carrier);
    case "reply": {
      // The AI's own words. With a link, it's the button; in review, the
      // reply keeps the step's own two buttons. Starting a batch, where
      // they are goes in the same message (one message, not two).
      const link = action.link ? links[action.link] : null;
      const text = stage === "starting" ? `${action.text}\n\n${startingNudge(session)}` : action.text;
      if (action.awaiting) {
        const ask: LiveValueAsk = {
          kind: "live_value", field: action.awaiting.field, products: action.awaiting.products,
          preferSid: action.awaiting.fromContext ? await lastChangedSid(userId) : null, at: new Date().toISOString(),
        };
        await updateSession(phone, { assistantPending: ask });
      }
      if (link) await sendCtaUrlIfConfigured(phone, text, link.label, link.url);
      else if (stage === "review") await sendButtonsIfConfigured(phone, text, [SUBMIT_ALL, REVIEW]);
      else await sendTextIfConfigured(phone, text);
      return link ? `replied with ${action.link}` : action.awaiting ? `asked for ${action.awaiting.field}` : "replied";
    }
    case "unclear":
      return "default";
  }
  return "default";
}

const startingNudge = (session: WhatsAppSession) =>
  `📸 I'm still ready for product ${session.batchSeq ?? 1} of ${session.batchSize ?? 1}: send its photos when you're ready, or say *restart* to stop.`;

/** A "What should its stock be?" older than this is no longer what a number answers. */
const LIVE_VALUE_TTL_MS = 10 * 60_000;

/**
 * The answer to the assistant's "What should its stock be?" about live
 * products: a bare number ("10", "stock 10", "GHS 150"). The change is then
 * offered for its tap as usual. Anything else drops the question (false):
 * the message is handled as usual. A bare "10" used to start a batch of 10
 * here (owner's second test, 2026-10-07).
 */
export async function answerLiveValue(userId: string, phone: string, session: WhatsAppSession, text: string | undefined): Promise<boolean> {
  const pending = session.assistantPending;
  if (!pending || !("kind" in pending) || pending.kind !== "live_value") return false;
  const fresh = Date.now() - new Date(pending.at).getTime() < LIVE_VALUE_TTL_MS;
  const m = (text ?? "").trim().match(/^(?:(?:stock|qty|quantity|price|make it|set it to|to|it'?s|=)\s*:?\s*)?(?:[a-z]{3}|gh₵|₦|₵)?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:pcs|pieces|units|each|cedis|naira)?\s*[.!]?$/i);
  await updateSession(phone, { assistantPending: null });
  if (!fresh || !m) return false;
  const n = parseFloat(m[1].replace(/,/g, ""));
  const change: LiveChange | null = pending.field === "stock"
    ? (Number.isInteger(n) && n >= 0 ? { kind: "stock", stock: n } : null)
    : (n > 0 ? { kind: "price", price: n } : null);
  if (!change) return false;
  const outcome = await proposeLiveChange(userId, phone, pending.products.length === 1 ? pending.products[0] : pending.products, change, { preferSid: pending.preferSid });
  await logTurn(userId, "idle", text ?? "", null, `answered ${pending.field}: ${outcome}`);
  return true;
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
  if (!pending || "kind" in pending) return false;
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

// ─── A question, not a product's notes ────────────────────────────────────

const QUESTION_START = /^(has|have|what|how|when|where|why|who|which|can|could|do|does|did|is|are|will|would|should|i won'?t|i don'?t|i do not|never ?mind|cancel|stop|forget it|no more|not now|i changed my mind)\b/i;

/**
 * Whether a message sent while starting a batch reads as something said to
 * the bot rather than about the product: a question, or calling it off.
 * "Price 200, sizes M and L" isn't; "Has Jumia paid me?" is.
 */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  return t.includes("?") || QUESTION_START.test(t);
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
