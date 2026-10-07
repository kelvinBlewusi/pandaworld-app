/**
 * What the assistant remembers about a seller across their journey (owner,
 * 2026-10-07: "about our entire journey"): lib/whatsapp/seller-memory.ts.
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
const prompts: string[] = [];
let reply = "- Sells crochet hats\n- Sends one product at a time";
jest.mock("@/lib/ai/gemini-client", () => ({
  callGeminiBackend: async (model: string, parts: { text?: string }[]) => {
    prompts.push(parts.map((p) => p.text ?? "").join("\n"));
    return { text: reply, model, backend: "vertex" };
  },
}));

import { MEMORY_EVERY, blankCodes, memoryPrompt, noteSellerMessage, sellerMemory } from "@/lib/whatsapp/seller-memory";

beforeEach(() => {
  db = new FakeDb();
  db.tables.seller_memory = [];
  db.tables.whatsapp_connections = [{ user_id: "seller", phone_number: "+233206987692" }];
  db.tables.whatsapp_message_log = [
    { phone_number: "233206987692", direction: "inbound", message_type: "text", body_text: "Crochet beanie hat, price 100", created_at: "2026-10-07T16:30:00Z" },
    { phone_number: "web:seller", direction: "inbound", message_type: "text", body_text: "BYQZm9Gdk16GiIuXW1K_SiwboupmDjsMj3vhSDzbous", created_at: "2026-10-07T16:31:00Z" },
    { phone_number: "233999999999", direction: "inbound", message_type: "text", body_text: "someone else's message", created_at: "2026-10-07T16:32:00Z" },
  ];
  prompts.length = 0;
  reply = "- Sells crochet hats\n- Sends one product at a time";
});

describe("blanking codes", () => {
  it("hides Client IDs, tokens, keys and link codes, and keeps words, prices and links' text", () => {
    expect(blankCodes("c9758cb3-8a9b-49b2-9ae5-6973aa3015cd")).toBe("[a code]");
    expect(blankCodes("token BYQZm9Gdk16GiIuXW1K_SiwboupmDjsMj3vhSDzbous now")).toBe("token [a code] now");
    expect(blankCodes("my key pw_live_abc123")).toBe("my key [a code]");
    expect(blankCodes("send LINK-A1B2C3D4")).toBe("send [a code]");
    expect(blankCodes("Crocheted Beanie Hat - Pearl Embellished, price 150gh")).toBe("Crocheted Beanie Hat - Pearl Embellished, price 150gh");
  });
});

describe("the running summary", () => {
  it("is made after the first few messages, from all their chats, codes blanked, then every MEMORY_EVERY", async () => {
    for (let i = 0; i < 3; i++) await noteSellerMessage("seller");
    expect(prompts).toHaveLength(0);
    await noteSellerMessage("seller");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Seller: Crochet beanie hat, price 100");
    expect(prompts[0]).toContain("Seller: [a code]");
    expect(prompts[0]).not.toContain("BYQZm9");
    expect(prompts[0]).not.toContain("someone else's message");
    expect(await sellerMemory("seller")).toBe("- Sells crochet hats\n- Sends one product at a time");

    for (let i = 0; i < MEMORY_EVERY - 1; i++) await noteSellerMessage("seller");
    expect(prompts).toHaveLength(1);
    await noteSellerMessage("seller");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Previous notes:\n- Sells crochet hats");
  });

  it("never keeps a code the AI wrote into it", async () => {
    reply = "- Pasted client id c9758cb3-8a9b-49b2-9ae5-6973aa3015cd";
    for (let i = 0; i < 4; i++) await noteSellerMessage("seller");
    expect(await sellerMemory("seller")).toBe("- Pasted client id [a code]");
  });

  it("the prompt asks for lasting facts only, never codes or contact details", () => {
    const p = memoryPrompt("", ["2026-10-07 Seller: hi"]);
    expect(p).toContain("Never write a code, token, Client ID, key, password, phone number or email.");
    expect(p).toContain("(none yet)");
  });
});
