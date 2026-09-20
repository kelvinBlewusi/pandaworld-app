import {
  extractVariantClaim,
  reconcileVariants,
  variantClaimWarning,
} from "@/lib/whatsapp/variant-claims";

/** The five colours the photo showed in the live failure. */
const PHOTO = ["Red", "Yellow", "Orange", "White", "Blue"];

describe("extractVariantClaim", () => {
  it("says nothing when the seller said nothing about availability", () => {
    expect(extractVariantClaim("The price is 200")).toBeNull();
    expect(extractVariantClaim("Nice helmets, good quality")).toBeNull();
    expect(extractVariantClaim("")).toBeNull();
    expect(extractVariantClaim(null)).toBeNull();
  });

  it("reads the plain forms", () => {
    expect(extractVariantClaim("Only red and blue are available")?.tokens).toEqual(["red", "blue"]);
    expect(extractVariantClaim("Red only is available")?.tokens).toEqual(["red"]);
    expect(extractVariantClaim("I only have red and white")?.tokens).toEqual(["red", "white"]);
    expect(extractVariantClaim("Available: red, blue")?.tokens).toEqual(["red", "blue"]);
  });

  it("strips the words that carry no option name", () => {
    // "is", "available", "in stock", "colours" etc. are scaffolding
    // around the values, not values.
    expect(extractVariantClaim("only the red one is available in stock")?.tokens)
      .toEqual(["red"]);
  });

  it("keeps the seller's exact wording as the source", () => {
    const c = extractVariantClaim("Only red and blue are available");
    expect(c?.source).toBe("Only red and blue are available");
  });
});

describe("reconcileVariants — the live failure", () => {
  // Verbatim. A photo of five coloured hard hats, and this note. The
  // draft used all five; the seller got a live listing offering four
  // colours they don't stock.
  const NOTE = "Only black is red is available";

  it("refuses to resolve it, rather than guessing", () => {
    const r = reconcileVariants(extractVariantClaim(NOTE), PHOTO);
    expect(r.kind).toBe("unresolved");
    // "red" does match. Resolving on that alone would be a guess about
    // someone's inventory — "black" is right there, unaccounted for.
    if (r.kind === "unresolved") expect(r.reason).toContain("black");
  });

  it("does NOT fall back to the photo's five colours", () => {
    // The whole point. This is what actually shipped, and what the
    // prompt already forbade in as many words.
    const r = reconcileVariants(extractVariantClaim(NOTE), PHOTO);
    expect(r.kind).not.toBe("no_claim");
    expect(r).not.toHaveProperty("keep");
  });

  it("quotes the seller back to themselves", () => {
    const r = reconcileVariants(extractVariantClaim(NOTE), PHOTO);
    const warning = variantClaimWarning(r);
    // A seller recognises their own typo far faster than a paraphrase.
    expect(warning).toContain(NOTE);
    expect(warning).toContain("Tap Edit");
  });
});

describe("reconcileVariants", () => {
  it("leaves the draft alone when there's no claim", () => {
    expect(reconcileVariants(null, PHOTO)).toEqual({ kind: "no_claim" });
  });

  it("restricts to exactly what the seller named", () => {
    const r = reconcileVariants(extractVariantClaim("Only red and blue are available"), PHOTO);
    expect(r).toMatchObject({ kind: "restrict", keep: ["Red", "Blue"] });
  });

  it("restricts to a single option", () => {
    const r = reconcileVariants(extractVariantClaim("Only white is available"), PHOTO);
    expect(r).toMatchObject({ kind: "restrict", keep: ["White"] });
  });

  it("matches a colour word inside a longer label", () => {
    // Pass A sometimes labels variants "Red Safety Helmet" rather than
    // "Red"; the seller still just writes "red".
    const labels = ["Red Safety Helmet", "Blue Safety Helmet"];
    const r = reconcileVariants(extractVariantClaim("Only red is available"), labels);
    expect(r).toMatchObject({ kind: "restrict", keep: ["Red Safety Helmet"] });
  });

  it("does not match a token that merely CONTAINS a label", () => {
    // "reddish" is not "Red". Substring matching in that direction is how
    // a near-miss becomes a confident wrong answer.
    const r = reconcileVariants(extractVariantClaim("Only reddish is available"), PHOTO);
    expect(r.kind).toBe("unresolved");
  });

  it("refuses when the seller names an option that isn't there at all", () => {
    // Black isn't among the photo's colours. Maybe they have stock the
    // photo doesn't show; maybe they misspoke. Either way it's theirs to
    // resolve, not ours.
    const r = reconcileVariants(extractVariantClaim("Only black is available"), PHOTO);
    expect(r.kind).toBe("unresolved");
  });

  it("refuses when only SOME of the claim resolves", () => {
    const r = reconcileVariants(extractVariantClaim("Only red and black are available"), PHOTO);
    expect(r.kind).toBe("unresolved");
    if (r.kind === "unresolved") expect(r.reason).toContain("black");
  });

  it("is case-insensitive about how the seller wrote the colour", () => {
    const r = reconcileVariants(extractVariantClaim("Only RED and Blue are available"), PHOTO);
    expect(r).toMatchObject({ kind: "restrict", keep: ["Red", "Blue"] });
  });

  it("never returns more variants than the draft proposed", () => {
    // The asymmetry this module exists for: too few is an edit, too many
    // is stock the seller has to honour or cancel on.
    for (const note of [
      "Only red and blue are available",
      "Only white is available",
      "I only have red",
    ]) {
      const r = reconcileVariants(extractVariantClaim(note), PHOTO);
      if (r.kind === "restrict") {
        expect(r.keep.length).toBeLessThanOrEqual(PHOTO.length);
        expect(r.keep.every((k) => PHOTO.includes(k))).toBe(true);
      }
    }
  });

  it("handles a claim against an empty proposal without inventing one", () => {
    const r = reconcileVariants(extractVariantClaim("Only red is available"), []);
    expect(r.kind).toBe("unresolved");
  });
});

describe("reconcileVariants — the live 'too' failure", () => {
  // Verbatim, from a 20-product batch, 2026-09-20: an air fryer note.
  // "too" isn't a connector, so it read as a second claimed option that
  // matches nothing in the photo — the ENTIRE claim (including the "blue"
  // that DID match) came back unresolved and every colour got dropped.
  const NOTE = "The colors are black and we have blue too";
  const PHOTO_COLOURS = ["Black", "Blue"];

  it("does not read 'too' as a claimed option", () => {
    expect(extractVariantClaim(NOTE)?.tokens).not.toContain("too");
  });

  it("resolves instead of wiping out every colour on the draft", () => {
    const r = reconcileVariants(extractVariantClaim(NOTE), PHOTO_COLOURS);
    expect(r.kind).toBe("restrict");
  });
});

describe("variantClaimWarning", () => {
  it("is silent for a resolved or absent claim", () => {
    expect(variantClaimWarning({ kind: "no_claim" })).toBeNull();
    expect(variantClaimWarning({ kind: "restrict", keep: ["Red"], source: "only red" })).toBeNull();
  });
});
