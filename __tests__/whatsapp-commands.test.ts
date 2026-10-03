import { parseGlobalCommand } from "@/lib/whatsapp/commands";

describe("parseGlobalCommand", () => {
  it("matches restart/cancel phrasings case-insensitively with optional punctuation", () => {
    expect(parseGlobalCommand("restart")).toEqual({ type: "restart" });
    expect(parseGlobalCommand("Restart!")).toEqual({ type: "restart" });
    expect(parseGlobalCommand("  CANCEL.  ")).toEqual({ type: "restart" });
    expect(parseGlobalCommand("start over")).toEqual({ type: "restart" });
    expect(parseGlobalCommand("start again")).toEqual({ type: "restart" });
    expect(parseGlobalCommand("new batch")).toEqual({ type: "restart" });
    expect(parseGlobalCommand("reset")).toEqual({ type: "restart" });
    expect(parseGlobalCommand("stop")).toEqual({ type: "restart" });
  });

  it("matches Start another, the button under submitted and drafted products", () => {
    expect(parseGlobalCommand("start another")).toEqual({ type: "start_another" });
    expect(parseGlobalCommand("Start another!")).toEqual({ type: "start_another" });
    expect(parseGlobalCommand("list more")).toEqual({ type: "start_another" });
    expect(parseGlobalCommand("start another product please")).toBeNull();
  });

  it("matches disconnect and confirm disconnect, preferring the more specific phrase", () => {
    expect(parseGlobalCommand("disconnect")).toEqual({ type: "disconnect" });
    expect(parseGlobalCommand("Disconnect Jumia")).toEqual({ type: "disconnect" });
    expect(parseGlobalCommand("confirm disconnect")).toEqual({ type: "confirm_disconnect" });
    expect(parseGlobalCommand("Confirm Disconnect!")).toEqual({ type: "confirm_disconnect" });
  });

  it("matches status and help", () => {
    expect(parseGlobalCommand("status")).toEqual({ type: "status" });
    expect(parseGlobalCommand("where am I?")).toEqual({ type: "status" });
    expect(parseGlobalCommand("help")).toEqual({ type: "help" });
    expect(parseGlobalCommand("?")).toEqual({ type: "help" });
    expect(parseGlobalCommand("commands")).toEqual({ type: "help" });
  });

  it("does not match longer sentences or unrelated text", () => {
    expect(parseGlobalCommand("I want to stop the listing and start a new one")).toBeNull();
    expect(parseGlobalCommand("Price 40, done")).toBeNull();
    expect(parseGlobalCommand("submit all")).toBeNull();
    expect(parseGlobalCommand("thanks")).toBeNull();
    expect(parseGlobalCommand("")).toBeNull();
  });

  // "Retry" is the counterpart to "restart" that every error message now
  // offers: same batch, same photos, run the failed step again. Before it
  // existed the only recovery a seller could find after a failure was
  // re-sending every photo.
  it("matches retry, with and without a product number", () => {
    expect(parseGlobalCommand("retry")).toEqual({ type: "retry", seq: null });
    expect(parseGlobalCommand("Retry!")).toEqual({ type: "retry", seq: null });
    expect(parseGlobalCommand("  RETRY.  ")).toEqual({ type: "retry", seq: null });
    expect(parseGlobalCommand("retry again")).toEqual({ type: "retry", seq: null });
    expect(parseGlobalCommand("retry that")).toEqual({ type: "retry", seq: null });
    expect(parseGlobalCommand("retry 2")).toEqual({ type: "retry", seq: 2 });
    expect(parseGlobalCommand("retry product 3")).toEqual({ type: "retry", seq: 3 });
    expect(parseGlobalCommand("Retry Product3")).toEqual({ type: "retry", seq: 3 });
  });

  it("keeps retry and restart distinct — they mean opposite things", () => {
    // Restart throws the batch away; retry keeps it and re-runs the failed
    // step. Collapsing either into the other would silently destroy a
    // seller's uploaded photos or silently re-bill them for a re-draft.
    expect(parseGlobalCommand("retry")).not.toEqual({ type: "restart" });
    expect(parseGlobalCommand("restart")).not.toEqual(expect.objectContaining({ type: "retry" }));
    expect(parseGlobalCommand("start over")).toEqual({ type: "restart" });
  });

  it("does not swallow free text that merely mentions retrying", () => {
    // The button ids are whole-message phrases; a sentence about retrying
    // must still reach the batch handlers as ordinary text, or a seller
    // describing a problem would have their batch re-queued underneath
    // them.
    expect(parseGlobalCommand("retry the blue one please")).toBeNull();
    expect(parseGlobalCommand("can you retry")).toBeNull();
    expect(parseGlobalCommand("retrying")).toBeNull();
    expect(parseGlobalCommand("2: retry")).toBeNull();
  });

  it("matches 'keep jumia connected' as its own command, never as restart/disconnect", () => {
    expect(parseGlobalCommand("keep jumia connected")).toEqual({ type: "keep_connected" });
    expect(parseGlobalCommand("Keep Jumia Connected!")).toEqual({ type: "keep_connected" });
    // The whole point of this command existing: declining the disconnect
    // prompt must never be misread as "cancel" (== restart the batch).
    expect(parseGlobalCommand("keep jumia connected")).not.toEqual({ type: "restart" });
    expect(parseGlobalCommand("keep jumia connected")).not.toEqual({ type: "disconnect" });
  });

  it("matches 'reconnect jumia' — the web-disconnect notice's reply button", () => {
    expect(parseGlobalCommand("reconnect jumia")).toEqual({ type: "reconnect_jumia" });
    expect(parseGlobalCommand("Reconnect Jumia!")).toEqual({ type: "reconnect_jumia" });
    expect(parseGlobalCommand("reconnect jumia")).not.toEqual({ type: "disconnect" });
  });
});
