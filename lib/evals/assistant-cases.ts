/**
 * The assistant's test set (owner, 2026-10-08: "how do we make sure that the
 * next solution we offer for the problem does not conflict the past
 * solution"). Real messages sellers sent, each with the conversation just
 * before it and the answers that would be right, plus rewordings of the same
 * requests ("variant") to check it understands the request rather than the
 * phrase. Run against the real AI by lib/evals/assistant-eval.ts; see
 * /admin/assistant-tests.
 *
 * Rules for this file:
 *   - A case that went wrong in a real conversation is added here first,
 *     with the right answer, before anything is changed. A change ships
 *     only when every case that passed before still passes.
 *   - `ok` lists every answer that would be fine (any one passes). Keep it
 *     honest: when two readings are both reasonable, list both.
 *   - Shapes compare fields of the parsed action. A string starting with
 *     "~" means "contains, any case"; arrays compare as sets.
 *   - No secrets, phone numbers or codes. Shop and product names are as the
 *     sellers wrote them.
 */

import type { Stage } from "@/lib/whatsapp/assistant";

export type Area = "listing" | "drafts" | "live_changes" | "shop_info" | "orders" | "money" | "account_help" | "chat";

export type Shape = { type: string } & Record<string, unknown>;

export interface DraftFact { title: string; variations?: string[]; options?: string[]; price?: number }

export interface EvalCase {
  id: string;
  /** "log 10-08 09:50" for a real message (its UTC time), "variant" for a rewording. */
  src: string;
  area: Area;
  stage: Stage;
  /** The conversation before it, oldest first: "Seller: …" / "Bot: …". */
  ctx?: string[];
  /** The batch's drafts (review stage): seq is the position + 1. */
  drafts?: DraftFact[];
  /** Products the bot had just listed for them (session.lastListed); `items`, one line each as the front door is told them. */
  listed?: { count: number; what: string; items?: string[] };
  /** Product names in their Jumia shop, when the message is about one. */
  catalog?: string[];
  web?: boolean;
  /** The bot's open question, as intake describes it. */
  waitingFor?: string;
  msg: string;
  ok: Shape[];
  note?: string;
}

// ─── Shared context ───────────────────────────────────────────────────────────

const SIZES = ["XS", "S", "M", "L", "XL", "XXL", "3XL", "One Size"];
const NECK_FAN = "Portable USB Rechargeable Neck Fan – 360° Adjustable Hands-Free Wearable Sports Fan with 3 Speeds";
const BODYSUIT_NAME = "Backless Thong Bodysuit - Adjustable Straps, Thong Design";
const OVERVIEW_278 = "Bot: 🛍️ Your Jumia shop: 297 products / • On: 278 / • Off: 0 / • Out of stock: 0 / • Waiting for Jumia's check: 2 / • Rejected: 11";
const PERFUME: DraftFact = { title: "Vintage Radio Eau de Parfum - 100ml, Natural Spray", variations: ["100ml"], price: 129 };
const BODYSUIT: DraftFact = { title: "Backless Thong Bodysuit - Adjustable Straps, Thong Design", options: SIZES };
const TSHIRT_SET: DraftFact = { title: "Crew Neck T-Shirt & Pocket Shorts Set - Short Sleeve, High Waist", variations: ["S", "M", "L"], options: SIZES, price: 100 };
const WORKOUT: DraftFact = { title: "Workout Set - Short Sleeve Top, Pocket Shorts", options: SIZES };
const EARRINGS: DraftFact = { title: "White Maple Leaf Flower Earrings - Gold Tone" };

const HOW_MANY = "Bot: Let's list! How many products are you listing today?";
const FRESH = "Bot: No problem — let's start fresh. How many products are you listing today?";
const OUT_OF_STOCK_LIST = "Bot: 🚫 Out of stock on Jumia (5) / • Foldable Drone with HD Camera – Professional WiFi FPV Quadc…: out of stock / • SC-8500W Multifunction Blender Robot - 2L Jar…: out of stock / • Portable Cordless Chainsaw…: out of stock / • LGNT Tablet - 4GB RAM, 256GB…: out of stock / • Pedestal Fan - 5-Blade Airflow, Metal Grille (Black): out of stock";
const REJECTED_LIST = "Bot: ❌ Rejected by Jumia's quality check (10) / • Malta Guinness Soft Drink - 330ml Bottles, Pack of 6 (6 Bot… / • Nourishing Cocoa Body Lotion - 5in1 Complete Care… / • Olive & Milk Shower Cream - Nourishes Skin, With Vitamin E / • Galaxy A15 Smartphone - 6GB RAM, 128GB Storage, Black / • Water Wave Lace Front Wig - 13x4, 20 Inch";
const CATALOG = [
  "Foldable Drone with HD Camera – Professional WiFi FPV Quadcopter, One-Key Return (SG109PRO)",
  "Pedestal Fan - 5-Blade Airflow, Metal Grille (Black)",
  "Portable USB Rechargeable Neck Fan – 360° Adjustable Hands-Free Wearable Sports Fan with 3 Speeds",
  "Malta Guinness Soft Drink - 330ml Bottles, Pack of 6 (6 Bottles)",
  "Water Wave Lace Front Wig - 13x4, 20 Inch",
  "Creatine Monohydrate Micronized Powder (300G) - Pure Creatine Monohydrate (Unflavored)",
  "Work Safety Shoes - Anti-Static, Slip Resistant",
  "Gold Medals with Ribbons - Bulk Pack for Sports, School, & Award Ceremonies",
  "Nasco Electric Kettle 1.7L",
];

// The owner's 10 newest products as the bot listed them (web chat, 2026-10-08 17:00).
const NEWEST_10 = [
  '"Crocheted Beanie Hat - Pearl Embellished, Crochet Knit (Summerhat-cream)" · on · approved · stock 1',
  '"Vintage Radio Eau de Parfum - 100ml, Natural Spray (100ml)" · off · rejected by quality check · stock 1',
  '"Ventilated Safety Helmet - Blue, Adjustable Strap" · on · approved · stock 1',
  '"Quilted Car Cover - Waterproof, Dustproof, All-Weather Protection (Default)" · off · approved · stock 1',
  '"Kinky Curly Wig - 24 Inch Length, Full Lace" · on · approved · stock 1',
  '"Asymmetrical Irregular Statement Earrings - Shell Inlay, Gold Tone" · off · approved · stock 1',
  '"Kinky Curly Wig - 24 Inch Length, Full Lace" · off · rejected by quality check · stock 1',
  '"Enhancement Dietary Supplement - Collagen Boosters, Lifts Buttocks" · off · rejected by quality check · stock 0',
  '"20000mAh Power Bank - Dual LED Flashlight, 4 Built-In Cables" · off · rejected by quality check · stock 0',
  '"Wireless Eyewear Audio Glasses - Bluetooth 5.0, Built-in Speaker" · off · approved · stock 1',
];
const NEWEST_LISTED = { count: 10, what: "their 10 newest products", items: NEWEST_10 };
const NEWEST_ASKED = "Seller: what is the last 10 products i have uploaded";
const NEWEST_SHOWN = "Bot: *Last 10 products uploaded* / • Crocheted Beanie Hat - Pearl Embellished, Crochet Knit (Summerhat-cream) - on, approved - added 7 Oct / • Vintage Radio Eau de Parfum - 100ml, Natural Spray (100ml) - rejected - added 7 Oct / • Ventilated Safety Helmet - Blue, Adjustable Strap - on, approved - added 7 Oct / • Quilted Car Cover - Waterproof, Dustproof, All-Weather Protection (Default) - off, approved - added 7 Oct / • Kinky Curly Wig - 24 Inch Length, Full Lace - on, approved - added 7 Oct / • Asymmetrical Irregular Statement Earrings - Shell Inlay, Gold Tone - off, approved - added 7 Oct / • Kinky Curly Wig - 24 Inch Length, Full Lace - rejected - added 7 Oct / • Enhancement Dietary Supplement - Collagen Boosters, Lifts Buttocks - rejected - added 4 Oct / • 20000mAh Power Bank - Dual LED Flashlight, 4 Built-In Cables - rejected - added 2 Oct / • Wireless Eyewear Audio Glasses - Bluetooth 5.0, Built-in Speaker - off, approved - added 2 Oct";
const BEANIE_DRAFT: DraftFact = { title: "Crocheted Pearl Beanie - Fashion Headwear, One Size", price: 130 };
const PERFUME_TEXT = "Introducing the captivating Vintage Radio Eau de Parfum, a fragrance designed to evoke a sense of nostalgia and timeless elegance. This exquisite scent is presented in a unique bottle that artfully mimics the charm of a classic vintage radio, making it a statement piece for any vanity. The fragrance itself is a harmonious blend, crafted as a natural spray for effortless application. With a generous volume of 100ml, this Eau de Parfum offers a long-lasting olfactory experience, perfect for both everyday wear and special occasions.\n\nProduct Details:\n\nFragrance Type: Eau de Parfum\nVolume: 100ml / 3.4 fl.oz\nApplication: Natural Spray Vaporisateur";

const reply: Shape = { type: "reply" };
const help: Shape = { type: "help" };
const note: Shape = { type: "note" };
const restart: Shape = { type: "restart" };
const stock = (product: string, n: number): Shape => ({ type: "live_change", product: `~${product}`, "change.kind": "stock", "change.stock": n });
const price = (product: string, n: number): Shape => ({ type: "live_change", product: `~${product}`, "change.kind": "price", "change.price": n });
const onOff = (product: string, active: boolean): Shape => ({ type: "live_change", product: `~${product}`, "change.kind": "status", "change.active": active });
const info = (product: string): Shape => ({ type: "product_info", product: `~${product}` });
const sales = (period?: string, status?: string | string[]): Shape => ({ type: "sales", ...(period ? { period } : {}), ...(status ? { status } : {}) });
const newest = (limit: number): Shape => ({ type: "research", "needs.0.source": "products", "needs.0.sort": "newest", "needs.0.limit": limit });
const research: Shape = { type: "research" };
const linkReply = (link: string): Shape => ({ type: "reply", link });

// ─── The cases ───────────────────────────────────────────────────────────────

export const ASSISTANT_CASES: EvalCase[] = [
  // Greetings, small talk, outside Jumia
  { id: "chat-hi-there", src: "log 10-07 02:14", area: "chat", stage: "idle", msg: "Hi there", ok: [reply, help], note: "Was offered a new batch." },
  { id: "chat-hi", src: "log 10-08 09:09", area: "chat", stage: "idle", ctx: ["Seller: the full list of the last 10products uploaded on my shop", HOW_MANY], msg: "Hi", ok: [reply, help] },
  { id: "chat-not-listing", src: "log 10-07 02:14", area: "chat", stage: "idle", ctx: ["Seller: 0", "Bot: ⚠️ I need at least 1 product to get started — reply with how many you're listing today (1–20)."], msg: "i am not listing today", ok: [reply, help] },
  { id: "chat-love", src: "log 10-07 02:38", area: "chat", stage: "idle", msg: "love youu", ok: [reply] },
  { id: "chat-founder", src: "log 10-07 02:39", area: "chat", stage: "idle", msg: "who is your founder", ok: [reply] },
  { id: "chat-how-are-you", src: "log 10-07 06:21", area: "chat", stage: "idle", msg: "how are you", ok: [reply] },
  { id: "chat-really", src: "log 10-07 06:21", area: "chat", stage: "idle", ctx: ["Seller: My credits", "Bot: Your account isn't charged credits right now, so list as much as you like."], msg: "really", ok: [reply] },
  { id: "chat-yo", src: "log 10-07 12:16", area: "chat", stage: "review", drafts: [PERFUME], msg: "YO YO", ok: [reply, help] },
  { id: "chat-sup", src: "log 10-07 12:17", area: "chat", stage: "review", drafts: [PERFUME], msg: "sup", ok: [reply, help] },
  { id: "chat-good-night", src: "log 10-07 12:17", area: "chat", stage: "review", drafts: [PERFUME], msg: "good night", ok: [reply] },
  { id: "chat-hey-sup", src: "log 10-07 16:13", area: "chat", stage: "idle", msg: "Hey sup", ok: [reply, help] },
  { id: "chat-thanks", src: "log 10-07 20:26", area: "chat", stage: "idle", msg: "thanks", ok: [reply] },
  { id: "chat-off-topic", src: "log 10-07 20:22", area: "chat", stage: "idle", msg: "let's do something outside jumia \n how old was micheale jackson", ok: [reply] },
  { id: "chat-logo", src: "log 10-07 20:24", area: "chat", stage: "idle", msg: "send me pandaworldai logo", ok: [reply] },
  { id: "chat-message-count", src: "log 10-07 20:24", area: "chat", stage: "idle", msg: "how many messages have i sent so far", ok: [reply] },
  { id: "chat-message-count-review", src: "log 10-08 03:18", area: "chat", stage: "review", drafts: [BODYSUIT], msg: "my message count so far", ok: [reply], note: "Was read as an edit to the draft." },
  { id: "chat-french", src: "log 10-07 03:26", area: "chat", stage: "idle", msg: "reply my shop name in french", ok: [reply] },
  { id: "chat-weather", src: "variant", area: "chat", stage: "idle", msg: "whats the weather in accra today", ok: [reply] },
  { id: "chat-twi", src: "variant", area: "chat", stage: "idle", msg: "Ɛte sɛn", ok: [reply, help] },
  { id: "chat-how-to", src: "log 10-07 19:01", area: "chat", stage: "idle", ctx: [FRESH], msg: "How to", ok: [reply, help], note: "Was read as listing." },
  { id: "chat-shop-assistant-mode", src: "log 10-08 09:51", area: "chat", stage: "idle", ctx: ["Seller: Change Foldable Drone with HD Camera to 10", "Bot: 📝 10 products: add each one's photos, price and details in the form, then tap *Draft*."], msg: "Let's enter Shop assistant mode", ok: [reply, help], note: "Offered a new batch." },

  // Their account, PandaWorld, links, how-to
  { id: "help-shop-country", src: "log 10-07 02:36", area: "account_help", stage: "idle", msg: "my shop country", ok: [reply] },
  { id: "help-shop-name-is", src: "log 10-07 02:37", area: "account_help", stage: "idle", msg: "my shop name is", ok: [reply] },
  { id: "help-shop-name-what", src: "log 10-07 02:40", area: "account_help", stage: "idle", msg: "my shop name is what", ok: [reply] },
  { id: "help-shop-name", src: "log 10-07 20:27", area: "account_help", stage: "idle", msg: "what is my shop name?", ok: [reply] },
  { id: "help-shop-called", src: "log 10-07 20:37", area: "account_help", stage: "idle", msg: "my jumia shop is called", ok: [reply] },
  { id: "help-which-country", src: "log 10-07 02:40", area: "account_help", stage: "idle", ctx: ["Seller: my shop name is what", "Bot: Your shop name is GEM MALL."], msg: "in which country", ok: [reply] },
  { id: "help-countries-jumia", src: "log 10-07 03:27", area: "account_help", stage: "idle", msg: "what countries are jumia", ok: [reply] },
  { id: "help-countries-support", src: "log 10-07 06:22", area: "account_help", stage: "idle", msg: "Which countries do you support", ok: [reply] },
  { id: "help-out-of-credit", src: "log 10-07 02:37", area: "account_help", stage: "idle", msg: "what happens when i run out of credit", ok: [reply, { type: "credits" }] },
  { id: "help-packages", src: "log 10-07 02:38", area: "account_help", stage: "idle", msg: "show me current packages", ok: [reply] },
  { id: "help-admin-account", src: "log 10-07 02:50", area: "account_help", stage: "idle", msg: "is it an admin account?", ok: [reply] },
  { id: "help-seller-score", src: "log 10-07 02:48", area: "account_help", stage: "idle", msg: "my seller score?", ok: [reply, { type: "health_report" }, { type: "shop" }] },
  { id: "help-description-can-you", src: "log 10-07 02:49", area: "account_help", stage: "idle", msg: "change a products description can you do that?", ok: [reply, { type: "content_change" }] },
  { id: "help-link-vendor-center", src: "log 10-07 02:58", area: "account_help", stage: "idle", msg: "link to vendor center", ok: [linkReply("vendor_center")] },
  { id: "help-link-dashboard", src: "log 10-07 02:59", area: "account_help", stage: "idle", msg: "link to admin dashboard", ok: [reply] },
  { id: "help-link-youtube", src: "log 10-07 06:23", area: "account_help", stage: "idle", msg: "send me the link to youtube videos on how to get started", ok: [reply] },
  { id: "help-capabilities", src: "log 10-07 08:54", area: "account_help", stage: "review", drafts: [PERFUME], msg: "What are your full capabilities", ok: [reply, help] },
  { id: "help-capabilities-plain", src: "log 10-07 11:58", area: "account_help", stage: "review", drafts: [PERFUME], msg: "what are your capabilities? in plain language", ok: [reply, help] },
  { id: "help-what-can-you-do", src: "log 10-07 20:43", area: "account_help", stage: "idle", ctx: [HOW_MANY], msg: "What can you do?", ok: [reply, help] },
  { id: "help-listing-credit", src: "log 10-07 09:27", area: "account_help", stage: "review", drafts: [PERFUME], msg: "What is listing credit", ok: [reply, { type: "credits" }] },
  { id: "help-drafts-deleted", src: "log 10-07 09:29", area: "account_help", stage: "review", drafts: [PERFUME], msg: "how long do drafts stay on the review page are they deleted automatically?", ok: [reply] },
  { id: "help-link-whatsapp", src: "log 10-07 10:05", area: "account_help", stage: "review", drafts: [PERFUME], msg: "How do I link my WhatsApp to pandaworld", ok: [reply] },
  { id: "help-extension", src: "log 10-07 12:04", area: "account_help", stage: "review", drafts: [PERFUME], msg: "What can the crome extension do?", ok: [reply] },
  { id: "help-autofills", src: "log 10-07 12:19", area: "account_help", stage: "review", drafts: [PERFUME], msg: "my autofills so far", ok: [reply], note: "Sent the WhatsApp drafts link instead of the extension's." },
  { id: "help-connect-whatsapp", src: "log 10-07 16:14", area: "account_help", stage: "idle", msg: "how do i connect my whatsapp", ok: [reply] },
  { id: "help-whatsapp-connected", src: "log 10-07 16:14", area: "account_help", stage: "idle", msg: "is my whatsapp connected?", ok: [reply] },
  { id: "help-whatsapp-number", src: "log 10-07 16:15", area: "account_help", stage: "idle", msg: "what is my whatsapp number?", ok: [reply] },
  { id: "help-whatsapp-connected-how", src: "log 10-07 20:25", area: "account_help", stage: "idle", msg: "i want to know if my whatsapp is connected to pandawoldai if not how can i", ok: [reply] },
  { id: "help-pack", src: "log 10-07 16:25", area: "account_help", stage: "idle", msg: "what pack am i on?", ok: [reply] },
  { id: "help-pack-can-do", src: "log 10-07 16:26", area: "account_help", stage: "idle", msg: "list what i can do with my current pack", ok: [reply, help], note: "\"list\" here isn't listing products." },
  { id: "help-video-connect", src: "log 10-07 17:19", area: "account_help", stage: "idle", msg: "Okay show me the video to connect my vendor center", ok: [reply] },
  { id: "help-link-assistant", src: "log 10-07 18:19", area: "account_help", stage: "review", drafts: [BODYSUIT], msg: "send me the link to the listing assistant", ok: [linkReply("assistant"), reply] },
  { id: "help-download-label", src: "log 10-07 16:27", area: "account_help", stage: "idle", msg: "download a label", ok: [reply, { type: "orders" }] },

  // Credits
  { id: "money-my-credits", src: "log 10-07 06:20", area: "money", stage: "idle", msg: "My credits", ok: [{ type: "credits" }] },
  { id: "money-remaining-credit", src: "log 10-07 17:18", area: "money", stage: "idle", msg: "Hey what is my remaining credit", ok: [{ type: "credits" }] },
  { id: "money-credits-variant", src: "variant", area: "money", stage: "idle", msg: "how much credit do i hav left", ok: [{ type: "credits" }] },

  // Payouts
  { id: "money-statement", src: "log 10-07 02:43", area: "money", stage: "idle", msg: "my current statement", ok: [{ type: "payouts" }, { type: "payout_detail" }] },
  { id: "money-payout-history", src: "log 10-07 12:02", area: "money", stage: "review", drafts: [PERFUME], msg: "my all time payout history", ok: [{ type: "payout_detail", mode: "history" }] },
  { id: "money-payout-ref", src: "log 10-07 12:03", area: "money", stage: "review", drafts: [PERFUME], ctx: ["Seller: my all time payout history", "Bot: 💰 Your Jumia statements (last 90 days) / • 2026-10-05 · PS261005GH129M0 · *GHS 0* · not paid yet / • 2026-08-31 · PS260831GH129M0 · *GHS 144* · paid (ref 89069647477)"], msg: "tell me more about payout ref 88564599889", ok: [{ type: "payout_detail" }, reply] },
  { id: "money-when-paid", src: "variant", area: "money", stage: "idle", msg: "when is jumia paying me", ok: [{ type: "payouts" }, { type: "payout_detail" }] },
  { id: "money-made-90-days", src: "log 10-07 02:42", area: "money", stage: "idle", msg: "how much has my shop made in 90days", ok: [sales("quarter")] },

  // Orders
  { id: "orders-had-today", src: "log 10-07 02:16", area: "orders", stage: "idle", msg: "i want to know if i had orders today", ok: [sales("today"), { type: "orders" }] },
  { id: "orders-evening", src: "log 10-07 02:16", area: "orders", stage: "idle", ctx: ["Bot: ✅ No Jumia orders waiting for you. I'll message you when a new one comes in."], msg: "i had order in the evening what happened?", ok: [sales(), { type: "orders" }, reply] },
  { id: "orders-which-ones", src: "log 10-07 02:17", area: "orders", stage: "idle", msg: "okay \n let me know what orders they are", ok: [{ type: "orders" }, sales()] },
  { id: "orders-rts-cancelled-yesterday", src: "log 10-07 02:17", area: "orders", stage: "idle", msg: "check for ready to ship and cancelled order yesterday", ok: [sales("yesterday", ["READY_TO_SHIP", "CANCELED"])] },
  { id: "orders-second-on-list", src: "log 10-07 02:19", area: "orders", stage: "idle", ctx: ["Seller: check for ready to ship and cancelled order yesterday", "Bot: 📦 3 cancelled Jumia orders yesterday / • #394666919 · GHS 94 · 6 Oct / • #355926919 · GHS 238 · 6 Oct / • #388412909 · GHS 120 · 6 Oct"], msg: "tell me about the second order on your list", ok: [{ type: "order_status", number: "355926919" }] },
  { id: "orders-this-one", src: "log 10-07 19:04", area: "orders", stage: "idle", msg: "tellme about this one ⁠#394666919 · GHS 94 · 6 Oct", ok: [{ type: "order_status", number: "394666919" }] },
  { id: "orders-shipping", src: "log 10-07 02:41", area: "orders", stage: "idle", msg: "send me shipping orders", ok: [{ type: "orders" }, sales(undefined, "SHIPPED")] },
  { id: "orders-labels-meant", src: "log 10-07 02:41", area: "orders", stage: "idle", ctx: ["Seller: send me shipping orders", "Bot: ✅ No Jumia orders waiting for you. I'll message you when a new one comes in."], msg: "shipping labels i meant", ok: [{ type: "orders" }, reply] },
  { id: "orders-labels-cancelled", src: "log 10-07 02:41", area: "orders", stage: "idle", msg: "labels for cancellled orders", ok: [reply] },
  { id: "orders-delivered-returned", src: "log 10-07 02:47", area: "orders", stage: "idle", msg: "any delivered orders past time? and returned orders too", ok: [sales(undefined, ["DELIVERED", "RETURNED"]), sales("quarter")] },
  { id: "orders-returns", src: "log 10-07 02:47", area: "orders", stage: "idle", msg: "returns", ok: [sales(undefined, "RETURNED"), { type: "report", kind: "returns" }] },
  { id: "orders-had-returns", src: "log 10-07 02:48", area: "orders", stage: "idle", msg: "i want to know if i had returns", ok: [sales(undefined, "RETURNED"), { type: "report", kind: "returns" }] },
  { id: "orders-yesterday-today", src: "log 10-07 08:52", area: "orders", stage: "review", drafts: [PERFUME], msg: "Do I have orders for yesterday and today?", ok: [sales("yesterday"), sales("today"), sales("week")] },
  { id: "orders-and-today", src: "log 10-07 08:52", area: "orders", stage: "review", drafts: [PERFUME], ctx: ["Seller: Do I have orders for yesterday and today?", "Bot: 📊 3 Jumia orders yesterday · GHS 0 / Cancelled 3"], msg: "And today?", ok: [sales("today")] },
  { id: "orders-my-today", src: "log 10-07 19:03", area: "orders", stage: "idle", msg: "my orders today", ok: [sales("today"), { type: "orders" }] },
  { id: "orders-cancelled", src: "log 10-07 19:03", area: "orders", stage: "idle", ctx: ["Seller: my orders today", "Bot: No Jumia orders today yet."], msg: "cancelled orders", ok: [sales(undefined, "CANCELED")] },
  { id: "orders-yes-other-period", src: "log 10-07 19:03", area: "orders", stage: "idle", ctx: ["Seller: cancelled orders", "Bot: I can't find any cancelled orders for today. Would you like to see orders from another period?"], msg: "yes", ok: [reply, sales()] },
  { id: "orders-cancelled-yesterday", src: "log 10-07 19:04", area: "orders", stage: "idle", msg: "cancelled order yesturday", ok: [sales("yesterday", "CANCELED")] },
  { id: "orders-two-cancelled", src: "log 10-07 20:26", area: "orders", stage: "idle", msg: "yesturday i had 2 orders but i cold see only 2 was it cancelled?", ok: [sales("yesterday")] },
  { id: "orders-to-pack", src: "variant", area: "orders", stage: "idle", msg: "orders waiting to be packed", ok: [{ type: "orders" }] },
  { id: "orders-typo", src: "variant", area: "orders", stage: "idle", msg: "any new orderz today?", ok: [sales("today"), { type: "orders" }] },
  { id: "orders-bought-week", src: "variant", area: "orders", stage: "idle", msg: "did anybody buy anything from me this week", ok: [sales("week")] },
  { id: "orders-after-count-question", src: "variant", area: "orders", stage: "idle", ctx: [HOW_MANY], msg: "show me 2 cancelled orders from yesterday", ok: [sales("yesterday", "CANCELED")], note: "A number after \"how many\" that isn't a count." },

  // Reading their shop
  { id: "shop-creatine", src: "log 10-07 02:43", area: "shop_info", stage: "idle", msg: "do i have a product called creatine?", ok: [{ type: "stock", product: "~creatine" }, info("creatine"), research] },
  { id: "shop-drones", src: "log 10-07 02:44", area: "shop_info", stage: "idle", ctx: ["Seller: do i have a product called creatine?", "Bot: 📦 Stock on Jumia / • Creatine Monohydrate Micronized Powder (300G) - Pure Creati…: 2 left"], msg: "what about drones", ok: [{ type: "stock", product: "~drone" }, info("drone"), research] },
  { id: "shop-dron-active", src: "log 10-07 02:45", area: "shop_info", stage: "idle", msg: "is the dron active", ok: [info("dron")], note: "Was read as turning it on." },
  { id: "shop-drone-live", src: "log 10-07 02:45", area: "shop_info", stage: "idle", msg: "is the drone live?", ok: [info("drone")] },
  { id: "shop-enhancement-status", src: "log 10-07 04:14", area: "shop_info", stage: "idle", msg: "What is the status of enhancement dietary supplement", ok: [info("enhancement")] },
  { id: "shop-how-many-on", src: "log 10-07 08:53", area: "shop_info", stage: "review", drafts: [PERFUME], msg: "How many of my products are on", ok: [{ type: "shop" }] },
  { id: "shop-on-and-off", src: "log 10-07 08:54", area: "shop_info", stage: "review", drafts: [PERFUME], msg: "How many of my products live on JUMIA is on and off", ok: [{ type: "shop" }] },
  { id: "shop-total-count", src: "log 10-08 09:29", area: "shop_info", stage: "review", drafts: [TSHIRT_SET], msg: "what is the total number of products on my shop just give me the count", ok: [{ type: "shop" }, research] },
  { id: "shop-rejected", src: "log 10-07 09:45", area: "shop_info", stage: "review", drafts: [PERFUME], msg: "can you tellme my rejected products?", ok: [{ type: "shop", filter: "rejected" }, { type: "research", "needs.0.filter": "rejected" }] },
  { id: "shop-rejected-what-happened", src: "log 10-08 09:30", area: "shop_info", stage: "review", drafts: [TSHIRT_SET], msg: "look into the rejected ones what happened", ok: [{ type: "shop", filter: "rejected" }, { type: "research", "needs.0.filter": "rejected" }] },
  { id: "shop-rejection-reason", src: "log 10-07 10:02", area: "shop_info", stage: "review", drafts: [PERFUME], ctx: ["Seller: can you tellme my rejected products?", REJECTED_LIST], msg: "Reason for the rejection?", ok: [reply, { type: "shop", filter: "rejected" }, research] },
  { id: "shop-rejection-reasons", src: "log 10-08 09:31", area: "shop_info", stage: "review", drafts: [TSHIRT_SET], ctx: ["Seller: look into the rejected ones what happened", REJECTED_LIST], msg: "rejection reasons", ok: [reply, { type: "shop", filter: "rejected" }, research] },
  { id: "shop-name-malta", src: "log 10-08 09:31", area: "shop_info", stage: "review", drafts: [TSHIRT_SET], catalog: CATALOG, ctx: [REJECTED_LIST, "Seller: rejection reasons", "Bot: Which rejected products would you like to know the reasons for? Please specify the product names."], msg: "Malta Guinness Soft Drink - 330ml Bottles, Pack of 6", ok: [info("malta")], note: "Got \"I can only look up products related to your shop\"." },
  { id: "shop-name-wig", src: "log 10-08 09:32", area: "shop_info", stage: "review", drafts: [TSHIRT_SET], catalog: CATALOG, ctx: [REJECTED_LIST], msg: "Water Wave Lace Front Wig", ok: [info("wig")] },
  { id: "shop-ceiling-fans", src: "log 10-08 09:25", area: "shop_info", stage: "review", drafts: [TSHIRT_SET], msg: "check if i have any product related to Ceilling fans on my shop", ok: [info("fan"), { type: "stock", product: "~fan" }, research] },
  { id: "shop-medal-quantity", src: "log 10-07 16:18", area: "shop_info", stage: "idle", msg: "what is the quantity of my medal product", ok: [{ type: "stock", product: "~medal" }, info("medal")] },
  { id: "shop-out-of-stock", src: "variant", area: "shop_info", stage: "idle", msg: "wat is out of stock", ok: [{ type: "stock", filter: "out" }, { type: "research", "needs.0.filter": "out_of_stock" }] },
  { id: "shop-approved", src: "variant", area: "shop_info", stage: "idle", msg: "has jumia approved my kettle yet", ok: [info("kettle")] },
  { id: "shop-newest-10", src: "log 10-08 09:09", area: "shop_info", stage: "idle", ctx: ["Seller: Hi", "Bot: Hi there! 👋 I'm PandaWorld's Jumia Listing Assistant."], msg: "the full list of the last 10products uploaded on my shop", ok: [newest(10)], note: "Got \"I can't\", a new batch, and the hello menu." },
  { id: "shop-newest-20", src: "log 10-08 10:03", area: "shop_info", stage: "review", drafts: [WORKOUT], msg: "the full list of the last 20products uploaded on my shop", ok: [newest(20)] },
  { id: "shop-newest-variant-5", src: "variant", area: "shop_info", stage: "idle", msg: "show me my 5 newest products", ok: [newest(5)] },
  { id: "shop-newest-variant-last", src: "variant", area: "shop_info", stage: "idle", msg: "what did i upload last on jumia", ok: [{ type: "research", "needs.0.sort": "newest" }] },
  { id: "shop-newest-after-count", src: "variant", area: "shop_info", stage: "idle", ctx: [HOW_MANY], msg: "latest 3 items in my store?", ok: [newest(3)], note: "A number after \"how many\" that isn't a count." },
  { id: "shop-insight", src: "log 10-07 20:44", area: "shop_info", stage: "idle", msg: "Give. Me insight", ok: [{ type: "shop" }, { type: "health_report" }, research] },
  { id: "shop-insight-starting", src: "log 10-07 20:45", area: "shop_info", stage: "starting", ctx: ["Seller: 4", "Bot: Got it — 4 products. You can send all 4 in two ways."], msg: "Given me insight into my shop’s performance", ok: [{ type: "shop" }, { type: "health_report" }, research] },
  { id: "shop-reports", src: "log 10-07 12:00", area: "shop_info", stage: "review", drafts: [PERFUME], msg: "reports", ok: [{ type: "report" }, { type: "health_report" }] },
  { id: "shop-write-report", src: "log 10-07 12:00", area: "shop_info", stage: "review", drafts: [PERFUME], msg: "write a report on my shop", ok: [{ type: "health_report" }, { type: "report" }] },
  { id: "shop-best-sellers", src: "variant", area: "shop_info", stage: "idle", msg: "which of my things sell the most", ok: [{ type: "report", kind: "best_sellers" }, research] },

  // Fees
  { id: "fees-creatine", src: "log 10-07 03:04", area: "money", stage: "idle", msg: "my creatine product how much will i recieve if it is sold?", ok: [{ type: "fees", product: "~creatine" }] },
  { id: "fees-wellington", src: "log 10-07 03:05", area: "money", stage: "idle", msg: "how much will jumia charge me for the wellington whe delivered", ok: [{ type: "fees", product: "~wellington" }] },
  { id: "fees-creatine-review", src: "log 10-07 09:30", area: "money", stage: "review", drafts: [PERFUME], msg: "how much will i make on my creatine if it is delivered by jumia", ok: [{ type: "fees", product: "~creatine" }] },
  { id: "fees-sku-pick", src: "log 10-07 09:31", area: "money", stage: "review", drafts: [PERFUME], ctx: ["Seller: how much will i make on my creatine if it is delivered by jumia", "Bot: \"creatine\" could be 3 products. Which one? / • ON Micronized Creatine Powder – (60 Servings) (Blueberry L… (SKU GEMMALLBL) / • Creatine Monohydrate Micronized Powder (300G) (SKU GEMMALLCR)"], msg: "GEMMALLBL", ok: [{ type: "fees", product: "~GEMMALLBL" }, info("GEMMALLBL")] },

  // Changing live products
  { id: "live-stock-those", src: "log 10-07 02:20", area: "live_changes", stage: "idle", ctx: ["Seller: tell me about the second order on your list", "Bot: 📦 Order #355926919: Cancelled / Ordered 6 Oct · GHS 238 / • NASF2-90 Top Mounted Freezer - 65 Ltrs, Manual De…: Cancelled"], msg: "update the stock of those products to 10 each", ok: [{ type: "live_change", "change.stock": 10 }, reply] },
  { id: "live-stock-three-named", src: "log 10-07 02:21", area: "live_changes", stage: "idle", ctx: ["Seller: update the stock of those products to 10 each", "Bot: I couldn't find \"those products\" among your 429 Jumia products. Try its name as it shows on Jumia, or its SKU."], msg: "okay the Mounted freezer and the blender and the chainsaw", ok: [{ type: "live_change", "change.kind": "stock", "change.stock": 10 }] },
  { id: "live-stock-three-after-restart", src: "log 10-07 02:23", area: "live_changes", stage: "idle", ctx: ["Seller: restart", FRESH], msg: "i meant the stock of the Mounted freezer and the blender and the chainsaw should be made 10", ok: [{ type: "live_change", "change.kind": "stock", "change.stock": 10 }], note: "A number after \"how many\" that isn't a count." },
  { id: "live-stock-three", src: "log 10-07 02:24", area: "live_changes", stage: "idle", msg: "change the stock of the Mounted freezer and the blender and the chainsaw on my shop to 10", ok: [{ type: "live_change", "change.kind": "stock", "change.stock": 10 }] },
  { id: "live-off-all", src: "log 10-07 02:45", area: "live_changes", stage: "idle", msg: "off all products", ok: [{ type: "bulk", "change.kind": "status", "change.active": false }, reply] },
  { id: "live-on-creatine", src: "log 10-07 02:54", area: "live_changes", stage: "idle", ctx: ["Seller: stop", FRESH], msg: "turn on the creatine", ok: [onOff("creatine", true)] },
  { id: "live-on-drone-typo", src: "log 10-07 02:55", area: "live_changes", stage: "idle", msg: "also tun on the drone", ok: [onOff("drone", true)] },
  { id: "live-on-drone", src: "log 10-07 02:55", area: "live_changes", stage: "idle", msg: "turn on the drone also", ok: [onOff("drone", true)] },
  { id: "live-off-all-except", src: "log 10-07 02:56", area: "live_changes", stage: "idle", msg: "off all other products apart from the ones i asked you turn on", ok: [reply, { type: "bulk", "change.kind": "status", "change.active": false }] },
  { id: "live-price-safety-boot", src: "log 10-07 04:15", area: "live_changes", stage: "idle", msg: "Update the safety boot price to 300", ok: [price("safety boot", 300)] },
  { id: "live-price-pick-name", src: "log 10-07 04:17", area: "live_changes", stage: "idle", catalog: CATALOG, ctx: ["Seller: Update the safety boot price to 300", "Bot: Which product should I change (price to GHS 300)? I'll ask you to confirm before anything changes on Jumia."], msg: "Men’s work safety Shoes", ok: [price("safety", 300), info("safety")] },
  { id: "live-sale-this-month", src: "log 10-07 04:19", area: "live_changes", stage: "idle", msg: "Set sale price @150 for men’s safety shoe with start and end date in this month", ok: [{ type: "live_change", product: "~safety", "change.kind": "sale" }] },
  { id: "live-sale-no-dates", src: "log 10-07 04:24", area: "live_changes", stage: "idle", msg: "Set sale price to 150 for pa-mou7Izdd", ok: [reply, { type: "live_change", "change.kind": "sale" }], note: "A sale needs dates: asking for them is right." },
  { id: "live-change-alone", src: "log 10-07 16:19", area: "live_changes", stage: "idle", ctx: ["Seller: what is the quantity of my medal product", "Bot: ⚪ *Gold Medals with Ribbons - Bulk Pack for Sports, School, & Award Ceremonies* · SKU GEMMALL5 / • Status: off / • Stock: 40 left"], msg: "Change", ok: [reply], note: "Offered a new batch." },
  { id: "live-price-medal-sku", src: "log 10-07 16:24", area: "live_changes", stage: "idle", ctx: ["Seller: Change", HOW_MANY], msg: "Change the price of the gold medal with the SKU GEMMALL5 to 500", ok: [price("medal", 500), price("GEMMALL5", 500)] },
  { id: "live-off-back", src: "log 10-08 09:27", area: "live_changes", stage: "review", drafts: [TSHIRT_SET], ctx: ["Bot: ✅ Sent to Jumia: *Portable USB Rechargeable Neck Fan – 360° Adjustable Hands-Free Wearable Sports Fan with 3 Speeds*, turn it on (shown on Jumia)."], msg: "turn it back off", ok: [onOff("fan", false)] },
  { id: "live-restock-all", src: "log 10-08 09:34", area: "live_changes", stage: "review", drafts: [TSHIRT_SET], listed: { count: 5, what: "out of stock" }, ctx: ["Seller: out of stock", OUT_OF_STOCK_LIST], msg: "restock all back to 10", ok: [{ type: "bulk", scope: "listed", "change.stock": 10 }, { type: "bulk", scope: "out_of_stock", "change.stock": 10 }, { type: "live_change", "change.stock": 10, others: "~Pedestal" }], note: "Warned about a colour. Naming the 5 listed products is the same change." },
  { id: "live-restock-drone", src: "log 10-08 09:36", area: "live_changes", stage: "idle", ctx: ["Seller: stop", FRESH], msg: "restock the foladable drone to. 10", ok: [stock("drone", 10)], note: "Offered a new batch." },
  { id: "live-change-drone-plain", src: "log 10-08 09:37", area: "live_changes", stage: "idle", ctx: ["Seller: restock the foladable drone to. 10", HOW_MANY], msg: "Change the foladable drone to. 10", ok: [stock("drone", 10), reply] },
  { id: "live-change-drone-psc", src: "log 10-08 09:38", area: "live_changes", stage: "idle", ctx: ["Seller: Change the foladable drone to. 10", HOW_MANY], msg: "Change drone to 10 psc", ok: [stock("drone", 10)] },
  { id: "live-change-fan-psc", src: "log 10-08 09:41", area: "live_changes", stage: "idle", ctx: ["Seller: 3", "Bot: 📝 3 products: add each one's photos, price and details in the form, then tap *Draft*."], msg: "Change Pedestal Fan - 5-Blade Airflow, Metal Grille (Black) to 10 psc", ok: [stock("pedestal fan", 10)] },
  { id: "live-change-restock-drone", src: "log 10-08 09:42", area: "live_changes", stage: "idle", ctx: ["Seller: Change Pedestal Fan - 5-Blade Airflow, Metal Grille (Black) to 10 psc", "Bot: Change *Pedestal Fan - 5-Blade Airflow, Metal Grille (Black)* (SKU PA-MU8UC4O9): stock 0 → 10?"], msg: "Change restock the foladable drone to. 10", ok: [stock("drone", 10), reply] },
  { id: "live-change-drone-pcs", src: "log 10-08 09:43", area: "live_changes", stage: "idle", ctx: ["Seller: Change foladable drone to. 10", HOW_MANY], msg: "Change Foldable Drone with HD Camera to 10pcs", ok: [stock("drone", 10)] },
  { id: "live-change-drone-to-10", src: "log 10-08 09:50", area: "live_changes", stage: "idle", ctx: ["Seller: Change Foldable Drone with HD Camera to 10pcs", HOW_MANY], msg: "Change Foldable Drone with HD Camera to 10", ok: [stock("drone", 10), reply], note: "Opened a form for 10 products." },
  { id: "live-listed-last-10", src: "log 10-08 10:04", area: "live_changes", stage: "review", drafts: [WORKOUT], listed: { count: 20, what: "The 20 newest products in the Jumia shop, newest first" }, ctx: ["Seller: the full list of the last 20products uploaded on my shop", "Bot: *Last 20 uploaded products, newest first* / • Crocheted Beanie Hat - Pearl Embellished · GHS 100 · stock unknown / • Vintage Radio Eau de Parfum · GHS 129 · 4 in stock"], msg: "change the stock of the lat 10 to 20", ok: [{ type: "bulk", scope: "listed", "change.stock": 20 }], note: "Got the review step's help." },
  // Rewordings: one request, many ways to write it
  { id: "live-v-kettle-qty", src: "variant", area: "live_changes", stage: "idle", msg: "set kettle qty to 25", ok: [stock("kettle", 25)] },
  { id: "live-v-kettle-should-be", src: "variant", area: "live_changes", stage: "idle", msg: "kettle stock should be 25 now", ok: [stock("kettle", 25)] },
  { id: "live-v-kettle-have", src: "variant", area: "live_changes", stage: "idle", msg: "i now have 25 kettles, update it", ok: [stock("kettle", 25)] },
  { id: "live-v-blender-restok", src: "variant", area: "live_changes", stage: "idle", msg: "restok the blender to 40 pls", ok: [stock("blender", 40)] },
  { id: "live-v-blender-equals", src: "variant", area: "live_changes", stage: "idle", msg: "update stock for blender = 12", ok: [stock("blender", 12)] },
  { id: "live-v-kettle-reduce-price", src: "variant", area: "live_changes", stage: "idle", msg: "reduce the price of the kettle to 120", ok: [price("kettle", 120)] },
  { id: "live-v-kettle-sell-at", src: "variant", area: "live_changes", stage: "idle", msg: "sell the kettle at 120 cedis from now", ok: [price("kettle", 120)] },
  { id: "live-v-kettle-ghs", src: "variant", area: "live_changes", stage: "idle", msg: "kettle price GHS 120", ok: [price("kettle", 120)] },
  { id: "live-v-after-count-price", src: "variant", area: "live_changes", stage: "idle", ctx: [HOW_MANY], msg: "the drone price should be 300", ok: [price("drone", 300)], note: "A number after \"how many\" that isn't a count." },
  { id: "live-v-after-count-stock", src: "variant", area: "live_changes", stage: "idle", ctx: [HOW_MANY], msg: "set my wig stock to 5", ok: [stock("wig", 5)], note: "A number after \"how many\" that isn't a count." },
  { id: "live-v-hide", src: "variant", area: "live_changes", stage: "idle", msg: "hide the blender from jumia", ok: [onOff("blender", false)] },
  { id: "live-v-deactivate", src: "variant", area: "live_changes", stage: "idle", msg: "deactivate blender", ok: [onOff("blender", false)] },
  { id: "live-v-visible", src: "variant", area: "live_changes", stage: "idle", msg: "make the blender visible again", ok: [onOff("blender", true)] },
  { id: "live-v-is-on-question", src: "variant", area: "live_changes", stage: "idle", msg: "is the blender on?", ok: [info("blender")], note: "A question, not a change." },
  { id: "live-v-sale-weekend", src: "variant", area: "live_changes", stage: "idle", msg: "put the kettle on promo at 100 this weekend", ok: [{ type: "live_change", product: "~kettle", "change.kind": "sale" }] },
  { id: "live-v-bulk-percent", src: "variant", area: "live_changes", stage: "idle", msg: "10% off all perfumes this weekend", ok: [{ type: "bulk", scope: "matching", "change.kind": "sale_pct" }] },
  { id: "live-v-bulk-off-oos", src: "variant", area: "live_changes", stage: "idle", msg: "turn off everything that is out of stock", ok: [{ type: "bulk", scope: "out_of_stock", "change.active": false }] },
  { id: "live-v-those-price", src: "variant", area: "live_changes", stage: "idle", listed: { count: 5, what: "out of stock" }, ctx: ["Seller: out of stock", OUT_OF_STOCK_LIST], msg: "set those to 15 pcs each", ok: [{ type: "bulk", scope: "listed", "change.stock": 15 }] },

  // Listing new products
  { id: "list-wellington", src: "log 10-07 02:50", area: "listing", stage: "idle", msg: "let's list a wellington boot", ok: [{ type: "list", count: 1 }, restart] },
  { id: "list-upload-two", src: "log 10-07 06:23", area: "listing", stage: "idle", msg: "i want to upload two products now", ok: [{ type: "list", count: 2 }] },
  { id: "list-upload-five-starting", src: "log 10-07 21:39", area: "listing", stage: "starting", ctx: ["Seller: Hi"], msg: "I want to upload 5 products", ok: [{ type: "list", count: 5 }] },
  { id: "list-some", src: "log 10-07 22:01", area: "listing", stage: "idle", msg: "I want to list some products", ok: [restart] },
  { id: "list-five-review", src: "log 10-08 08:43", area: "listing", stage: "review", drafts: [{ title: "Olive & Milk Shower Cream - Nourishes Skin, With Vitamin E" }], msg: "I want to list 5 products", ok: [{ type: "list", count: 5 }] },
  { id: "list-new-review", src: "log 10-08 03:31", area: "listing", stage: "review", drafts: [BODYSUIT], msg: "let's list new products", ok: [restart] },
  { id: "list-listing-mode", src: "log 10-08 09:51", area: "listing", stage: "idle", ctx: ["Seller: Let's enter Shop assistant mode", HOW_MANY], msg: "let's enter listing mode", ok: [restart, reply] },
  { id: "list-go-ahead-stopped", src: "log 10-07 20:41", area: "listing", stage: "idle", ctx: ["Seller: status", "Bot: Ready when you are — reply with how many products you're listing today."], msg: "go ahead with the listing i just stoped please", ok: [restart, { type: "review" }, reply] },
  { id: "list-hold-list-another", src: "log 10-07 02:35", area: "listing", stage: "review", drafts: [PERFUME], msg: "Hold on this for now let's list another before", ok: [restart] },
  { id: "list-v-three-items", src: "variant", area: "listing", stage: "idle", msg: "i have 3 items to sell", ok: [{ type: "list", count: 3 }] },
  { id: "list-v-wanna-post", src: "variant", area: "listing", stage: "idle", msg: "i wanna post 2 things on jumia", ok: [{ type: "list", count: 2 }] },
  { id: "list-v-shirts-fridge", src: "variant", area: "listing", stage: "idle", msg: "2 shirts and a fridge", ok: [{ type: "list", count: 3 }] },
  { id: "list-v-lets-list", src: "variant", area: "listing", stage: "idle", msg: "lets list", ok: [restart] },
  { id: "list-stop", src: "log 10-08 09:08", area: "listing", stage: "collecting", msg: "Stop listing", ok: [restart] },
  { id: "list-stop-creation", src: "log 10-07 22:14", area: "listing", stage: "review", drafts: [BODYSUIT], msg: "Put a stop to this product creation", ok: [restart, reply] },
  { id: "list-dont-list-again", src: "log 10-07 21:09", area: "listing", stage: "drafting", msg: "Don't list tbis again pls", ok: [restart, reply] },
  { id: "list-wont-continue", src: "log 10-08 08:47", area: "listing", stage: "collecting", ctx: ["Seller: done", "Bot: ✅ Product 1 saved (5 photos, notes saved). Next: product 2 of 5. Upload its photos with the price and notes."], msg: "i won't continue draft for only product 1", ok: [restart, reply], note: "Was saved as product 2's notes." },
  { id: "list-done-no-batch", src: "log 10-07 20:36", area: "listing", stage: "idle", ctx: ["Seller: [a photo]", "Seller: [a photo]"], msg: "done", ok: [restart, reply, help, note] },
  { id: "list-category-question", src: "log 10-07 02:51", area: "listing", stage: "starting", ctx: ["Seller: let's list a wellington boot", "Bot: Let's go — send its photos, and tell me the price plus any other notes."], msg: "what category should we use", ok: [reply, { type: "category_info" }] },
  { id: "list-done-sending", src: "log 10-07 20:21", area: "listing", stage: "starting", msg: "done sending", ok: [note, reply] },
  { id: "list-three-different", src: "log 10-07 21:45", area: "listing", stage: "collecting", ctx: ["Seller: Done", "Bot: ✅ Product 1 saved (3 photos, notes saved). Next: product 2 of 3 — photos + price/notes, then *done*."], msg: "Those are 3 different products", ok: [note, reply] },
  { id: "list-note-sku", src: "log 10-07 22:05", area: "listing", stage: "collecting", msg: "I want you to do the sku K WiFi", ok: [note] },
  { id: "list-note-use", src: "log 10-07 22:05", area: "listing", stage: "collecting", ctx: ["Seller: Price: 130gh \n Sizes: Large, Medium, Small. \n Colors: cream, black and brown"], msg: "Use as listing note", ok: [note] },
  { id: "list-note-pieces", src: "log 10-07 22:10", area: "listing", stage: "collecting", msg: "3 pieces for 90cedis", ok: [note] },
  { id: "list-note-price-sizes", src: "variant", area: "listing", stage: "collecting", msg: "price 150, sizes M and L, black", ok: [note] },
  { id: "list-question-mid-batch", src: "variant", area: "listing", stage: "collecting", msg: "has jumia paid me this week?", ok: [{ type: "payouts" }, { type: "payout_detail" }], note: "A question while sending photos isn't the product's notes." },

  // Editing drafts
  { id: "draft-brand-perfume", src: "log 10-07 08:58", area: "drafts", stage: "review", drafts: [PERFUME], msg: "Change brand name to perfume", ok: [{ type: "edit", "edits.0.changes.brand": "~perfume" }] },
  { id: "draft-brand-generic", src: "log 10-07 09:26", area: "drafts", stage: "review", drafts: [PERFUME], msg: "Change the brand to generic", ok: [{ type: "edit", "edits.0.changes.brand": "~generic" }] },
  { id: "draft-delete", src: "log 10-07 09:28", area: "drafts", stage: "review", drafts: [PERFUME], msg: "Delete draft", ok: [reply, restart, { type: "review" }] },
  { id: "draft-delete-today", src: "log 10-07 18:20", area: "drafts", stage: "review", drafts: [BODYSUIT], msg: "delete my drafts for today", ok: [reply, { type: "review" }, restart], note: "Was read as an edit." },
  { id: "draft-sizes-list", src: "log 10-07 18:15", area: "drafts", stage: "review", drafts: [BODYSUIT], msg: "Sizes: Large, Medium, Small.", ok: [{ type: "edit", "edits.0.changes.variations": ["L", "M", "S"] }] },
  { id: "draft-variation-typo", src: "log 10-07 18:16", area: "drafts", stage: "review", drafts: [BODYSUIT], msg: "Chanage the draft variation to Large, Medium, Small.", ok: [{ type: "edit", "edits.0.changes.variations": ["L", "M", "S"] }] },
  { id: "draft-variation-order", src: "log 10-07 18:44", area: "drafts", stage: "review", drafts: [BODYSUIT], msg: "change the variation to Small, medium and, Large", ok: [{ type: "edit", "edits.0.changes.variations": ["S", "M", "L"] }] },
  { id: "draft-variation-answer", src: "log 10-08 09:59", area: "drafts", stage: "review", drafts: [WORKOUT], waitingFor: "a drafted product's variation (its sizes or the like)", ctx: ["Bot: ✅ Product drafted: Workout Set - Short Sleeve Top, Pocket Shorts. / *What variation(s) do you have?* Reply with one or more of the stocked options (XS, S, M, L, XL and 1417 more)"], msg: "Large, Medium and Small", ok: [{ type: "edit", "edits.0.changes.variations": ["L", "M", "S"], dropped: [] }, note], note: "Warned about a colour." },
  { id: "draft-price-sizes-colours", src: "log 10-08 03:16", area: "drafts", stage: "review", drafts: [BODYSUIT], msg: "Price: 130gh \n Sizes: Large, Medium, Small. \n Colors: cream, black and brown", ok: [{ type: "edit", "edits.0.changes.price": 130, "edits.0.changes.variations": ["L", "M", "S"] }] },
  { id: "draft-two-products", src: "log 10-08 03:25", area: "drafts", stage: "review", drafts: [BODYSUIT, PERFUME], msg: "Product 1 Price: 130gh \n Sizes: Large, Medium, Small. \n Colors: cream, black and brown \n\n Product 2 \n The volume is 100ml", ok: [{ type: "edit", "edits.0.seqs": [1], "edits.0.changes.price": 130 }] },
  { id: "draft-price-is-product-3", src: "log 10-08 03:42", area: "drafts", stage: "review", drafts: [BODYSUIT, PERFUME, EARRINGS], ctx: ["Seller: 150", "Bot: ✅ Price set to GH₵150 for product 1 — ready to submit."], msg: "No the 150 is product 3 price", ok: [{ type: "edit", "edits.0.seqs": [3], "edits.0.changes.price": 150 }] },
  { id: "draft-polish", src: "log 10-07 18:47", area: "drafts", stage: "review", drafts: [BODYSUIT], msg: "polish draft images", ok: [{ type: "polish" }] },
  { id: "draft-submit-last", src: "log 10-07 22:15", area: "drafts", stage: "review", drafts: [BODYSUIT], msg: "Give me the last product submit button", ok: [{ type: "submit" }] },
  { id: "draft-wont-go-ahead", src: "log 10-07 22:16", area: "drafts", stage: "review", drafts: [BODYSUIT], ctx: ["Seller: Give me the last product submit button", "Bot: Send your product to Jumia?"], msg: "I will not go ahead with this product again", ok: [reply, restart] },
  { id: "draft-v-wig-price", src: "variant", area: "drafts", stage: "review", drafts: [{ title: "Kinky Curly Wig - 24 Inch Length, Full Lace" }, PERFUME], msg: "make the wig 120", ok: [{ type: "edit", "edits.0.seqs": [1], "edits.0.changes.price": 120 }] },
  { id: "draft-v-qty-product-2", src: "variant", area: "drafts", stage: "review", drafts: [BODYSUIT, PERFUME], msg: "change qty of product 2 to 7", ok: [{ type: "edit", "edits.0.seqs": [2], "edits.0.changes.quantity": 7 }] },
  { id: "draft-v-restock-not-draft", src: "variant", area: "drafts", stage: "review", drafts: [TSHIRT_SET], msg: "restock the kettle to 30", ok: [stock("kettle", 30)], note: "A product that isn't one of the drafts is in the shop." },

  // ─── The owner's first session through the front door (web, 2026-10-08 17:00–17:52) ───
  { id: "live-approved-ones", src: "log 10-08 17:02", area: "live_changes", stage: "idle", listed: NEWEST_LISTED, ctx: [NEWEST_ASKED, NEWEST_SHOWN], msg: "change the stock of the approved ones to 10", ok: [{ type: "live_change", "change.stock": 10, others: "~Quilted" }, reply], note: "Changed only the 2 approved ones that were on; 'approved' is the quality check, on or off (the owner's next message)." },
  { id: "live-approved-on-or-off", src: "log 10-08 17:05", area: "live_changes", stage: "idle", listed: NEWEST_LISTED, ctx: [NEWEST_ASKED, NEWEST_SHOWN, "Seller: change the stock of the approved ones to 10", "Bot: Change these 2 products on Jumia? / • Crocheted Beanie Hat - Pearl Embellished, Crochet…: stock 1 → 10 / • Ventilated Safety Helmet - Blue, Adjustable Strap: stock 1 → 10 /  / One tap changes them all."], msg: "change the stock of the approved ones to 10 whether on or off", ok: [{ type: "live_change", "change.stock": 10, others: "~Wireless" }], note: "Offered the same 2 again." },
  { id: "live-on-all-off", src: "log 10-08 17:06", area: "live_changes", stage: "idle", ctx: ["Seller: change the stock of the approved ones to 10 whether on or off", "Bot: ✅ Sent to Jumia for 2 products (Crocheted Beanie Hat - Pearl Embellishe…, Ventilated Safety Helmet - Blue, Adjust…): stock to 10."], msg: "on all the products that are off", ok: [{ type: "bulk", scope: "inactive", "change.kind": "status", "change.active": true }], note: "Read as setting their stock to 10." },
  { id: "live-on-them-keep-stock", src: "log 10-08 17:07", area: "live_changes", stage: "idle", ctx: ["Seller: on all the products that are off", "Bot: What should their stock be? Send it with the rule, e.g. \"set all the kettles' stock to 10\"."], msg: "on them and keet their current stock", ok: [{ type: "bulk", scope: "inactive", "change.kind": "status", "change.active": true }], note: "The rule was in the message before: got \"Sorry, I didn't catch that\"." },
  { id: "help-rejected-edit-can-you", src: "log 10-08 17:15", area: "account_help", stage: "idle", ctx: ["Seller: can you tell what the rejection reasons are?", "Bot: ❌ Rejected by Jumia's quality check (11) / • Nourishing Cocoa Body Lotion… / Jumia didn't send the reasons through its API: check each one in Vendor Center to see why."], msg: "can you make changes to rejected products", ok: [reply, help], note: "Said a team would fix them: there is no such team. The reply must come from what PandaWorld can do." },
  { id: "live-describe-latest", src: "log 10-08 17:44", area: "live_changes", stage: "idle", listed: NEWEST_LISTED, ctx: [NEWEST_ASKED, NEWEST_SHOWN], msg: "Change the description of my latest uploaded product on vendor center", ok: [{ type: "content_change", product: "~beanie hat", "request.rewrite": ["description"] }], note: "Asked \"What should I change on it?\": the latest uploaded product was the first of the list, and changing a description with no new text is writing one." },
  { id: "live-write-its-description", src: "log 10-08 17:45", area: "live_changes", stage: "review", drafts: [BEANIE_DRAFT], listed: NEWEST_LISTED, ctx: [NEWEST_SHOWN, "Seller: Change the description of my latest uploaded product on vendor center", "Bot: What should I change on it? Write the new name, or say \"rewrite its description\", e.g. \"change the blender's name to Silver Crest 3 in 1 Blender 1.5L\"."], msg: "write it's description", ok: [{ type: "content_change", product: "~beanie hat", "request.rewrite": ["description"] }], note: "Said \"I can't write descriptions myself\": it can." },
  { id: "live-description-pasted", src: "log 10-08 17:51", area: "live_changes", stage: "review", drafts: [BEANIE_DRAFT], catalog: ["Crocheted Beanie Hat - Pearl Embellished, Crochet Knit (Summerhat-cream)"], ctx: ["Seller: i see / rewrite the description of this product / Crocheted Beanie Hat / i will give you what to write", "Bot: Okay, please provide the new description text for 'Crocheted Beanie Hat - Pearl Embellished, Crochet Knit'."], msg: PERFUME_TEXT, ok: [{ type: "content_change", product: "~beanie hat", "request.description": "~Introducing the captivating" }, reply], note: "Read as an edit to the draft and dropped. A question back is fair too: the text is about a perfume." },
  { id: "list-start-new-review", src: "log 10-08 17:29", area: "listing", stage: "review", drafts: [BEANIE_DRAFT], msg: "Start a new listing", ok: [restart] },

  // ── The owner's web and WhatsApp sessions, 2026-10-08 evening (front door on) ──
  { id: "shop-deleted-count", src: "log 10-08 19:13", area: "shop_info", stage: "review", drafts: [BEANIE_DRAFT], ctx: ["Seller: what shows", OVERVIEW_278], msg: "what is the number of deleted products", ok: [{ type: "shop" }], note: "Said PandaWorld can't know: the overview counts them." },
  { id: "shop-stock-all-on", src: "log 10-08 19:14", area: "shop_info", stage: "review", drafts: [BEANIE_DRAFT], ctx: ["Seller: what is the number of deleted products", "Bot: (Deleted on Jumia, not counted above: 139)"], msg: "what is the stock of all on products", ok: [{ type: "research", "needs.0.source": "products", "needs.0.filter": "active" }], note: "Gave 10 of 278: now 30 at a time, then \"more\"." },
  { id: "shop-stock-all-278", src: "log 10-08 19:19", area: "shop_info", stage: "review", drafts: [BEANIE_DRAFT], ctx: ["Seller: i asked \"what is the stock of all on products\" and the answer you gave was for just few since you reported 278 on products", OVERVIEW_278], msg: "give me the stock for all the 278 on products", ok: [{ type: "research", "needs.0.source": "products", "needs.0.filter": "active" }], note: "Answered \"I can list up to 30, would you like…\" instead of listing them." },
  { id: "chat-why-30", src: "log 10-08 19:20", area: "chat", stage: "review", drafts: [BEANIE_DRAFT], ctx: ["Seller: give me the stock for all the 278 on products", "Bot: That's 30 of 278. Say *more* for the next 30."], msg: "why 30? that is what the API recommend?", ok: [reply], note: "Made up \"optimal performance\": the reason is a message readable on a phone." },
  { id: "shop-print-description", src: "log 10-08 19:22", area: "shop_info", stage: "review", drafts: [BEANIE_DRAFT], catalog: [NECK_FAN], msg: "i have a portable neck fan in the shop print the description here for me so i can edit it", ok: [{ type: "product_text", product: "~neck fan" }], note: "Wrote a description itself and showed it as the product's." },
  { id: "shop-stock-this-product", src: "log 10-08 19:23", area: "shop_info", stage: "review", drafts: [BEANIE_DRAFT], catalog: [NECK_FAN], ctx: ["Seller: i have a portable neck fan in the shop print the description here for me so i can edit it", `Bot: *${NECK_FAN}* (SKU PA-NECKFAN) / *Description:* …`], msg: "what is the stock of this product", ok: [{ type: "stock", product: "~neck fan" }, info("neck fan")], note: "The product was dropped: it got the whole low-stock list." },
  { id: "live-stock-entire-shop-0", src: "log 10-08 19:24", area: "live_changes", stage: "review", drafts: [BEANIE_DRAFT], msg: "reduce all the stock of the entire shop to 0 you may do it in badges", ok: [{ type: "bulk", scope: "all", "change.kind": "stock", "change.stock": 0 }], note: "297 products: now in parts of 200, one tap each." },
  { id: "live-bulk-answer-0", src: "log 10-08 19:25", area: "live_changes", stage: "review", drafts: [BEANIE_DRAFT], ctx: ["Seller: reduce all the stock of the entire shop to 0 you may do it in badges", "Bot: That's 297 products: I change up to 200 with one tap.", "Seller: change the stock first 200 products to o and the rest after", "Bot: What should their stock be? Send it with the rule, e.g. \"set all the kettles' stock to 10\"."], msg: "0", ok: [{ type: "bulk", "change.kind": "stock", "change.stock": 0 }, reply], note: "Read by the listing step as draft 1's price: GH₵0." },
  { id: "list-from-this-chat", src: "log 10-08 21:13", area: "shop_info", stage: "idle", web: false, ctx: ["Seller: What is my last  pushed product", `Bot: *Last pushed product* / • ${BODYSUIT_NAME} (3 variations: L, M, S) · GHS 130 · waiting for Jumia's check`, "Seller: You could not read it from our chat? Like what you send from here?", "Bot: To give you the most accurate information I read that directly from Jumia."], msg: "I was asking for the ones you listed from here the WhatsApp chat", ok: [{ type: "research", "needs.0.source": "pandaworld_listings" }, { type: "listings" }] },
  { id: "live-rename-not-thong", src: "log 10-08 21:15", area: "live_changes", stage: "idle", web: false, catalog: [BODYSUIT_NAME], ctx: ["Seller: I was asking for the ones you listed from here the WhatsApp chat", `Bot: The '${BODYSUIT_NAME}' (S, M, L variations) was listed from our chat and is waiting for Jumia's quality check.`], msg: "Okay it is not a Thong so change that", ok: [{ type: "content_change", product: "~bodysuit", "request.rewrite": ["name"] }, reply], note: "Asked \"What should I change on it?\": the word is in its name." },
  { id: "live-rename-remove-word", src: "log 10-08 21:21", area: "live_changes", stage: "idle", web: false, catalog: [BODYSUIT_NAME], ctx: [`Bot: The '${BODYSUIT_NAME}' was listed from our chat.`, "Seller: Can you change the name of an already submitted product?", "Bot: Yes, I can change the name of a product that's already live on Jumia. What product's name would you like to change, and what should the new name be?"], msg: "Just redraft the name yourself for the last submitted product \nIt has the name thong in it just remove that word", ok: [{ type: "content_change", product: "~bodysuit", "request.rewrite": ["name"] }], note: "The AI's own name was refused, so it asked again: now PandaWorld writes it from Jumia's, with their words." },
  { id: "chat-hi-name", src: "log 10-08 20:02", area: "chat", stage: "review", drafts: [BEANIE_DRAFT], msg: "Hi, PandaworldAI", ok: [reply, help] },

  // ── What Jumia's API allows, and doesn't (lib/jumia/capabilities.ts; owner, 2026-10-09) ──
  { id: "cannot-delete", src: "variant", area: "live_changes", stage: "idle", catalog: [NECK_FAN], msg: "delete the neck fan from my shop completely", ok: [{ type: "reply", text: "~can't delete products" }], note: "Not in the API: the fixed answer, with turning it off as what can be done." },
  { id: "cannot-buyer-phone", src: "variant", area: "orders", stage: "idle", msg: "send me the phone number of the customer for order 394666919", ok: [{ type: "reply", text: "~doesn't share buyers" }] },
  { id: "cannot-holiday", src: "variant", area: "account_help", stage: "idle", msg: "can you put my shop on holiday mode for 2 weeks", ok: [{ type: "reply", text: "~holiday mode" }] },
  { id: "cannot-main-photo", src: "variant", area: "live_changes", stage: "idle", catalog: [NECK_FAN], msg: "change the main picture of the neck fan", ok: [{ type: "reply", text: "~main photo" }] },
  { id: "live-details-colour", src: "variant", area: "live_changes", stage: "idle", catalog: [NECK_FAN], msg: "the neck fan's colour on jumia should be white not black", ok: [{ type: "content_change", product: "~neck fan", "request.details": "~white" }] },
  { id: "live-details-material", src: "variant", area: "live_changes", stage: "idle", catalog: [NECK_FAN], msg: "set the material of the neck fan to plastic", ok: [{ type: "content_change", product: "~neck fan", "request.details": "~plastic" }] },
  { id: "live-details-size", src: "variant", area: "live_changes", stage: "idle", msg: "rename size M of the satin gown to XL", ok: [{ type: "content_change", product: "~gown", "request.size": "~XL" }] },
  { id: "live-details-barcode", src: "variant", area: "live_changes", stage: "idle", catalog: ["Nasco Electric Kettle 1.7L - Stainless Steel"], msg: "the electric kettle's barcode is 6001234567890", ok: [{ type: "content_change", product: "~kettle", "request.barcode": "6001234567890" }] },
];
