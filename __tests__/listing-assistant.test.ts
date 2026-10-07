/**
 * The Listing Assistant (owner, 2026-10-07): the WhatsApp bot on the
 * dashboard, under the seller's web address (lib/whatsapp/channel.ts).
 * Its messages are recorded, never sent to Meta; its photos are uploads
 * already stored; orders and labels stay on WhatsApp.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
(db as unknown as { storage: unknown }).storage = {
  from: () => ({
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/product-images/${path}` } }),
    upload: async () => ({ error: null }),
  }),
};
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));

const handled: unknown[][] = [];
/** What the bot does with a message, for the tests that need it to do something. */
let mockBot: () => Promise<void> = async () => {};
jest.mock("@/lib/whatsapp/intake", () => ({
  handleLinkedMessage: async (...a: unknown[]) => { handled.push(a); await mockBot(); },
}));
jest.mock("@/lib/actions/upload", () => ({ validateImageBuffer: async () => ({ mime: "image/jpeg", ext: "jpg" }) }));
let jumiaKind = "connected";
jest.mock("@/lib/jumia/credentials", () => ({ getJumiaConnectionKind: async () => jumiaKind }));
jest.mock("@/lib/jumia/connect-token", () => ({ createConnectToken: async () => "tok" }));
let pilot = true;
jest.mock("@/lib/whatsapp/assistant", () => ({ assistantEnabled: async () => pilot }));

import { sendButtonsIfConfigured, sendCtaUrlIfConfigured, sendTextIfConfigured, sendTemplateIfConfigured } from "@/lib/whatsapp/client";
import { ingestWhatsAppImage } from "@/lib/whatsapp/media";
import { isWebAddress, webAddress, chatChannelOf } from "@/lib/whatsapp/channel";
import { assistantMessages, creditLock, jumiaGate, receiveAssistantMessage } from "@/lib/whatsapp/listing-assistant";
import { _resetBillingModeCache } from "@/lib/billing/mode";
import { handleOrderMessage } from "@/lib/whatsapp/orders";

const USER = "user_web1";
const ADDRESS = `web:${USER}`;
const log = () => (db.tables.whatsapp_message_log ?? []) as Record<string, unknown>[];

beforeEach(() => {
  db.tables.whatsapp_message_log = [];
  db.tables.whatsapp_sessions = [];
  db.tables.listings = [];
  mockBot = async () => {};
  handled.length = 0;
  pilot = true;
  jumiaKind = "connected";
  delete process.env.WHATSAPP_ACCESS_TOKEN;
  delete process.env.WHATSAPP_PHONE_NUMBER_ID;
  global.fetch = jest.fn(async () => { throw new Error("nothing should reach Meta"); }) as unknown as typeof fetch;
});

describe("the web address", () => {
  it("is the seller's own, and marks the listings made there", () => {
    expect(webAddress(USER)).toBe(ADDRESS);
    expect(isWebAddress(ADDRESS)).toBe(true);
    expect(isWebAddress("233550607231")).toBe(false);
    expect(chatChannelOf(ADDRESS)).toBe("web");
    expect(chatChannelOf("233550607231")).toBeNull();
  });
});

describe("the bot's messages to it", () => {
  it("are recorded with their buttons and links, with no WhatsApp account and nothing sent to Meta", async () => {
    await sendTextIfConfigured(ADDRESS, "Got it — 2 products.");
    await sendButtonsIfConfigured(ADDRESS, "Send all 2 to Jumia?", [{ id: "submit all", title: "Submit all ✅" }]);
    await sendCtaUrlIfConfigured(ADDRESS, "Here's your batch:", "Review listings", "https://pandaworld.test/r");
    await sendTemplateIfConfigured(ADDRESS, "jumia_new_order", "en", ["x"]);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(log().map((r) => [r.phone_number, r.direction, r.message_type, r.body_text])).toEqual([
      [ADDRESS, "outbound", "text", "Got it — 2 products."],
      [ADDRESS, "outbound", "button", "Send all 2 to Jumia?"],
      [ADDRESS, "outbound", "cta_url", "Here's your batch:"],
    ]);
    expect(log()[1].payload).toEqual({ buttons: [{ id: "submit all", title: "Submit all ✅" }] });
    expect(log()[2].payload).toEqual({ buttonText: "Review listings", url: "https://pandaworld.test/r" });
  });

  it("a WhatsApp number still needs WhatsApp set up", async () => {
    await sendTextIfConfigured("233550607231", "hello");
    expect(log()).toHaveLength(0);
  });
});

describe("its photos", () => {
  it("are the seller's own uploads, already stored", async () => {
    expect(await ingestWhatsAppImage(`web:${USER}/assistant/1.jpg`, USER)).toBe(`https://cdn.test/product-images/${USER}/assistant/1.jpg`);
    expect(await ingestWhatsAppImage("web:someone_else/assistant/1.jpg", USER)).toBeNull();
    expect(await ingestWhatsAppImage(`web:${USER}/../x.jpg`, USER)).toBeNull();
  });
});

describe("a message from the page", () => {
  it("is recorded, then handled by the bot under the web address", async () => {
    expect(await receiveAssistantMessage(USER, { id: "web-abc12345", text: "I want to list 2 products" })).toEqual({ ok: true });
    expect(log()[0]).toMatchObject({ phone_number: ADDRESS, direction: "inbound", message_type: "text", body_text: "I want to list 2 products", wamid: "web-abc12345" });
    expect(handled).toEqual([[USER, ADDRESS, "web-abc12345", { text: "I want to list 2 products" }]]);
  });

  it("a photo carries its link for the page, and its media id for the bot", async () => {
    await receiveAssistantMessage(USER, { id: "web-photo0001", mediaId: `web:${USER}/assistant/1.jpg`, text: "price 120" });
    expect(log()[0]).toMatchObject({ message_type: "image", body_text: "price 120" });
    expect(log()[0].payload).toEqual({ imageMediaId: `web:${USER}/assistant/1.jpg`, link: `https://cdn.test/product-images/${USER}/assistant/1.jpg` });
    expect(handled[0]).toEqual([USER, ADDRESS, "web-photo0001", { text: "price 120", imageMediaId: `web:${USER}/assistant/1.jpg` }]);
  });

  it("a tap keeps the button's words to show", async () => {
    await receiveAssistantMessage(USER, { id: "web-tap00001", text: "submit all", label: "Submit all ✅" });
    expect(log()[0]).toMatchObject({ message_type: "interactive", body_text: "submit all", payload: { label: "Submit all ✅" } });
  });

  it("someone else's photo, or nothing at all, isn't taken", async () => {
    expect(await receiveAssistantMessage(USER, { id: "web-x0000001", mediaId: "web:other/assistant/1.jpg" })).toMatchObject({ ok: false });
    expect(await receiveAssistantMessage(USER, { id: "web-x0000002", text: "   " })).toMatchObject({ ok: false });
    expect(handled).toHaveLength(0);
  });
});

describe("the conversation the page reads", () => {
  it("is this seller's, oldest first, with the page's own ids", async () => {
    db.tables.whatsapp_message_log = [
      { id: "2", phone_number: ADDRESS, direction: "outbound", message_type: "text", body_text: "How many?", payload: null, created_at: "2026-10-07T10:00:02Z", wamid: null },
      { id: "1", phone_number: ADDRESS, direction: "inbound", message_type: "text", body_text: "hi", payload: null, created_at: "2026-10-07T10:00:01Z", wamid: "web-hi000001" },
      { id: "3", phone_number: "web:other", direction: "inbound", message_type: "text", body_text: "not mine", payload: null, created_at: "2026-10-07T10:00:03Z", wamid: null },
    ];
    const all = await assistantMessages(USER);
    expect(all.map((m) => [m.id, m.direction, m.text, m.clientId])).toEqual([
      ["1", "inbound", "hi", "web-hi000001"],
      ["2", "outbound", "How many?", null],
    ]);
    expect((await assistantMessages(USER, { after: "2026-10-07T10:00:01Z" })).map((m) => m.id)).toEqual(["2"]);
  });
});

describe("at 0 credits (owner, 2026-10-07: \"tell the user they need to top up and lock after that\")", () => {
  const billing = (balance: number) => {
    db.tables.app_settings = [{ key: "billing_enabled", value: true }];
    db.tables.extension_credits = [{ user_id: USER, balance }];
    db.tables.credit_notices = [];
    _resetBillingModeCache();
  };
  afterEach(() => { db.tables.app_settings = []; _resetBillingModeCache(); });

  it("the page is told it's locked, and the bot's one 'top up' reply is in the conversation, once", async () => {
    billing(0);
    expect(await creditLock(USER)).toBe(true);
    expect(await creditLock(USER)).toBe(true);
    const said = (await assistantMessages(USER)).filter((m) => m.direction === "outbound");
    expect(said).toHaveLength(1);
    expect(said[0].text).toContain("🔒 You've used all your PandaWorld credits, so this chat is locked until you top up.");
    expect(said[0].payload).toMatchObject({ buttonText: "Buy credits" });
  });

  it("unlocks as soon as the balance is above 0 (a purchase or a refund)", async () => {
    billing(0);
    await creditLock(USER);
    billing(0.5);
    expect(await creditLock(USER)).toBe(false);
  });

  it("not locked with credits, or while billing is off", async () => {
    billing(3);
    expect(await creditLock(USER)).toBe(false);
    db.tables.app_settings = [];
    db.tables.extension_credits = [{ user_id: USER, balance: 0 }];
    _resetBillingModeCache();
    expect(await creditLock(USER)).toBe(false);
  });
});

describe("Jumia first (owner, 2026-10-07: \"after it is connected before conversations can be unlocked\")", () => {
  const state = () => (db.tables.whatsapp_sessions.find((r) => r.phone_number === ADDRESS) as Record<string, unknown> | undefined)?.state;

  it("not connected: the connect steps go in the conversation once, and the chat waits for the Client ID and token", async () => {
    jumiaKind = "needs_credentials";
    expect(await jumiaGate(USER)).toBe(true);
    expect(await jumiaGate(USER)).toBe(true);
    const said = log().filter((r) => r.direction === "outbound");
    expect(said).toHaveLength(1);
    expect(String(said[0].body_text)).toContain("First, connect your Jumia account");
    expect(state()).toBe("awaiting_jumia_credentials");
  });

  it("a message before connecting goes to the connect flow", async () => {
    jumiaKind = "needs_credentials";
    await receiveAssistantMessage(USER, { id: "msg-00000001", text: "hello" });
    expect(state()).toBe("awaiting_jumia_credentials");
    expect(handled).toHaveLength(1); // the bot's connect state answers it
  });

  it("connected from Settings meanwhile: the chat moves on by itself", async () => {
    jumiaKind = "needs_credentials";
    await jumiaGate(USER);
    jumiaKind = "connected";
    expect(await jumiaGate(USER)).toBe(false);
    expect(state()).toBe("awaiting_count");
    expect(String(log().filter((r) => r.direction === "outbound").pop()?.body_text)).toContain("🎉 Jumia connected!");
  });

  it("connected: nothing in the way", async () => {
    expect(await jumiaGate(USER)).toBe(false);
    expect(log()).toHaveLength(0);
  });
});

describe("orders", () => {
  // Packing, ready to ship and cancel work here; labels and alerts stay on
  // WhatsApp (owner, 2026-10-07). The flow itself: whatsapp-orders.test.ts.
  it("a message that isn't an order command is left to the bot", async () => {
    expect(await handleOrderMessage(USER, ADDRESS, "list 3 products")).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("while a product's photos come in", () => {
  // The bot says nothing to a photo on WhatsApp (each reply is a paid
  // message); here, silence after an upload read as "it didn't work"
  // (owner, 2026-10-07). Timestamps a moment apart, as the database's are.
  const later = () => new Promise((r) => setTimeout(r, 5));
  const collecting = (seq: number, size: number) => {
    db.tables.whatsapp_sessions = [{ phone_number: ADDRESS, user_id: USER, state: "awaiting_photos", batch_id: "b1", batch_seq: seq, batch_size: size }];
  };
  const product = (seq: number, photos: number, notes: string | null) => ({
    id: `l${seq}`, user_id: USER, whatsapp_batch_id: "b1", whatsapp_seq: seq, images: Array.from({ length: photos }, (_, i) => `u${i}`), user_prompt: notes,
  });
  const photo = `web:${USER}/assistant/1.jpg`;
  const replies = () => log().filter((r) => r.direction === "outbound");

  it("the last photo of an upload gets the product's count and a Done button", async () => {
    collecting(1, 1);
    mockBot = async () => { await later(); db.tables.listings = [product(1, 1, "Variation is 100ml and the price is GHS 140")]; };
    await receiveAssistantMessage(USER, { id: "web-photo0002", mediaId: photo, text: "Variation is 100ml and the price is GHS 140", last: true });
    expect(replies().map((r) => r.body_text)).toEqual(["📷 Your product: 1 photo, notes saved. Upload more photos, or tap *Done* when it's complete."]);
    expect(replies()[0].payload).toEqual({ buttons: [{ id: "done", title: "Done ✅" }] });
  });

  it("asks for the price when the photos came without notes, and names the product in a batch", async () => {
    collecting(2, 3);
    mockBot = async () => { db.tables.listings = [product(2, 3, null)]; };
    await receiveAssistantMessage(USER, { id: "web-photo0003", mediaId: photo, last: true });
    expect(replies().map((r) => r.body_text)).toEqual(["📷 Product 2 of 3: 3 photos. Type its price and any notes, or tap *Done* when it's complete."]);
  });

  it("the photos before an upload's last get nothing", async () => {
    collecting(1, 1);
    mockBot = async () => { db.tables.listings = [product(1, 1, null)]; };
    await receiveAssistantMessage(USER, { id: "web-photo0004", mediaId: photo, last: false });
    expect(replies()).toHaveLength(0);
  });

  it("a product closed in silence (the quiet way) is confirmed, with the next one named", async () => {
    collecting(1, 3);
    db.tables.listings = [product(1, 2, "price 50")];
    mockBot = async () => { db.tables.whatsapp_sessions[0].batch_seq = 2; };
    await receiveAssistantMessage(USER, { id: "web-text0001", text: "1" });
    expect(replies().map((r) => r.body_text)).toEqual([
      "✅ Product 1 saved (2 photos, notes saved). Next: product 2 of 3. Upload its photos with the price and notes.",
    ]);
  });

  it("says nothing more when the bot answered itself", async () => {
    collecting(1, 1);
    db.tables.whatsapp_message_log.push({ id: "old", phone_number: ADDRESS, direction: "outbound", message_type: "text", body_text: "Let's go", created_at: "2026-10-07T08:00:00Z" });
    mockBot = async () => {
      await later();
      db.tables.listings = [product(1, 1, null)];
      await sendTextIfConfigured(ADDRESS, "⚠️ That photo didn't come through cleanly");
    };
    await receiveAssistantMessage(USER, { id: "web-photo0005", mediaId: photo, last: true });
    expect(replies().map((r) => r.body_text)).toEqual(["Let's go", "⚠️ That photo didn't come through cleanly"]);
  });

  it("outside a batch's photos, adds nothing", async () => {
    db.tables.whatsapp_sessions = [{ phone_number: ADDRESS, user_id: USER, state: "awaiting_confirmation", batch_id: "b1", batch_seq: 1, batch_size: 1 }];
    await receiveAssistantMessage(USER, { id: "web-photo0006", mediaId: photo, last: true });
    expect(replies()).toHaveLength(0);
  });
});
