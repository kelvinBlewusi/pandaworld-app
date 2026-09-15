import { pickJoke, JOKES, JOKE_COUNT } from "@/lib/whatsapp/waiting-jokes";

describe("waiting jokes", () => {
  it("carries the 30 that were curated", () => {
    expect(JOKE_COUNT).toBe(30);
    expect(JOKES).toHaveLength(30);
  });

  // A duplicate is invisible in a list this long, and it reads as a bug to
  // a seller who gets the same joke twice and assumes the bot is stuck.
  it("has no duplicates", () => {
    expect(new Set(JOKES).size).toBe(JOKES.length);
  });

  it("always returns one of them", () => {
    for (let i = 0; i < 200; i++) {
      expect(JOKES).toContain(pickJoke());
    }
  });

  // "sent randomly when requested without any order to it" — so no cursor,
  // no rotation, no cycling. Over 400 draws a 30-item list should turn up
  // most of itself; anything that walked in order would too, which is why
  // the ordering check below is the one that matters.
  it("draws from the whole list", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) seen.add(pickJoke());
    expect(seen.size).toBeGreaterThan(20);
  });

  it("is not sequential", () => {
    // A rotating picker would produce the list in order. Random will not:
    // the odds of 30 independent draws landing in index order are
    // 1 in 30^29, which is not a flake anyone will ever see.
    const draws = Array.from({ length: 30 }, () => pickJoke());
    const inOrder = JOKES.slice(0, 30);
    expect(draws).not.toEqual(inOrder);
  });
});
