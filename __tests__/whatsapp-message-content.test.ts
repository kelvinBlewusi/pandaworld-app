import { contentOf, METAS_OWN_UNSUPPORTED_TYPE, type IncomingMessage } from "@/lib/whatsapp/message-content";

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
    ).toEqual({ text: "done", tapped: true });
  });

  // A list row and a button carry the same contract — the id IS the
  // command phrase — so "submit 7" must reach the parser identically
  // whichever one the seller tapped. Ten submit rows only fit in a list.
  it("surfaces a tapped list-row's id as text, exactly like a button", () => {
    expect(
      contentOf(msg({
        type: "interactive",
        interactive: { list_reply: { id: "submit 7", title: "Submit product 7", description: "Sony Headphones" } },
      })),
    ).toEqual({ text: "submit 7", tapped: true });
  });

  // An order alert sent outside the 24 hours is a template; its quick-reply
  // tap comes back as type "button" carrying the payload set at send time.
  it("surfaces a template quick-reply's payload as text, like a button id", () => {
    expect(
      contentOf(msg({ type: "button", button: { text: "Pack & get label", payload: "orders:packall" } })),
    ).toEqual({ text: "orders:packall", tapped: true });
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
    // A tap is marked so the AI doesn't read it: it means one thing (2026-10-07).
    expect(contentOf(msg({ type: "interactive", interactive: { button_reply: { id: "done", title: "Done" } } })))
      .toEqual({ text: "done", tapped: true });
  });
  // Meta's OWN "unsupported" container is not a media type the seller
  // chose — it is WhatsApp saying it could not represent the message at
  // all (a poll, a view-once photo, or the envelope that rides along with
  // a multi-photo album). Marked with platformError so intake can tell
  // the two apart; see METAS_OWN_UNSUPPORTED_TYPE.
  it("distinguishes Meta's own unsupported container and keeps its reason", () => {
    const result = contentOf(
      msg({
        type: METAS_OWN_UNSUPPORTED_TYPE,
        errors: [
          {
            code: 131051,
            title: "Unsupported message type",
            error_data: { details: "Message type is not currently supported" },
          },
        ],
      }),
    );
    expect(result.unsupported).toBe("unsupported");
    expect(result.platformError).toBe(
      "131051 Unsupported message type: Message type is not currently supported",
    );
  });

  it("still reports Meta's container when it supplies no error detail", () => {
    expect(contentOf(msg({ type: METAS_OWN_UNSUPPORTED_TYPE }))).toEqual({
      unsupported: "unsupported",
      platformError: "no error detail supplied",
    });
  });

  // A real media type must NOT pick up platformError — that flag is what
  // buys silence during an album, and a video the seller deliberately sent
  // still deserves an answer.
  it("leaves platformError unset for media types the seller actually sent", () => {
    expect(contentOf(msg({ type: "video" })).platformError).toBeUndefined();
    expect(contentOf(msg({ type: "document" })).platformError).toBeUndefined();
  });
});
