/**
 * Everything a seller can ask of their Jumia shop through PandaWorld, in one
 * list (owner, 2026-10-09: "the system understands what is capable and doable
 * and what is not and reports on it accordingly to the seller"). Each entry
 * is one thing a seller wants, the Jumia Vendor API requests behind it
 * (vendorcenter.jumia.com/api-docs/openapi.yaml), and where it stands:
 *
 *   - "chat": the assistant does it, on the website and WhatsApp.
 *   - "whatsapp": on WhatsApp only (a file or an alert the website can't take).
 *   - "vendor_center": Jumia's API doesn't allow it; the seller does it in
 *     Vendor Center. The assistant says so with `answer`, never pretends.
 *   - "impossible": nobody can, through the API or Vendor Center.
 *   - "not_built": the API allows it and we haven't built it (with why).
 *
 * The same list drives: the assistant's "cannot" action (a fixed, true answer
 * for what isn't possible; lib/whatsapp/assistant.ts), the daily checks of
 * every read request against the owner's shop (lib/jumia/api-checks.ts), and
 * the admin page /admin/jumia-api.
 */

export type CapabilityArea = "connect" | "listing" | "products" | "live" | "orders" | "money" | "warehouse";
export type CapabilityStatus = "chat" | "whatsapp" | "vendor_center" | "impossible" | "not_built";

/** A read request the daily check runs against the owner's shop (lib/jumia/api-checks.ts). */
export type CheckId =
  | "shops" | "linked_shops" | "brands" | "categories" | "attribute_set" | "products" | "product_set" | "stock"
  | "feed" | "orders" | "order_items" | "shipment_providers" | "payouts";

export interface Capability {
  id:        string;
  area:      CapabilityArea;
  /** What the seller wants, in their words. */
  what:      string;
  /** Jumia's requests behind it ("POST /feeds/products/stock"); none for what isn't possible. */
  requests:  string[];
  status:    CapabilityStatus;
  /** What it needs: a pack, Jumia's quality check, a role on their Jumia app, a confirm tap, credits. */
  needs?:    string[];
  /** The assistant action that does it. */
  action?:   string;
  /** For vendor_center / impossible / not_built: what the assistant tells the seller, whole. */
  answer?:   string;
  /** A link key the answer goes with (lib/whatsapp/assistant.ts assistantLinks). */
  link?:     "vendor_center";
  /** The daily read checks that prove its requests still work. */
  checks?:   CheckId[];
}

const CONFIRM = "a confirm tap before anything changes on Jumia";
const APPROVED = "Jumia's quality check approved it at least once";
const ORDER_MANAGER = "the VC - Order Manager role on their Jumia app";

export const CAPABILITIES: Capability[] = [
  // ── Connecting ──
  { id: "connect", area: "connect", what: "Connect a Jumia shop (Self Authorization) and keep it connected", requests: ["POST /token"], status: "chat", checks: ["shops"] },
  { id: "shop_name", area: "connect", what: "Their shop's name and the countries it sells in", requests: ["GET /shops"], status: "chat", checks: ["shops"] },
  { id: "linked_shops", area: "connect", what: "The shops under their Jumia account", requests: ["GET /shops-of-master-shop"], status: "chat", action: "shops", checks: ["linked_shops"] },

  // ── Listing new products ──
  { id: "list", area: "listing", what: "List new products from photos (AI drafts name, description, category, details)", requests: ["GET /catalog/brands", "GET /catalog/categories", "GET /catalog/attribute-sets/{id}", "POST /feeds/products/create", "GET /feeds/{id}"], status: "chat", needs: ["credits when it goes live"], action: "list", checks: ["brands", "categories", "attribute_set", "feed"] },
  { id: "brand_check", area: "listing", what: "Whether a brand is on Jumia and allowed in a category", requests: ["GET /catalog/brands"], status: "chat", action: "brand_check", checks: ["brands"] },
  { id: "category_info", area: "listing", what: "What a kind of product needs on Jumia (category, details, variation options)", requests: ["GET /catalog/categories", "GET /catalog/attribute-sets/{id}"], status: "chat", action: "category_info", checks: ["categories", "attribute_set"] },
  { id: "submission_result", area: "listing", what: "Whether each submitted product was accepted, and Jumia's quality check", requests: ["GET /feeds/{id}", "GET /catalog/products"], status: "chat", checks: ["feed", "products"] },
  { id: "translations", area: "listing", what: "Names and descriptions in French or Arabic (Ivory Coast, Senegal, Morocco, Egypt)", requests: ["POST /feeds/products/create"], status: "not_built", answer: "Listings go to Jumia in English for now. French and Arabic names are coming when we have sellers in those countries." },

  // ── Reading their products ──
  { id: "overview", area: "products", what: "How many products are on, off, out of stock, waiting, rejected or deleted", requests: ["GET /catalog/products", "GET /catalog/stock"], status: "chat", action: "shop", checks: ["products", "stock"] },
  { id: "product_info", area: "products", what: "Where one product is: on or off, shown to buyers, quality check, price, sale, stock", requests: ["GET /catalog/products", "GET /catalog/stock"], status: "chat", action: "product_info", checks: ["products", "stock"] },
  { id: "product_text", area: "products", what: "A product's name, description and highlights as Jumia has them", requests: ["GET /catalog/products"], status: "chat", action: "product_text", checks: ["product_set"] },
  { id: "stock", area: "products", what: "Stock of a product, and what's out of stock or low; what orders not shipped yet hold", requests: ["GET /catalog/stock", "GET /orders", "GET /orders/items"], status: "chat", action: "stock", checks: ["stock", "orders", "order_items"] },
  { id: "rejected", area: "products", what: "Products rejected by Jumia's quality check, with Jumia's reason and comment when it gives them", requests: ["GET /catalog/products"], status: "chat", action: "shop", checks: ["products"] },
  { id: "fix_rejected", area: "products", what: "Fix a product Jumia's quality check rejected: PandaWorld's own listings redrafted and sent again; others' name, description, brand or details changed for Jumia to check again", requests: ["GET /catalog/products", "GET /catalog/attribute-sets/{id}", "POST /feeds/products/update", "POST /feeds/products/create"], status: "chat", needs: ["Standard pack", CONFIRM, "credits"], action: "fix_rejected", checks: ["products", "product_set"] },
  { id: "product_lists", area: "products", what: "Lists of products: newest or oldest, by price or stock, on sale, matching words, 30 at a time", requests: ["GET /catalog/products", "GET /catalog/stock"], status: "chat", action: "research", checks: ["products", "stock"] },

  // ── Changing live products ──
  { id: "live_stock", area: "live", what: "Change a product's stock", requests: ["POST /feeds/products/stock"], status: "chat", needs: ["Standard pack", APPROVED, CONFIRM, "credits"], action: "live_change" },
  { id: "live_price", area: "live", what: "Change a product's price, or put it on sale with dates, or end a sale", requests: ["POST /feeds/products/price"], status: "chat", needs: ["Standard pack", APPROVED, CONFIRM, "credits"], action: "live_change" },
  { id: "live_status", area: "live", what: "Turn a product on or off", requests: ["POST /feeds/products/status"], status: "chat", needs: ["Standard pack", APPROVED, CONFIRM, "credits"], action: "live_change" },
  { id: "live_bulk", area: "live", what: "One change to many products by a rule (all, out of stock, off, matching words), 200 per tap", requests: ["POST /feeds/products/stock", "POST /feeds/products/price", "POST /feeds/products/status"], status: "chat", needs: ["Standard pack", CONFIRM, "credits per tap"], action: "bulk" },
  { id: "live_content", area: "live", what: "Change a product's name, description, highlights or brand, their text or written by AI", requests: ["GET /catalog/products", "POST /feeds/products/update"], status: "chat", needs: ["Standard pack", CONFIRM, "credits"], action: "content_change", checks: ["product_set"] },
  { id: "live_details", area: "live", what: "Change a product's details (colour, material, weight, model…), its barcode or a size's name", requests: ["GET /catalog/products", "GET /catalog/attribute-sets/{id}", "POST /feeds/products/update"], status: "chat", needs: ["Standard pack", CONFIRM, "credits"], action: "content_change", checks: ["product_set", "attribute_set"] },
  { id: "delete_product", area: "live", what: "Delete a product", requests: [], status: "vendor_center", link: "vendor_center", answer: "Jumia's API can't delete products, so I can't do it from here. I can turn it off so buyers don't see it; to delete it for good, use Vendor Center." },
  { id: "extra_photos", area: "live", what: "Add more photos to a live product, after its main one", requests: ["GET /catalog/products", "POST /feeds/products/update"], status: "chat", needs: ["Standard pack", CONFIRM, "credits", "at most 8 photos in all"], action: "add_photos", checks: ["product_set"] },
  { id: "main_photo", area: "live", what: "Change, swap or remove a live product's main photo or photos it has", requests: [], status: "vendor_center", link: "vendor_center", answer: "Jumia doesn't let its API change a live product's main photo or remove its photos, so that's done in Vendor Center. I can add more photos after its main one here: say \"add photos to\" and the product." },
  { id: "main_category", area: "live", what: "Move a live product to another category", requests: [], status: "vendor_center", link: "vendor_center", answer: "Jumia doesn't let its API move a live product to another category. Change it in Vendor Center, or list it again here in the right category." },
  { id: "parent_sku", area: "live", what: "Change a product's parent SKU or how its sizes are grouped", requests: [], status: "vendor_center", link: "vendor_center", answer: "Jumia doesn't let its API change a product's parent SKU or how its variations are grouped. That's done in Vendor Center." },
  { id: "before_qc", area: "live", what: "Change stock, price or on/off before Jumia's quality check approves the product", requests: [], status: "impossible", answer: "Jumia only takes stock, price and on/off changes for a product its quality check has approved at least once. I'll tell you when it's approved; then I can change it." },
  { id: "locked_details", area: "live", what: "Change a product's colour (or another detail Jumia locks) after its quality check approved it", requests: [], status: "impossible", answer: "Jumia doesn't let some details, like colour, change once its quality check has approved the product. To sell another colour, list it as a new product, or ask Jumia's seller support to correct this one." },
  { id: "add_size", area: "live", what: "Add a new size or colour to a product that's already live, with its stock and price", requests: ["GET /catalog/products", "GET /catalog/attribute-sets/{id}", "POST /feeds/products/create"], status: "chat", needs: ["Standard pack", CONFIRM, "credits", "Jumia's quality check looks at it like a new product"], action: "add_size", checks: ["product_set", "attribute_set"] },

  // ── Orders ──
  { id: "orders_to_pack", area: "orders", what: "Orders waiting to be packed", requests: ["GET /orders", "GET /orders/items"], status: "chat", action: "orders", checks: ["orders", "order_items"] },
  { id: "order_status", area: "orders", what: "Where an order is, by its number, with tracking", requests: ["GET /orders", "GET /orders/items"], status: "chat", action: "order_status", checks: ["orders", "order_items"] },
  { id: "sales", area: "orders", what: "Orders and sales for a period, by status (cancelled, delivered, returned…)", requests: ["GET /orders"], status: "chat", action: "sales", checks: ["orders"] },
  { id: "reports", area: "orders", what: "Best sellers, slow movers, what runs out soon, returns", requests: ["GET /orders", "GET /orders/items"], status: "chat", action: "report", checks: ["orders", "order_items"] },
  { id: "pack", area: "orders", what: "Pack an order and mark it ready to ship", requests: ["GET /orders/shipment-providers", "POST /orders/pack", "POST /v2/orders/pack", "POST /orders/ready-to-ship"], status: "chat", needs: [ORDER_MANAGER, CONFIRM], checks: ["shipment_providers"] },
  { id: "cancel_order", area: "orders", what: "Cancel an order's items", requests: ["PUT /orders/cancel"], status: "chat", needs: [ORDER_MANAGER, CONFIRM] },
  { id: "labels", area: "orders", what: "Shipping label PDFs", requests: ["POST /orders/print-labels"], status: "whatsapp", needs: [ORDER_MANAGER, "Standard pack", "credits"] },
  { id: "order_alerts", area: "orders", what: "A message for every new order, and when one is delivered, returned or fails", requests: ["GET /orders"], status: "whatsapp", needs: ["Pro pack"], checks: ["orders"] },
  { id: "buyer_contact", area: "orders", what: "A buyer's phone number or email, or messaging a buyer", requests: [], status: "impossible", answer: "Jumia doesn't share buyers' phone numbers or emails, and there's no way to message a buyer through it. I can show the buyer's name, city and address on an order; Jumia's delivery team contacts them." },
  { id: "mark_delivered", area: "orders", what: "Mark an order shipped or delivered", requests: [], status: "impossible", answer: "Jumia's couriers mark orders shipped and delivered; sellers can't. I can pack an order and mark it ready to ship, and tell you where it is." },
  { id: "returns", area: "orders", what: "Accept or refuse a return, or get a return's pickup code", requests: [], status: "vendor_center", link: "vendor_center", answer: "Returns aren't in Jumia's API: accepting, refusing and pickup codes are in Vendor Center. I can show you which orders were returned." },
  { id: "fbj_labels", area: "orders", what: "Labels or packing for orders Fulfilled by Jumia", requests: [], status: "impossible", answer: "Jumia packs and ships orders it fulfils from its warehouse itself, so there's no label or packing for you to do on those." },

  // ── Money ──
  { id: "payouts", area: "money", what: "What Jumia paid and still owes, every statement of 90 days, one statement in detail", requests: ["GET /payout-statement"], status: "chat", action: "payouts", checks: ["payouts"] },
  { id: "fees", area: "money", what: "What Jumia takes when a product sells (from Jumia's published commission rates)", requests: ["GET /catalog/products"], status: "chat", action: "fees" },
  { id: "bank_account", area: "money", what: "Change their bank details or payout schedule", requests: [], status: "vendor_center", link: "vendor_center", answer: "Bank details and payouts settings aren't in Jumia's API; they're in Vendor Center (or with your Jumia account manager)." },

  // ── Jumia's warehouse ──
  { id: "warehouse_stock", area: "warehouse", what: "What Jumia's warehouse holds of a product", requests: ["GET /consignment-stock"], status: "chat", action: "warehouse_stock" },
  { id: "warehouse_order", area: "warehouse", what: "Send stock into Jumia's warehouse, and say it has shipped", requests: ["POST /consignment-order", "PATCH /consignment-order/{purchaseOrderNumber}"], status: "chat", needs: [CONFIRM], action: "warehouse_order" },

  // ── The shop itself ──
  { id: "holiday_mode", area: "connect", what: "Holiday mode, or the shop's settings and profile", requests: [], status: "vendor_center", link: "vendor_center", answer: "Holiday mode and shop settings aren't in Jumia's API, so I can't change them. They're in Vendor Center. I can turn products off for you if that helps." },
  { id: "seller_score", area: "connect", what: "Their seller score, ratings and reviews, product views or visits", requests: [], status: "vendor_center", link: "vendor_center", answer: "Jumia doesn't give seller scores, reviews or product views through its API; see them in Vendor Center. From what it does give, I can run a shop health report or show best sellers and slow movers." },
  { id: "campaigns", area: "connect", what: "Join a campaign or flash sale, vouchers, or sponsored ads", requests: [], status: "vendor_center", link: "vendor_center", answer: "Campaigns, flash sales, vouchers and ads aren't in Jumia's API; join them in Vendor Center. I can put products on sale with dates here." },
];

const byId = new Map(CAPABILITIES.map((c) => [c.id, c]));

export const capability = (id: string): Capability | undefined => byId.get(id);

/** What isn't possible from the chat: its id and what the seller asks, for the AI to name one. */
export function cannotList(): string {
  return CAPABILITIES.filter((c) => c.status !== "chat" && c.status !== "whatsapp" && c.answer)
    .map((c) => `- ${c.id}: ${c.what}`).join("\n");
}

/** The fixed answer for something not possible from the chat, or null when the id isn't one. */
export function cannotAnswer(id: string): { text: string; link: Capability["link"] | null } | null {
  const c = byId.get(id);
  if (!c || !c.answer || c.status === "chat" || c.status === "whatsapp") return null;
  return { text: c.answer, link: c.link ?? null };
}
