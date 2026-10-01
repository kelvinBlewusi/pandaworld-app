/**
 * whatsapp_message_log's write path — added 2026-09-24 to close a gap hit
 * repeatedly live: neither the app nor Vercel's own runtime logs kept a
 * queryable record of what a WhatsApp conversation actually said. See
 * lib/whatsapp/message-log.ts's own doc comment.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => db,
}));

import { describeOutboundMessage, logInboundMessage, logOutboundMessage } from "@/lib/whatsapp/message-log";

describe("describeOutboundMessage — pure extraction from callGraphApi's body", () => {
  it("extracts a plain text send", () => {
    expect(describeOutboundMessage("233550607231", { type: "text", text: { body: "Hello" } })).toEqual({
      phoneNumber: "233550607231", direction: "outbound", messageType: "text", bodyText: "Hello",
    });
  });

  it("extracts a button send, with the button titles in payload", () => {
    const body = {
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: "Pick one" },
        action: { buttons: [{ type: "reply", reply: { id: "submit all", title: "Submit all ✅" } }] },
      },
    };
    expect(describeOutboundMessage("233550607231", body)).toEqual({
      phoneNumber: "233550607231", direction: "outbound", messageType: "button", bodyText: "Pick one",
      payload: { buttons: [{ id: "submit all", title: "Submit all ✅" }] },
    });
  });

  it("extracts a list send, with rows and the list's own button text in payload", () => {
    const body = {
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: "Submit a specific product:" },
        action: {
          button: "Pick a product",
          sections: [{ rows: [{ id: "submit 1", title: "Submit product 1", description: "Kettle" }] }],
        },
      },
    };
    expect(describeOutboundMessage("233550607231", body)).toEqual({
      phoneNumber: "233550607231", direction: "outbound", messageType: "list", bodyText: "Submit a specific product:",
      payload: { buttonText: "Pick a product", rows: [{ id: "submit 1", title: "Submit product 1", description: "Kettle" }] },
    });
  });

  it("extracts a cta_url send, with the url in payload", () => {
    const body = {
      type: "interactive",
      interactive: {
        type: "cta_url",
        body: { text: "Reconnect Jumia:" },
        action: { name: "cta_url", parameters: { display_text: "Reconnect", url: "https://pandaworldai.site/api/jumia/connect?wa_token=abc" } },
      },
    };
    expect(describeOutboundMessage("233550607231", body)).toEqual({
      phoneNumber: "233550607231", direction: "outbound", messageType: "cta_url", bodyText: "Reconnect Jumia:",
      payload: { buttonText: "Reconnect", url: "https://pandaworldai.site/api/jumia/connect?wa_token=abc" },
    });
  });

  // The mark-read/typing-indicator call (markReadWithTypingIfConfigured)
  // goes through the exact same callGraphApi chokepoint as every real
  // send — this is what keeps it out of the conversation log, since it
  // carries no message content of its own and isn't something a seller
  // experiences as a message.
  it("extracts an image send, with the caption as the text and the link in payload", () => {
    const body = { type: "image", image: { link: "https://pandaworldai.site/whatsapp/quiet-mode-example.jpg?v=1" } };
    expect(describeOutboundMessage("233550607231", body)).toEqual({
      phoneNumber: "233550607231", direction: "outbound", messageType: "image", bodyText: null,
      payload: { link: "https://pandaworldai.site/whatsapp/quiet-mode-example.jpg?v=1" },
    });
  });

  it("returns null for the mark-read/typing-indicator call", () => {
    expect(describeOutboundMessage("233550607231", { status: "read", message_id: "wamid.abc", typing_indicator: { type: "text" } })).toBeNull();
  });

  it("returns null for an unrecognised body shape rather than throwing", () => {
    expect(describeOutboundMessage("233550607231", { type: "template" })).toBeNull();
  });
});

describe("logOutboundMessage / logInboundMessage — write to whatsapp_message_log", () => {
  beforeEach(() => {
    db.tables.whatsapp_message_log = [];
  });

  // Fire-and-forget by design (see the module's own doc comment) — these
  // tests give the microtask queue one tick to let the insert land before
  // asserting, the same pattern deductCredits' own tests use elsewhere.
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it("writes an outbound text send", async () => {
    logOutboundMessage("233550607231", { type: "text", text: { body: "Hi" } });
    await flush();
    expect(db.tables.whatsapp_message_log).toHaveLength(1);
    expect(db.tables.whatsapp_message_log[0]).toMatchObject({
      phone_number: "233550607231", direction: "outbound", message_type: "text", body_text: "Hi",
    });
  });

  it("writes nothing for the mark-read/typing-indicator call", async () => {
    logOutboundMessage("233550607231", { status: "read", message_id: "wamid.abc" });
    await flush();
    expect(db.tables.whatsapp_message_log).toHaveLength(0);
  });

  it("writes an inbound message with its wamid", async () => {
    logInboundMessage("233550607231", "wamid.123", "text", "3 products");
    await flush();
    expect(db.tables.whatsapp_message_log).toHaveLength(1);
    expect(db.tables.whatsapp_message_log[0]).toMatchObject({
      phone_number: "233550607231", direction: "inbound", message_type: "text", body_text: "3 products", wamid: "wamid.123",
    });
  });
});
