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
