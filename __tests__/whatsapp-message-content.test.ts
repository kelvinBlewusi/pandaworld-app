import { contentOf, type IncomingMessage } from "@/lib/whatsapp/message-content";

function msg(overrides: Partial<IncomingMessage>): IncomingMessage {
  return { id: "wamid.1", from: "233241234567", type: "text", ...overrides };
}

describe("contentOf", () => {
  it("surfaces an image's media id and caption together", () => {
    expect(contentOf(msg({ type: "image", image: { id: "media-1", caption: "Price 40, done" } }))).toEqual({
      imageMediaId: "media-1",
      text: "Price 40, done",
    });
  });

  it("surfaces an image with no caption", () => {
    expect(contentOf(msg({ type: "image", image: { id: "media-1" } }))).toEqual({
      imageMediaId: "media-1",
      text: undefined,
    });
  });

  it("surfaces plain text messages", () => {
    expect(contentOf(msg({ type: "text", text: { body: "submit all" } }))).toEqual({ text: "submit all" });
  });

  it("surfaces a tapped reply-button's id as text", () => {
    expect(
      contentOf(msg({ type: "interactive", interactive: { button_reply: { id: "done", title: "Done ✅" } } })),
    ).toEqual({ text: "done" });
  });

  // This used to return {} for anything unreadable, and the message then
  // fell through the whole state machine in silence: a seller sends a
  // video of their product, sees it delivered, and nothing ever comes
  // back. Deny-by-default now, so intake can answer instead of dropping it.
  it("flags anything it cannot read, rather than returning nothing", () => {
    expect(contentOf(msg({ type: "sticker" }))).toEqual({ unsupported: "sticker" });
    expect(contentOf(msg({ type: "video" }))).toEqual({ unsupported: "video" });
    expect(contentOf(msg({ type: "audio" }))).toEqual({ unsupported: "audio" });
    expect(contentOf(msg({ type: "document" }))).toEqual({ unsupported: "document" });
    expect(contentOf(msg({ type: "location" }))).toEqual({ unsupported: "location" });
  });

  it("flags a type nobody has thought of yet", () => {
    // The point of deny-by-default: a future Meta message type still gets
    // an answer instead of the void.
    expect(contentOf(msg({ type: "some_future_type" }))).toEqual({ unsupported: "some_future_type" });
  });

  it("flags an interactive message with no button reply", () => {
    // e.g. a list reply, which this bot never sends and cannot parse.
    expect(contentOf(msg({ type: "interactive", interactive: {} }))).toEqual({ unsupported: "interactive" });
  });

  it("still reads everything it CAN read, unchanged", () => {
    expect(contentOf(msg({ type: "text", text: { body: "hello" } }))).toEqual({ text: "hello" });
    expect(contentOf(msg({ type: "image", image: { id: "m1" } }))).toEqual({ imageMediaId: "m1", text: undefined });
    expect(contentOf(msg({ type: "interactive", interactive: { button_reply: { id: "done", title: "Done" } } })))
      .toEqual({ text: "done" });
  });
});
