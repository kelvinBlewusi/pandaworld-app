/**
 * Banned words learned from Jumia's own rejections: once Jumia names a word,
 * drafting and pushing keep it out like the built-in list
 * (lib/ai/restricted-words.ts, lib/jumia/learned-restricted-words.ts).
 */

const upserts: { rows: unknown[]; opts: unknown }[] = [];
let storedWords: string[] = [];

jest.mock("@/lib/supabase/server", () => ({
  createServerClient: () => ({
    from: () => ({
      select: async () => ({ data: storedWords.map((word) => ({ word })), error: null }),
      upsert: async (rows: unknown[], opts: unknown) => { upserts.push({ rows, opts }); return { error: null }; },
    }),
  }),
}));

import {
  restrictedWordsInJumiaRejection,
  stripRestrictedWords,
  findRestrictedWords,
  buildRestrictedWordsInstruction,
  learnedRestrictedWords,
} from "@/lib/ai/restricted-words";
import { loadLearnedRestrictedWords, rememberRestrictedWords } from "@/lib/jumia/learned-restricted-words";

describe("restrictedWordsInJumiaRejection", () => {
  it("reads the word out of Jumia's real rejection messages", () => {
    // Both confirmed live (see the comments in lib/ai/restricted-words.ts).
    expect(restrictedWordsInJumiaRejection(
      "The highlighted word has been placed on the blacklist... The Attribute [description] contains the restricted words : supreme",
    )).toEqual(["supreme"]);
    expect(restrictedWordsInJumiaRejection(
      "The Attribute [description] contains the restricted words : second hand",
    )).toEqual(["second hand"]);
  });

  it("reads each word of a list", () => {
    expect(restrictedWordsInJumiaRejection("The Attribute [name] contains the restricted words : Deluxe, Genuine")).toEqual(["deluxe", "genuine"]);
  });

  it("never takes a template placeholder for a word", () => {
    expect(restrictedWordsInJumiaRejection("The Attribute [material] contains the restricted words : [banned_word];")).toEqual([]);
    expect(restrictedWordsInJumiaRejection("The Attribute [{0}] contains the restricted words : {1}")).toEqual([]);
  });

  it("finds nothing in other rejections", () => {
    expect(restrictedWordsInJumiaRejection("You can't list products in this category. Please choose a different (more specific) category and try again.")).toEqual([]);
    expect(restrictedWordsInJumiaRejection(null)).toEqual([]);
  });
});

describe("learned words", () => {
  it("are stripped, found and named to the AI like the built-in list", async () => {
    expect(findRestrictedWords("A deluxe kettle")).toEqual([]);

    await rememberRestrictedWords(["deluxe"], "The Attribute [name] contains the restricted words : deluxe");

    expect(stripRestrictedWords("Deluxe Electric Kettle")).toBe("Electric Kettle");
    expect(findRestrictedWords("A deluxe kettle")).toEqual(["deluxe"]);
    expect(buildRestrictedWordsInstruction()).toContain('"deluxe"');
    // Built-in words still work alongside.
    expect(stripRestrictedWords("Brand New Deluxe Kettle")).toBe("Kettle");
    expect(upserts[0].rows).toEqual([expect.objectContaining({ word: "deluxe" })]);
    expect(upserts[0].opts).toEqual({ onConflict: "word" });
  });

  it("are loaded from the database into a fresh process", async () => {
    storedWords = ["gorgeous"];
    await loadLearnedRestrictedWords();
    expect(learnedRestrictedWords()).toContain("gorgeous");
    expect(stripRestrictedWords("Gorgeous Silk Scarf")).toBe("Silk Scarf");
  });
});

describe("the live 2026-09-29 rejection", () => {
  it("is read as the phrase Jumia named, and stripped once learned", async () => {
    const raw = "The highlighted word has been placed on the blacklist, prohibiting its usage in Ghana\nThe Attribute [ description ] contains the restricted words : color may vary;";
    expect(restrictedWordsInJumiaRejection(raw)).toEqual(["color may vary"]);
    await rememberRestrictedWords(["color may vary"], raw);
    expect(stripRestrictedWords("Note: Color may vary slightly from the photos.")).toBe("Note: slightly from the photos.");
  });
});
