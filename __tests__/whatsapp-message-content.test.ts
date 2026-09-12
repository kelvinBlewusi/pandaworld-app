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

  it("returns nothing for an unrecognized or empty message", () => {
    expect(contentOf(msg({ type: "sticker" }))).toEqual({});
    expect(contentOf(msg({ type: "interactive", interactive: {} }))).toEqual({});
  });
});
