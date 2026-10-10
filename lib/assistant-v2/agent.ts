/**
 * Agent mode: the assistant reads a message with Gemini's function calling
 * (owner, 2026-10-10: "let's build the agent mode pilot with function
 * calling"), beside the front door (lib/assistant-v2/front-door.ts), for the
 * accounts app_settings `assistant_agent` names.
 *
 * What changes from the front door:
 *   - One call, with every action as a tool, instead of sorting into an
 *     area first and reading within it.
 *   - It may look their products up before deciding (find_products: the
 *     shop's products matching some words, with where each is). At most two
 *     lookup rounds; the last call can only act. Counts and lists come from
 *     the actions that read them, never from a lookup.
 *   - It may do up to three things a message asks for ("restock the kettle
 *     to 10 and show me today's orders"), carried out in order.
 *
 * What doesn't: every action goes through the chat's own safety checks
 * (parseActionUnguarded: each value in the message, products named, nothing
 * widened), anything that changes Jumia is still offered for a confirm tap,
 * and what isn't possible is answered by the capability list's fixed text
 * (cannot). It never acts on a lookup alone.
 */

import { callGeminiWithTools, type GeminiTool, type GeminiTurn } from "@/lib/ai/gemini-client";
import { withAiUsageContext } from "@/lib/ai/usage";
import { siteGuide } from "@/lib/whatsapp/site-guide";
import { cannotList } from "@/lib/jumia/capabilities";
import { capabilities, parseActionUnguarded, type AssistantAction } from "@/lib/whatsapp/assistant";
import { findProducts, type ShopProduct } from "@/lib/jumia/shop";
import { EXAMPLES, contextText, type Clarify, type FrontDoorInput, type FrontDoorUsage } from "@/lib/assistant-v2/front-door";

// ─── Tools ───────────────────────────────────────────────────────────────────

type Schema = Record<string, unknown>;
const str = (description: string, values?: string[]): Schema => ({ type: "string", description, ...(values ? { enum: values } : {}) });
const num = (description: string): Schema => ({ type: "number", description });
const int = (description: string): Schema => ({ type: "integer", description });
const bool = (description: string): Schema => ({ type: "boolean", description });
const arr = (items: Schema, description: string): Schema => ({ type: "array", items, description });
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: "object", properties, ...(required.length ? { required } : {}) });
const tool = (name: string, description: string, properties: Record<string, Schema> = {}, required: string[] = []): GeminiTool =>
  ({ name, description, parameters: obj(properties, required) });

const PERIOD = ["today", "yesterday", "week", "month", "quarter"];
const PRODUCT = str("The product in their words, or as their shop names it.");
const STATUS = ["cancelled", "delivered", "returned", "failed", "pending", "ready_to_ship", "shipped"];

/**
 * Look-ups: answered back to the model, which then decides. Only which
 * product they mean: counts and lists are the actions' to read (an agent
 * told "0 products" by a stale copy answered "You have 0 products": the
 * first test run, 10 Oct).
 */
export const LOOKUP_TOOLS: GeminiTool[] = [
  tool("find_products", "Look up which of their Jumia products match some words: each one's full name, ON or OFF, quality check, stock and price, from PandaWorld's saved copy of their shop. Only to tell which product they mean when it isn't clear; never to answer them (the actions read Jumia). Never shown to the seller.",
    { words: str("Words from their message naming the product(s).") }, ["words"]),
];

/** Actions: each is one of the chat's own actions, checked and carried out by the chat. */
export const ACTION_TOOLS: GeminiTool[] = [
  // Listing new products
  tool("list", "They want to list new products now and say how many (\"2 shirts and a fridge\" is 3). Not while a batch is being sent: its products' details are step.", { count: int("How many products.") }, ["count"]),
  tool("restart", "They want to list but give no number (never ask how many: this asks), start a new listing or batch, put this one on hold to list another, or stop or start over the batch they are sending."),
  tool("step", "While a batch's products are being sent: a product's details (price, sizes, colours, pieces, quantity, brand, condition, SKU, notes, \"use as note\"), that its photos are done, or anything about the product being sent."),
  tool("category_info", "Which category, or what Jumia needs, for a kind of product.", { product: str("The kind of product.") }, ["product"]),
  // Drafts
  tool("edit", "Change drafts in their batch (only the drafts listed in the context). Only what they asked to change, every value from the message.", {
    edits: arr(obj({
      products: arr(int("A draft number."), "The drafts it applies to."),
      said: str("Their words for which draft, or empty."),
      changes: obj({
        price: num("New price."), quantity: int("New quantity."),
        variations: arr(obj({ said: str("Their words."), option: str("The one category option they mean, e.g. \"Large\" is L.") }), "The full list of variations the draft should have."),
        title: str("New name, copied."), brand: str("New brand, copied."), color: str("Colour, copied."),
        sale: bool("A sale price with dates (read from the message)."), other: str("Another field they want changed."),
      }),
      ask: bool("True when their words fit more than one draft and they didn't say all."),
    }), "One entry per change."),
  }, ["edits"]),
  tool("submit", "Send drafts to Jumia.", { all: bool("All the drafts."), products: arr(int("A draft number."), "The drafts to send, when not all.") }),
  tool("polish", "Make polished photos for a draft.", { product: int("The draft number, if they named one.") }),
  tool("review", "Open their drafts or listings page."),
  // Live products
  tool("live_change", "Change one or several products already on Jumia: exactly one of stock, price, sale_price, end_sale or active. Offered for a confirm tap.", {
    product: PRODUCT, products: arr(str("A product."), "Several products, the same change."),
    stock: int("New stock."), price: num("New price (\"sell it at 120\", \"make it 120\")."),
    sale_price: num("A sale price, only when they say sale, discount, promo or off (dates are read from the message)."),
    end_sale: bool("End its sale."), active: bool("true to turn it ON, false to turn it OFF."), all: bool("Every product their words fit (\"all the hard hats\")."),
  }),
  tool("bulk", "One change to many products by a rule, shown before one tap: prices or a sale by a percentage, a stock, a price, ending sales, ON or OFF.", {
    scope: str("Which products. \"listed\": the products you last listed for them (\"those\", \"them\", \"the last 10\", and \"all\" right after your list). \"matching\": the products their words name.", ["all", "out_of_stock", "low_stock", "inactive", "active", "matching", "listed"]),
    words: str("Their words for the products, for matching."),
    price_pct: num("Prices up (+) or down (-) by this %."), sale_pct: num("A sale this % off."),
    stock: int("Stock to set."), price: num("Price to set."), sale_price: num("Sale price to set."),
    end_sale: bool("End sales."), active: bool("true ON, false OFF."),
  }, ["scope"]),
  tool("content_change", "A live product's name, description, highlights, brand, other details, barcode or a size's name. Their own text copied, or rewrite for what they ask you to write.", {
    product: PRODUCT, name: str("New name, copied."), description: str("New description, copied whole."), highlights: str("New highlights, copied."),
    brand: str("New brand, copied."), rewrite: arr(str("A field.", ["name", "description", "highlights"]), "Fields they ask you to write or improve."),
    details: arr(obj({ detail: str("The detail in their words: colour, material, weight, model…"), value: str("The value, copied.") }), "Other details."),
    barcode: str("Barcode digits, copied."), size: obj({ from: str("The size now."), to: str("The new size name.") }),
  }, ["product"]),
  tool("add_size", "A new size or colour for a product already on Jumia, with its stock and price from the message.", {
    product: PRODUCT, size: str("The new size or colour, copied."), stock: int("Stock, from the message."), price: num("Price, from the message."),
  }, ["product", "size"]),
  tool("add_photos", "More photos for a product already on Jumia (they send them next).", { product: PRODUCT }, ["product"]),
  tool("fix_rejected", "Fix products Jumia's quality check rejected. Leave product out when they mean all of them or none in particular (they see the list and pick one).", { product: str("One rejected product in their words; never \"rejected\" or \"all\"."), reason: str("Jumia's reason as they pasted it.") }),
  tool("warehouse_order", "Send stock to Jumia's warehouse.", { items: arr(obj({ product: PRODUCT, quantity: int("How many.") }), "Products and quantities.") }, ["items"]),
  tool("warehouse_shipped", "A delivery to Jumia's warehouse has shipped.", { po: str("Purchase order number."), tracking: str("Tracking number."), carrier: str("Carrier.") }, ["po", "tracking"]),
  // Their shop
  tool("product_info", "Where one product is: ON or OFF, quality check, price, sale, stock.", { product: PRODUCT }, ["product"]),
  tool("product_text", "A product's name, description and highlights as Jumia has them, to read or edit.", { product: PRODUCT }, ["product"]),
  tool("stock", "How many are left of a product, or what is out of stock or low.", { product: PRODUCT, filter: str("Which.", ["out", "low"]) }),
  tool("shop", "An overview with counts, or the products turned OFF, or rejected by quality check.", { filter: str("Which.", ["all", "inactive", "rejected"]) }),
  tool("research", "Read their shop and answer as asked: products sorted or filtered, orders with items, sales by product, payouts, what PandaWorld listed; up to 4 reads.", {
    needs: arr(obj({
      source: str("What to read.", ["products", "orders", "product_sales", "sales_summary", "payouts", "pandaworld_listings"]),
      sort: str("Products: order.", ["newest", "oldest", "price_high", "price_low", "stock_low", "stock_high", "name"]),
      filter: str("Products: which.", ["all", "active", "inactive", "rejected", "pending", "out_of_stock", "low_stock", "on_sale"]),
      words: str("Products: their words to match."),
      limit: int("How many (up to 30; 10 if not said)."),
      since: str("Products: added in this period.", PERIOD),
      period: str("Orders and sales: the period.", PERIOD),
      status: str("Orders: one status.", STATUS),
    }, ["source"]), "The reads."),
  }, ["needs"]),
  tool("report", "One report on what sells: best sellers, slow movers, restock, returns (\"reports\" on its own: best_sellers). How the shop is doing overall is health_report.", { kind: str("Which.", ["best_sellers", "slow_movers", "restock", "returns"]), period: str("Period.", ["week", "month", "quarter"]) }, ["kind"]),
  tool("health_report", "A full health check of their shop: \"how is my shop doing\", \"insight into my shop's performance\", \"write a report on my shop\"."),
  tool("listings", "How many products they listed with PandaWorld in a period.", { period: str("Period.", PERIOD) }),
  tool("brand_check", "Whether a brand is on Jumia and allowed.", { brand: str("The brand, copied."), product: str("The kind of product.") }, ["brand"]),
  tool("shops", "The shops under their Jumia account."),
  tool("warehouse_stock", "What Jumia's warehouse holds of a product.", { product: PRODUCT }, ["product"]),
  // Orders
  tool("orders", "Orders waiting to be packed."),
  tool("order_status", "One order, by its number (\"#394666919\", \"tell me about this one #394666919 · GHS 94\").", { number: str("The order number from the message or the conversation, digits only.") }, ["number"]),
  tool("sales", "Their orders and sales in a period, optionally with statuses.", { period: str("Period.", PERIOD), status: arr(str("A status.", STATUS), "Statuses.") }),
  // Money and account
  tool("credits", "Their credit balance, with a button to buy more: always this for \"my credits\", \"how many credits\", even when About this seller shows a number."),
  tool("payouts", "The last Jumia payout and what isn't paid yet."),
  tool("payout_detail", "Every statement (history), or one statement's fees and refunds (breakdown).", { mode: str("Which.", ["history", "breakdown"]), statement: str("A statement number from the message.") }, ["mode"]),
  tool("fees", "What Jumia takes and what they receive when a product sells (\"how much will I receive if it sells\").", { product: PRODUCT, price: num("A price from the message.") }, ["product"]),
  tool("help", "What PandaWorld can do, when they ask in general."),
  // Saying, not doing
  tool("cannot", "They ask for something on the Not possible list: PandaWorld gives the true answer.", { what: str("A key from Not possible from here.") }, ["what"]),
  tool("reply", "A short answer in your words: a hello, thanks, a question about PandaWorld or their account, anything the other tools don't cover. Never says you did, paused, stopped, changed or will change anything, never gives a number about their shop or credits (tools read them), and never says PandaWorld can't do something or sends them to Vendor Center for it (what isn't possible is cannot; the rest has a tool).", {
    text: str("Your message."), link: str("A link key, if one fits."),
  }, ["text"]),
  tool("clarify", "Only when you can't tell which action or which product, or a change has no value: one short question with 2 or 3 answers to tap.", {
    question: str("The question, ending with ?"), options: arr(str("An answer they can tap, up to 20 characters, clear on its own."), "2 or 3 answers."),
  }, ["question", "options"]),
];

const LOOKUPS = new Set(LOOKUP_TOOLS.map((t) => t.name));
/** A lookup that finds nothing: the saved copy can be behind, so it still acts on their words. */
export const NO_MATCH = "None of the products in PandaWorld's saved copy of their shop match these words. The copy can be out of date: act with their own words for the product (the action looks it up on Jumia). Never tell them it isn't in their shop.";
/** Every tool, declared on every call (earlier turns call the lookups). */
export const AGENT_TOOLS: GeminiTool[] = [...LOOKUP_TOOLS, ...ACTION_TOOLS];
const ACTION_NAMES = ACTION_TOOLS.map((t) => t.name);

/**
 * A tool call as the chat's own action JSON (what parseAction reads): the
 * few arguments shaped for function calling are put back. Pure.
 */
export function actionJson(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { type: name, ...args };
  if ((name === "live_change" || name === "bulk") && args.end_sale === true) out.sale = "end";
  delete out.end_sale;
  if (name === "submit") {
    out.products = args.all === true || !Array.isArray(args.products) || args.products.length === 0 ? "all" : args.products;
    delete out.all;
  }
  if (name === "content_change") {
    const details = Array.isArray(args.details) ? args.details as { detail?: unknown; value?: unknown }[] : [];
    out.details = details.length
      ? Object.fromEntries(details.filter((d) => typeof d.detail === "string" && typeof d.value === "string").map((d) => [d.detail as string, d.value as string]))
      : undefined;
    if (!Array.isArray(args.rewrite)) out.rewrite = [];
  }
  if (name === "sales" && Array.isArray(args.status)) out.status = args.status.length === 0 ? null : args.status.length === 1 ? args.status[0] : args.status;
  if (name === "polish" && args.product == null) out.product = null;
  return out;
}

// ─── The prompt ──────────────────────────────────────────────────────────────

/**
 * What doesn't change from one seller or message to the next: the system
 * instruction, the same for everyone (with the tools, about 10k tokens), so
 * Gemini serves it from its cache instead of reading it each time. Pure.
 */
export function agentSystem(listingCost = 2): string {
  return [
    "You are PandaWorld's assistant for Jumia sellers, on WhatsApp or in the Jumia Listing Assistant chat on the PandaWorld website. PandaWorld lists sellers' products on Jumia and helps them run their Jumia shop.",
    "You act by calling tools. PandaWorld's code checks every call and carries it out; anything that changes their Jumia shop is shown to them first for a confirm tap.",
    "The first message tells you where the seller is, what they've been shown, who they are, and their new message.",
    "", "What PandaWorld can do (all true; nothing else is: there is no team doing things by hand):", capabilities(listingCost),
    "", "Not possible from here (answer these with cannot):", cannotList(),
    "", siteGuide(),
    "",
    "Examples (message → the tool and its arguments, as JSON):",
    ...Object.values(EXAMPLES).flat(),
    "",
    "Rules:",
    "- Call the tool that does what they ask. When they ask for two or three different things, call a tool for each (at most 3), in the order they asked. One request is one tool.",
    "- Read the message for what they want now. The open question is context: a message that answers it belongs with what the question was about (a description the bot asked for a live product is content_change); anything else is a new request.",
    "- Which product: from the products you last listed (\"the approved ones\" are those whose quality check passed, ON or OFF; \"my latest uploaded product\" is the first of a list of their newest), the products the message names, or the conversation (\"those products\" after an order: that order's products). Put their names in the tool. Only when you still can't tell, look it up (find_products), at most twice; then call the tool for what they asked.",
    "- A lookup is never an answer: stock, prices, counts and lists come from the tools that read them (product_info, stock, shop, research). Never tell them a product isn't in their shop.",
    "- Every number and word you put in a tool's arguments must be in their message (or, for which product, the recent conversation). Never guess or invent a value.",
    "- You don't have their products' descriptions, highlights, prices, stock or sales: never write them yourself; use the tool that reads them.",
    "- Drafts are only the ones listed under \"Drafts in their batch\". A product already in their shop is changed with live_change, bulk or content_change, even while drafts wait.",
    "- A change to a product (\"change the drone to 10\", \"restock the kettle\", \"set X to 50 pcs\") is a change, never listing new products. Changing a name, description or highlights with no new text means writing it (content_change with rewrite).",
    "- While a batch's products are being sent, their details (sizes, pieces, prices, SKUs, \"those are 3 different products\") are step: no lookup.",
    "- A product's name on its own after you listed products: product_info. An order number: order_status. How much they made or sold: sales. What PandaWorld listed for them (\"from this chat\"): research with pandaworld_listings.",
    "- Fixing rejected products: fix_rejected (no product to see them and pick one). Which ones are rejected: shop with rejected.",
    "- A question about what you can do (\"can you…?\"): answer from What PandaWorld can do, and if it can, do it or offer to. Never say you can't do something unless it is on the Not possible list (then use cannot), and never send them to Vendor Center for something a tool does (a live product's name, description, highlights, details, stock, price, sale, ON/OFF, sizes, photos). Never say a team or a person will do something.",
    "- Ask (clarify) only when you can't tell which action or which product, or a change has no value to set. Never ask for a detail that has a default: a period (the tool's usual one), a report's kind (best_sellers), the price for fees, how many to list (restart asks).",
    "- A reply never says you did, paused, stopped, changed or will change anything (\"I've paused the current draft\" did nothing). Only a tool does things: use it, or ask.",
    "- About themselves (pack, credits, shop, connections, extension use): only from About this seller. Outside Jumia and PandaWorld: say you can't help with that and suggest something you can do.",
    "- Replies: short and warm, *bold* with single asterisks, in the language they wrote in, never a web address (use link). A hello or \"what can you do\": a short list (\"• \" lines) of what you can do, then ask what they'd like. A product's status is ON or OFF, in capitals.",
  ].join("\n");
}

/** What changes with each message: the first user turn. Pure. */
export function agentContext(input: FrontDoorInput): string {
  return [
    input.web ? "Channel: the Jumia Listing Assistant chat on the PandaWorld website." : "Channel: WhatsApp.",
    "",
    contextText(input),
    // The record keeps 600 characters of it: a pasted description is copied whole.
    ...(input.message.length > 600 ? ["", "Their whole message:", input.message.slice(0, 5000)] : []),
    "", "About this seller:", ...input.seller,
    ...(input.memory ? ["", "What you remember about them from earlier (to understand them; never quote it):", input.memory] : []),
    "", "Links you can send with reply (the key in \"link\"):", ...Object.entries(input.links).map(([k, l]) => `- ${k}: ${l.what}`),
  ].join("\n");
}

/** The whole of what the agent reads, for logs and tests. Pure. */
export function agentPrompt(input: FrontDoorInput): string {
  return `${agentSystem(input.listingCost ?? 2)}\n\n${agentContext(input)}`;
}

// ─── The read ────────────────────────────────────────────────────────────────

/** What the agent can look up while deciding. */
export interface AgentLookups {
  findProducts: (words: string) => Promise<string[]>;
}

const QC: Record<string, string> = { APPROVED: "approved", PENDING: "waiting for quality check", NOT_READY_TO_QC: "waiting for quality check", REJECTED: "rejected by quality check" };

/** One product as a lookup answers it: only what the shop's copy knows. Pure. */
export function lookupLine(p: ShopProduct): string {
  const variation = p.variation && p.variation !== "..." ? ` (${p.variation})` : "";
  return [
    `"${p.name}${variation}"`,
    p.status === "ACTIVE" ? "ON" : p.status === "INACTIVE" ? "OFF" : null,
    p.qcStatus ? QC[p.qcStatus] ?? p.qcStatus.toLowerCase() : null,
    p.stock != null ? `stock ${p.stock}` : null,
    p.price != null ? `price ${p.currency ? `${p.currency} ` : ""}${p.price}` : null,
    p.salePrice != null && (!p.saleEnd || new Date(p.saleEnd).getTime() > Date.now()) ? `on sale at ${p.salePrice}` : null,
  ].filter(Boolean).join(" · ");
}

/** Lookups over their shop's local copy (jumia_products), as the chat's own product search finds them. */
export function catalogLookups(products: ShopProduct[]): AgentLookups {
  return {
    findProducts: async (words) => findProducts(products, words, 12).map(lookupLine),
  };
}

export interface AgentResult {
  /** What to carry out, in order (one or more), or a question back. */
  actions: AssistantAction[];
  clarify: Clarify | null;
  raw:     string;
  /** Model calls made. */
  calls:   number;
}

/**
 * The longest one call may take, and a message in all: inside the 60 s a
 * request has, with time left to carry the actions out. Failing within
 * 15 s, the front door reads it instead (runAssistant).
 */
export const AGENT_LIMITS = { callMs: 10_000, totalMs: 25_000 };
const MAX_LOOKUP_ROUNDS = 2;
const MAX_ACTIONS = 3;

async function timed<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s`)), ms); });
  try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
}

type ToolCall = { name: string; args: Record<string, unknown>; id?: string };

/** One model turn (`onlyAct`: the lookups may not be called): injectable for tests. */
export type AgentCall = (turns: GeminiTurn[], onlyAct: boolean) => Promise<{
  calls: ToolCall[]; text: string; turn: GeminiTurn; usage?: { prompt: number; cached: number };
}>;

/** `system` is agentSystem(): the same for every seller, so it's cached. */
export function geminiAgentCall(model: string, system: string, usage: FrontDoorUsage): AgentCall {
  return (turns, onlyAct) => withAiUsageContext(usage, () => callGeminiWithTools(model, turns, {
    system, tools: AGENT_TOOLS, mode: "ANY", ...(onlyAct ? { allowed: ACTION_NAMES } : {}),
    ...(model.startsWith("gemini-3") ? { preferBackend: "ai-studio" as const } : {}),
  }));
}

const brief = (calls: ToolCall[]) => calls.map((c) => `${c.name}(${JSON.stringify(c.args).slice(0, 200)})`).join(" + ");

/**
 * What the agent makes of a message: the actions to carry out (checked by
 * the chat's own rules) or a question back. Throws when the model fails or
 * runs out of time: the caller reads it the front door's way instead.
 */
export async function agentRead(
  input: FrontDoorInput, call: AgentCall, lookups: AgentLookups, limits: Partial<typeof AGENT_LIMITS> = {},
): Promise<AgentResult> {
  const lim = { ...AGENT_LIMITS, ...limits };
  const t0 = Date.now();
  // contextText ends with their new message.
  const turns: GeminiTurn[] = [{ role: "user", parts: [{ text: agentContext(input) }] }];
  const log: string[] = [];
  let finals: ToolCall[] = [];
  let calls = 0;
  const tokens = { prompt: 0, cached: 0 };
  for (let round = 0; ; round++) {
    const last = round >= MAX_LOOKUP_ROUNDS;
    const left = lim.totalMs - (Date.now() - t0);
    if (left <= 1000) throw new Error(`agent ran out of time after ${calls} calls`);
    const r = await timed(call(turns, last), Math.min(lim.callMs, left), "agent call");
    calls++;
    tokens.prompt += r.usage?.prompt ?? 0;
    tokens.cached += r.usage?.cached ?? 0;
    const looked = r.calls.filter((c) => LOOKUPS.has(c.name));
    const acted = r.calls.filter((c) => !LOOKUPS.has(c.name));
    log.push(brief(r.calls) || `text: ${r.text.slice(0, 200)}`);
    // Acted, wrote instead, or looked again when it may only act: done.
    if (acted.length > 0 || looked.length === 0 || last) {
      finals = acted.length > 0 ? acted : r.text.trim() ? [{ name: "reply", args: { text: r.text.trim() } }] : [];
      break;
    }
    // Look it up, answer the model, and let it decide.
    const answers = await Promise.all(looked.map(async (c) => {
      const words = typeof c.args.words === "string" ? c.args.words : "";
      const found = (await lookups.findProducts(words).catch(() => [] as string[])).slice(0, 12);
      return { functionResponse: { ...(c.id ? { id: c.id } : {}), name: c.name, response: { result: found.length > 0 ? found : NO_MATCH } } };
    }));
    log.push(`→ ${JSON.stringify(answers.map((a) => a.functionResponse.response.result)).slice(0, 300)}`);
    turns.push(r.turn, { role: "user", parts: answers });
  }
  const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
  const read = tokens.prompt ? `, ${k(tokens.prompt)} in${tokens.cached ? ` (${k(tokens.cached)} cached)` : ""}` : "";
  const raw = `${((Date.now() - t0) / 1000).toFixed(1)}s, ${calls} call${calls === 1 ? "" : "s"}${read}: ${log.join(" ")}`;

  const asking = finals.find((c) => c.name === "clarify");
  if (asking) {
    const options = (Array.isArray(asking.args.options) ? asking.args.options : []).filter((o): o is string => typeof o === "string").map((o) => o.slice(0, 40)).slice(0, 3);
    return { actions: [], clarify: { type: "clarify", question: String(asking.args.question ?? "").slice(0, 300), options }, raw, calls };
  }

  // The same checks as the front door's reading: values from the message, products named.
  const context = [...input.conversation, ...(input.listed?.items ?? []).map((l) => `Bot: ${l}`)].join("\n");
  const asked = input.answered ? [...input.conversation].reverse().find((l) => l.startsWith("Bot:"))?.slice(4).trim() : undefined;
  const said = asked ? `${asked}\n${input.message}` : input.message;
  const many = finals.length > 1;
  const actions: AssistantAction[] = [];
  const seen = new Set<string>();
  for (const c of finals.slice(0, MAX_ACTIONS)) {
    // Beside actions, its own words and "a detail of the product being sent"
    // add nothing; nor does starting over beside listing (the list starts it).
    if (many && (c.name === "reply" || c.name === "step")) continue;
    if (c.name === "restart" && finals.some((f) => f.name === "list")) continue;
    const action = parseActionUnguarded(JSON.stringify(actionJson(c.name, c.args)), said, input.drafts, input.links, input.currency, {
      context, stage: input.stage, listed: !!input.listed,
    });
    const key = JSON.stringify(action);
    if (action.type === "unclear" || seen.has(key)) continue;
    seen.add(key);
    actions.push(action);
  }
  return { actions: actions.length > 0 ? actions : [{ type: "unclear" }], clarify: null, raw, calls };
}
