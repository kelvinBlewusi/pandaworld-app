/**
 * Step 2 of the assistant reliability plan: "one front door"
 * (https://claude.ai/artifact/8f6i4rjVFvPyG8EcKFHs5n). First built as a
 * prototype the test set (lib/evals/assistant-eval.ts) ran beside the live
 * path (owner, 2026-10-08: "can we test what we had wanted to build against
 * what we have now without affecting anything?"): 97.5% against 94.0%, at a
 * third of the AI cost. Now the chat reads messages through it for the
 * accounts app_settings `assistant_front_door` names (frontDoorFor in
 * lib/whatsapp/assistant.ts), the owner's first (owner: "go ahead with
 * building step 2").
 *
 * How it reads a message, in a fixed order:
 *   1. Context as one record: where they are, the bot's open question and
 *      what kind of answer fits it, the drafts, the products just listed,
 *      the last few messages.
 *   2. Route: one small call picks the area (listing, drafts, live
 *      products, shop info, orders, money, account/help, chat).
 *   3. Read: one call with only that area's actions returns the action in
 *      the chat's own JSON format, or "clarify" with options when a needed
 *      detail is missing or could mean two things. It never guesses a
 *      value.
 *   4. Safety: the chat's own checks (parseActionUnguarded: values in the
 *      message, products named, nothing widened). None of the chat's word
 *      rules.
 */

import { callGeminiBackend } from "@/lib/ai/gemini-client";
import { withAiUsageContext } from "@/lib/ai/usage";
import { siteGuide } from "@/lib/whatsapp/site-guide";
import {
  capabilities, parseActionUnguarded, type AssistantAction, type AssistantLink, type ProductFacts, type Stage,
} from "@/lib/whatsapp/assistant";

export type Area = "listing" | "drafts" | "live_products" | "shop_info" | "orders" | "money" | "account_help" | "chat";
const AREAS = new Set<Area>(["listing", "drafts", "live_products", "shop_info", "orders", "money", "account_help", "chat"]);

/** The prototype's own answer when it asks instead of guessing. */
export interface Clarify { type: "clarify"; question: string; options: string[] }
export type FrontDoorAction = AssistantAction | Clarify;

export interface FrontDoorInput {
  stage:        Stage;
  message:      string;
  conversation: string[];
  drafts:       ProductFacts[];
  /** The products the bot last listed for them; `items`, one line each with where it is (on/off, quality check, stock). */
  listed:       { count: number; what: string; items?: string[] } | null;
  waitingFor?:  string;
  seller:       string[];
  links:        Record<string, AssistantLink>;
  currency:     string;
  web:          boolean;
  /** Names of their Jumia products (the shop's local copy, jumia_products). */
  shopNames?:   string[];
  /** What a listing costs them, for what PandaWorld can do. */
  listingCost?: number;
  /** "product 2 of 3", while a batch's photos come in. */
  position?:    string;
  /** What the assistant remembers of them (lib/whatsapp/seller-memory.ts). */
  memory?:      string;
}

export interface FrontDoorModels { router: string; reader: string }

/** The sorting call's model: Flash-Lite sorted as well as Flash, in half the time (8 Oct test runs). */
export const FRONT_DOOR_ROUTER = "gemini-2.5-flash-lite";

// ─── 1. Context as one record ────────────────────────────────────────────────

const STAGES: Record<Stage, string> = {
  idle:       "Between batches: nothing is being listed right now.",
  starting:   "They have just started listing a batch; no photo has come yet.",
  collecting: "They are sending a batch's products: photos with each product's details.",
  drafting:   "Their batch is being drafted by AI right now.",
  review:     "Their batch is drafted; the drafts below wait to be checked and submitted.",
  sent:       "They have just submitted their batch to Jumia.",
};

const ASKING_RE = /\b(please (?:provide|send|give|share|tell|write|type)|send me|tell me|let me know|reply with|what should)\b/i;

/** The bot's question still open, and what kind of answer fits it; null when none. Pure. */
export function openQuestion(input: Pick<FrontDoorInput, "stage" | "conversation" | "waitingFor">): { about: string; fits: string } | null {
  if (input.waitingFor) return { about: input.waitingFor, fits: "a value or a short answer to it" };
  if (input.stage === "collecting" || input.stage === "starting") {
    return { about: "the product being sent: its photos and details", fits: "its details (price, sizes, colours, quantity, brand, condition, SKU, notes) or saying its photos are done" };
  }
  const lastBot = [...input.conversation].reverse().find((l) => l.startsWith("Bot:"))?.slice(4).trim() ?? "";
  if (/how many products/i.test(lastBot)) return { about: "how many products they are listing now", fits: "a number of products to list, or wanting to list" };
  // A question, or the bot asking them for something ("please provide the
  // new description text for …", owner's web chat, 2026-10-08).
  if (/\?\s*$/.test(lastBot) || ASKING_RE.test(lastBot)) return { about: lastBot.slice(0, 300), fits: "an answer to it, or what it asked for (a value, a text, a choice)" };
  return null;
}

const draftLine = (p: ProductFacts, currency: string) => [
  `${p.seq}. "${p.listing.title ?? "(no name yet)"}"`,
  `price ${p.listing.selling_price != null ? `${currency} ${p.listing.selling_price}` : "not set"}`,
  `variation(s): ${p.variations.length ? p.variations.join(", ") : "none"}`,
  p.options.length ? `its category's variation options: ${p.options.slice(0, 60).join(", ")}` : null,
].filter(Boolean).join(" · ");

const words = (t: string) => t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

/** Their products whose names share at least two words with the message, so a name sent on its own is recognised. Pure. */
export function namesInMessage(message: string, names: string[]): string[] {
  const said = new Set(words(message));
  return names.filter((n) => words(n).filter((w) => said.has(w)).length >= Math.min(2, said.size)).slice(0, 5);
}

/** The context record as the AI reads it. Pure. */
export function contextText(input: FrontDoorInput): string {
  const q = openQuestion(input);
  const named = namesInMessage(input.message, input.shopNames ?? []);
  return [
    `Where they are: ${STAGES[input.stage]}${input.position ? ` (${input.position})` : ""}`,
    `The bot's open question: ${q ? `${q.about}. What answers it: ${q.fits}. Anything else is a new request and closes the question.` : "none"}`,
    `Drafts in their batch: ${input.drafts.length ? `\n${input.drafts.map((p) => draftLine(p, input.currency)).join("\n")}` : "none"}`,
    `Products you last listed for them: ${input.listed ? `${input.listed.count} (${input.listed.what}). "Those", "them", "all of them" and "the last N" mean these; "the approved ones", "the rejected ones", "the first one" pick among them.${input.listed.items?.length ? `\n${input.listed.items.slice(0, 30).map((l, i) => `${i + 1}. ${l}`).join("\n")}` : ""}` : "none"}`,
    ...(named.length ? [`Products in their Jumia shop the message names: ${named.map((n) => `"${n}"`).join(", ")}`] : []),
    `Recent conversation (oldest first):${input.conversation.length ? `\n${input.conversation.slice(-6).join("\n")}` : " none"}`,
    `Their new message: "${input.message.replace(/"/g, "'").slice(0, 600)}"`,
  ].join("\n");
}

// ─── 2. Route ────────────────────────────────────────────────────────────────

function routerPrompt(input: FrontDoorInput): string {
  return [
    "You sort one message a Jumia seller sent to PandaWorld's assistant into the area it is about. You do not answer it.",
    "",
    "Areas:",
    "- listing: listing NEW products now (how many, start, stop or restart a batch), or, while a product is being sent, that product's details",
    "- drafts: changing, submitting, polishing or deleting the drafts listed below (only when there are drafts)",
    "- live_products: changing products already in their Jumia shop: stock, price, sale, on/off, name or description, many at once",
    "- shop_info: questions about their Jumia products: is one live/approved, stock, lists (newest, rejected, off, out of stock), counts, reports, a product's details",
    "- orders: their orders and sales: what sold and how much the shop made in a period, cancelled, returned, delivered, one order by its number, orders to pack",
    "- money: their PandaWorld credits; Jumia's payouts and statements (what Jumia paid them or still owes); what Jumia takes when a product sells",
    "- account_help: their PandaWorld account and pack, the packs on offer, WhatsApp or Jumia connection, their shop's name, what PandaWorld does, links, how-to",
    "- chat: greetings, thanks, short reactions (\"ok\", \"really?\"), questions about this chat itself, small talk, anything outside Jumia and PandaWorld",
    "",
    contextText(input),
    "",
    "Rules:",
    "- Read the message for what they want now. The open question is context: a message that doesn't fit what answers it is a new request.",
    "- A message that answers the open question belongs to the area the question was about (a description the bot asked for a live product is live_products).",
    "- drafts only when the message is about one of the drafts listed above. A product already in their shop that the conversation is about stays live_products, even while drafts wait.",
    "- A change to a product (\"change the drone to 10\", \"restock the kettle\", \"set X to 50 pcs\") is live_products, or drafts when it names one of the drafts. Never listing.",
    "- A product's name on its own after you listed products is shop_info: they want that product's details.",
    "- An order number (e.g. #394666919) is orders. How much they made or sold is orders, not money.",
    "- Typos and other languages are normal.",
    "",
    'Reply with JSON only: {"area":"<one area>"}',
  ].join("\n");
}

// ─── 3. Read, within the area ────────────────────────────────────────────────

const CLARIFY = '{"type":"clarify","question":"<one short question, ending with ?>","options":["<2 or 3 answers they can tap, each up to 20 characters and clear on its own, e.g. \\"Stock to 10\\", not \\"10\\">"]} - only when you can\'t tell which action or which product they mean, or a change is missing the value to set (e.g. "change the drone to 10": its stock or its price?).';
const REPLY = '{"type":"reply","text":"<your message>","link":"<a link key, or null>"} - a question you answer in a line or two; a hello; anything this area\'s actions don\'t cover.';

const ACTIONS: Record<Area, string[]> = {
  listing: [
    '{"type":"list","count":<number>} - they want to list new products now and give how many ("2 shirts and a fridge" is 3).',
    '{"type":"restart"} - they want to list but give no number, or start a new batch, or stop or start over the batch they are sending.',
    '{"type":"step"} - while a product is being sent: its details (price, sizes, colours, quantity, brand, condition, SKU, "use as note"), or that its photos are done.',
    '{"type":"category_info","product":"<the kind of product>"} - which category, or what Jumia needs, for a kind of product.',
  ],
  drafts: [
    '{"type":"edit","edits":[{"products":[<draft numbers>],"said":"<their words for which draft, or null>","changes":{...},"ask":false}]} - change drafts. "changes" holds ONLY what they asked to change:',
    '  "price" (number), "quantity" (whole number), "variations" (the full list the draft should have; where its category lists options, each as',
    '  {"said":"<their words>","option":"<the ONE option they mean>"}: "Large" is L), "title", "brand", "color" (copied from the message),',
    '  "sale": true, "other": "<a field name>". Every number and word from the message. "ask": true when their words fit more than one draft.',
    '{"type":"submit","products":"all" or [<numbers>]} - send drafts to Jumia.',
    '{"type":"polish","product":<draft number or null>} - make polished photos for a draft.',
    '{"type":"review"} - open their drafts.',
    '{"type":"restart"} - start a new batch, or stop this one.',
  ],
  live_products: [
    '{"type":"live_change","product":"<their words for the product>","stock":<number>} - change one product already on Jumia. Instead of "stock",',
    '  exactly one of: "price":<number>, "sale_price":<number> (dates are read from the message), "sale":"end", "active":true or false.',
    '  Several products, the same change: "products":["<words>","<words>"]. Values from the message.',
    '{"type":"bulk","scope":"all" or "out_of_stock" or "low_stock" or "inactive" or "active" or "matching" or "listed","words":"<their words, for matching>" or null,',
    '  plus one of "price_pct", "sale_pct", "stock", "price", "sale_price", "sale":"end", "active"} - one change to many products by a rule;',
    '  "listed" is the products you last listed for them ("those", "the last 10", "all" right after your list).',
    '{"type":"content_change","product":"<the product>","name":"<copied>" or null,"description":"<copied>" or null,"highlights":null,"brand":null,"rewrite":["name","description","highlights"] or []} - a live product\'s',
    '  name, description or highlights: their own text copied whole, or "rewrite" for what they ask YOU to write (PandaWorld writes it with AI and shows it before one tap).',
    '{"type":"product_info","product":"<their words>"} - when it is really a question about a product (is it on, approved, in stock).',
    '{"type":"warehouse_order","items":[{"product":"<their words>","quantity":<number>}]} - send stock to Jumia\'s warehouse.',
    '{"type":"warehouse_shipped","po":"<from the message>","tracking":"<from the message>","carrier":null} - a warehouse delivery has shipped.',
  ],
  shop_info: [
    '{"type":"product_info","product":"<their words for the product>"} - where one product is: on or off, quality check, price, sale, stock.',
    '{"type":"stock","product":"<their words>" or null,"filter":"out" or "low" or null} - how many are left of a product, or what is out of stock or low.',
    '{"type":"shop","filter":"all" or "inactive" or "rejected"} - an overview with counts, or the products turned off, or rejected by quality check.',
    '{"type":"research","needs":[<up to 4 reads>]} - read their shop and answer with what it shows, organised as asked: their newest or oldest',
    '  products, products sorted or filtered, orders with their items, sales by product, or several at once. Reads:',
    '  {"source":"products","sort":"newest" or "oldest" or "price_high" or "price_low" or "stock_low" or "stock_high" or "name","filter":"all" or',
    '  "active" or "inactive" or "rejected" or "pending" or "out_of_stock" or "low_stock" or "on_sale","words":"<their words>" or null,',
    '  "limit":<up to 30; 10 if not said>,"since":null or a period}; {"source":"orders","period":<period>,"status":null,"limit":<up to 30>};',
    '  {"source":"product_sales","period":<period>}; {"source":"sales_summary","period":<period>}; {"source":"payouts"};',
    '  {"source":"pandaworld_listings","period":<period>}. A period is "today", "yesterday", "week", "month" or "quarter".',
    '{"type":"report","kind":"best_sellers" or "slow_movers" or "restock" or "returns","period":"week" or "month" or "quarter"} - one report.',
    '{"type":"health_report"} - a full health check of their shop ("write a report on my shop", "how is my shop doing").',
    '{"type":"listings","period":"today" or "yesterday" or "week" or "month" or "quarter"} - how many they listed with PandaWorld.',
    '{"type":"brand_check","brand":"<from the message>","product":null} / {"type":"category_info","product":"<kind of product>"}.',
    '{"type":"shops"} - the shops under their Jumia account. {"type":"warehouse_stock","product":"<their words>"} - what Jumia\'s warehouse holds.',
  ],
  orders: [
    '{"type":"orders"} - orders waiting to be packed.',
    '{"type":"order_status","number":"<the order number from the message or the conversation>"} - one order.',
    '{"type":"sales","period":"today" or "yesterday" or "week" or "month" or "quarter","status":null or one or a list of "cancelled",',
    '  "delivered","returned","failed","pending","ready_to_ship","shipped"} - their orders and sales in a period; "quarter" is 90 days, also "ever".',
  ],
  money: [
    '{"type":"credits"} - their credit balance.',
    '{"type":"payouts"} - the last Jumia payout and what is not paid yet.',
    '{"type":"payout_detail","mode":"history" or "breakdown","statement":"<a statement number from the message>" or null} - every statement, or one in detail.',
    '{"type":"fees","product":"<their words>","price":<a number from the message> or null} - what Jumia takes and what they receive when it sells.',
  ],
  account_help: [
    '{"type":"help"} - what PandaWorld can do, when they ask in general.',
    '{"type":"credits"} - their credit balance.',
  ],
  chat: [
    '{"type":"help"} - what PandaWorld can do, when they ask in general.',
  ],
};

/**
 * Worked examples, each in the one area it belongs to: the chat's own
 * examples (lib/whatsapp/assistant.ts buildPrompt), so the two are compared
 * on how they're built, not on what they were shown.
 */
const EXAMPLES: Record<Area, string[]> = {
  listing: [
    '"I have 3 bags to list" → {"type":"list","count":3}',
    '(the bot just said the most is 20 at a time) "let\'s do five then" → {"type":"list","count":5}',
    '(a product is being sent) "size 42, 200 cedis" → {"type":"step"}',
  ],
  drafts: [
    '(draft 2 is a wig) "make the wig 120" → {"type":"edit","edits":[{"products":[2],"said":"wig","changes":{"price":120},"ask":false}]}',
    '(one draft; the bot asked for its sizes) "Price: 130gh Sizes: Large, Medium, Small. Colors: cream, black and brown" → {"type":"edit","edits":[{"products":[1],"said":null,"changes":{"price":130,"variations":[{"said":"Large","option":"L"},{"said":"Medium","option":"M"},{"said":"Small","option":"S"}],"color":"cream, black and brown"},"ask":false}]}',
    '"don\'t list this one again" → {"type":"restart"}',
  ],
  live_products: [
    '"set the stock of the freezer, the blender and the chainsaw to 10" → {"type":"live_change","products":["freezer","blender","chainsaw"],"stock":10}',
    '"also tun on the drone" → {"type":"live_change","product":"drone","active":true}',
    '"restock the foldable drone to 10" → {"type":"live_change","product":"foldable drone","stock":10}',
    '"put the boots on sale at 100 from 10 Oct to 20 Oct" → {"type":"live_change","product":"boots","sale_price":100}',
    '"raise all my prices by 5%" → {"type":"bulk","scope":"all","words":null,"price_pct":5}',
    '"10% off all perfumes this weekend" → {"type":"bulk","scope":"matching","words":"perfumes","sale_pct":10}',
    '"turn off everything that\'s out of stock" → {"type":"bulk","scope":"out_of_stock","words":null,"active":false}',
    '(after you listed their newest products) "change the stock of the last 10 to 20" → {"type":"bulk","scope":"listed","words":null,"stock":20}',
    '"rewrite the description of the wellington boot" → {"type":"content_change","product":"wellington boot","name":null,"description":null,"highlights":null,"brand":null,"rewrite":["description"]}',
    '(the bot asked for the new description of the kettle) "<their text>" → {"type":"content_change","product":"kettle","name":null,"description":"<their text, copied whole>","highlights":null,"brand":null,"rewrite":[]}',
    '"switch on everything that is off" → {"type":"bulk","scope":"inactive","words":null,"active":true}',
  ],
  shop_info: [
    '"is the dron active" → {"type":"product_info","product":"drone"}',
    '"check if I have stock for creatine" → {"type":"stock","product":"creatine","filter":null}',
    '"what is out of stock" → {"type":"stock","product":null,"filter":"out"}',
    '"how many of my products are on and off" → {"type":"shop","filter":"all"}',
    '"what are my best sellers this month" → {"type":"report","kind":"best_sellers","period":"month"}',
    '"the full list of the last 10 products uploaded on my shop" → {"type":"research","needs":[{"source":"products","sort":"newest","filter":"all","words":null,"limit":10,"since":null}]}',
    '"which of my products added this month have sold?" → {"type":"research","needs":[{"source":"products","sort":"newest","filter":"all","words":null,"limit":30,"since":"month"},{"source":"product_sales","period":"month"}]}',
    '"how many listings have I done today?" → {"type":"listings","period":"today"}',
  ],
  orders: [
    '"check for ready to ship and cancelled orders yesterday" → {"type":"sales","period":"yesterday","status":["ready_to_ship","cancelled"]}',
    '"how much has my shop made in 90 days" → {"type":"sales","period":"quarter","status":null}',
    '"returns" → {"type":"sales","period":"month","status":"returned"}',
    '"ordrs" → {"type":"orders"}',
  ],
  money: [
    '"has jumia paid me?" → {"type":"payouts"}',
    '"show my payout history" → {"type":"payout_detail","mode":"history","statement":null}',
    '"what does jumia charge if I sell the boot at 120" → {"type":"fees","product":"boot","price":120}',
  ],
  account_help: [
    '"what\'s my shop name?" → {"type":"reply","text":"Your Jumia shop is <the name in About this seller>.","link":null}',
    '"how do I regenerate my key?" → {"type":"reply","text":"1. Open your Extension Dashboard.\\n2. On the API key card, tap *Regenerate key* and confirm.\\n3. Copy the new key and paste it into the extension again.","link":"dashboard"}',
  ],
  chat: [
    '"thanks" → {"type":"reply","text":"You\'re welcome! 🙌","link":null}',
    '"hi there" → {"type":"reply","text":"Hi! 👋 Here\'s what I can do for your shop:\\n• …\\nWhat would you like to do today?","link":null}',
  ],
};

function readerPrompt(area: Area, input: FrontDoorInput): string {
  const replyArea = area === "account_help" || area === "chat";
  return [
    input.web
      ? "You are PandaWorld's Jumia Listing Assistant, a chat on the PandaWorld website. PandaWorld lists sellers' products on Jumia and helps them run their Jumia shop."
      : "You are PandaWorld's assistant on WhatsApp. PandaWorld lists sellers' products on Jumia and helps them run their Jumia shop.",
    `This message is about: ${area.replace(/_/g, " ")}. Choose ONE action as JSON; PandaWorld's code checks it and carries it out.`,
    "",
    contextText(input),
    // In every area: a reply about what PandaWorld does comes from this, never
    // from a guess ("our team will fix your rejected products", "I can't
    // write descriptions": owner's web chat, 2026-10-08).
    "", "About this seller:", ...input.seller,
    ...(input.memory ? ["", "What you remember about them from earlier (to understand them; never quote it):", input.memory] : []),
    "", "What PandaWorld can do (all true; nothing else is: there is no team doing things by hand):", capabilities(input.listingCost ?? 2),
    ...(replyArea ? [
      "", siteGuide(),
      "", "Links you can send (put the key in \"link\"):", ...Object.entries(input.links).map(([k, l]) => `- ${k}: ${l.what}`),
    ] : []),
    "",
    "Actions:",
    ...ACTIONS[area],
    REPLY,
    CLARIFY,
    "",
    "Examples (message → JSON):",
    ...EXAMPLES[area],
    "",
    "Rules:",
    "- Every number and word you put in an action must be in their message (or, for which product, the recent conversation). Never guess or invent a value.",
    "- Name products as their shop calls them when you can tell which: from the products you last listed (\"the approved ones\" are those whose quality check passed, on or off; \"my latest uploaded product\" is the first of a list of their newest) or the products the message names.",
    "- A question about what you can do (\"can you…?\"): answer from What PandaWorld can do, and if it can, offer to do it. Never say a team or a person will do something.",
    "- Ask (clarify) only when you can't tell which action or which product, or a change has no value to set. Never ask for a detail that has a default: a period (use the action's usual one), a report's kind, the price for fees (null), how many to list (10). Use the default and answer.",
    ...(replyArea ? [
      "- A hello or \"what can you do\": a short list (\"• \" lines, never numbered) of what you can do for them, with the words that do it, then ask what they'd like.",
      "- About themselves (pack, credits, shop, connections): only from About this seller. Outside Jumia and PandaWorld: say you can't help with that and suggest something you can do.",
      "- Write for WhatsApp: short and warm, *bold* with single asterisks, in the language they wrote in. Never write a web address; use \"link\".",
    ] : []),
    "",
    "Reply with ONLY one JSON object.",
  ].join("\n");
}

// ─── The whole read ──────────────────────────────────────────────────────────

const json = (text: string): Record<string, unknown> | null => {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]) as Record<string, unknown>; } catch { return null; }
};

/** Whose AI use it is: the chat's ("assistant", for the seller) or the test set's. */
export interface FrontDoorUsage { feature: "assistant" | "assistant_eval"; userId?: string }

/**
 * How long each call may take. A message the website's route (60 s) cut off
 * got no reply at all (owner's web chat, 2026-10-08 17:49, Gemini slow):
 * sorting 10 s, reading 25 s, then Flash-Lite reads it in 12 s, all well
 * inside the 60 s.
 */
export const FRONT_DOOR_LIMITS = { routerMs: 10_000, readerMs: 25_000, fallbackMs: 12_000 };

async function ask(model: string, prompt: string, usage: FrontDoorUsage, limitMs?: number): Promise<string> {
  const call = withAiUsageContext(usage, () =>
    callGeminiBackend(model, [{ text: prompt }], { json: true, ...(model.startsWith("gemini-3") ? { preferBackend: "ai-studio" as const } : {}) }));
  if (!limitMs) return (await call).text;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${model} took over ${limitMs / 1000} s`)), limitMs); });
  try {
    return (await Promise.race([call, late])).text;
  } finally {
    clearTimeout(timer);
  }
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** What the front door makes of a message: the area, the action (or a question back), and the AI's raw replies. */
export async function frontDoor(
  input: FrontDoorInput, models: FrontDoorModels, usage: FrontDoorUsage = { feature: "assistant_eval" },
  limits: Partial<typeof FRONT_DOOR_LIMITS> = {},
): Promise<{ area: Area; action: FrontDoorAction; raw: string }> {
  const t0 = Date.now();
  const routed = await ask(models.router, routerPrompt(input), usage, limits.routerMs);
  const t1 = Date.now();
  const picked = json(routed)?.area;
  const area: Area = AREAS.has(picked as Area) ? (picked as Area) : "chat";
  // Drafts only exist in a batch: without any, a change goes to the live products.
  const reading: Area = area === "drafts" && input.drafts.length === 0 ? "live_products" : area;
  const prompt = readerPrompt(reading, input);
  let text: string;
  let note = "";
  try {
    text = await ask(models.reader, prompt, usage, limits.readerMs);
  } catch (e) {
    // Slow or down: the quick model reads it instead of leaving them waiting.
    if (!limits.readerMs || models.reader === FRONT_DOOR_ROUTER) throw e;
    text = await ask(FRONT_DOOR_ROUTER, prompt, usage, limits.fallbackMs);
    note = ` (read by ${FRONT_DOOR_ROUTER}: ${(e as Error).message})`;
  }
  const raw = `${secs(t1 - t0)}+${secs(Date.now() - t1)}${note} ${routed.trim()} → ${text.trim()}`;
  const parsed = json(text);
  if (parsed?.type === "clarify") {
    const options = (Array.isArray(parsed.options) ? parsed.options : []).filter((o): o is string => typeof o === "string").map((o) => o.slice(0, 40)).slice(0, 3);
    const question = typeof parsed.question === "string" ? parsed.question.slice(0, 300) : "";
    return { area: reading, action: { type: "clarify", question, options }, raw };
  }
  // The products just listed count as named in the conversation: it keeps
  // only 300 characters of each message, so a long list's later names were
  // missing from it.
  const context = [...input.conversation, ...(input.listed?.items ?? []).map((l) => `Bot: ${l}`)].join("\n");
  const action = parseActionUnguarded(text, input.message, input.drafts, input.links, input.currency, {
    context, stage: input.stage, listed: !!input.listed,
  });
  return { area: reading, action, raw };
}
