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
jest.mock("@/lib/whatsapp/intake", () => ({
  handleLinkedMessage: async (...a: unknown[]) => { handled.push(a); },
}));
jest.mock("@/lib/actions/upload", () => ({ validateImageBuffer: async () => ({ mime: "image/jpeg", ext: "jpg" }) }));
let pilot = true;
jest.mock("@/lib/whatsapp/assistant", () => ({ assistantEnabled: async () => pilot }));

import { sendButtonsIfConfigured, sendCtaUrlIfConfigured, sendTextIfConfigured, sendTemplateIfConfigured } from "@/lib/whatsapp/client";
import { ingestWhatsAppImage } from "@/lib/whatsapp/media";
import { isWebAddress, webAddress, chatChannelOf } from "@/lib/whatsapp/channel";
import { assistantMessages, receiveAssistantMessage } from "@/lib/whatsapp/listing-assistant";
import { handleOrderMessage } from "@/lib/whatsapp/orders";

const USER = "user_web1";
const ADDRESS = `web:${USER}`;
const log = () => (db.tables.whatsapp_message_log ?? []) as Record<string, unknown>[];

beforeEach(() => {
  db.tables.whatsapp_message_log = [];
  handled.length = 0;
  pilot = true;
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

describe("orders and labels", () => {
  it("stay on WhatsApp: the web chat says so and reads nothing from Jumia", async () => {
    expect(await handleOrderMessage(USER, ADDRESS, "orders")).toBe(true);
    expect(log()[0].body_text).toContain("orders, packing and shipping labels are on WhatsApp");
    expect(await handleOrderMessage(USER, ADDRESS, "list 3 products")).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
