/**
 * Rejections we fix by taking words out (lib/ai/restricted-words.ts):
 * banned words Jumia names, and a brand name its quality check refuses in
 * the listing's text. Live 2026-10-04/05: a costume set refused for
 * "camouflage", and a police officer costume refused in QC for "Police".
 */

import {
  onlyRestrictedWordsInRejection,
  restrictedBrandWordsInRejection,
  removeWordsFromText,
} from "@/lib/ai/restricted-words";

const CAMOUFLAGE =
  "The highlighted word has been placed on the blacklist, prohibiting its usage in Ghana\n" +
  "The Attribute [ short_description ] contains the restricted words : camouflage;\n" +
  "The Attribute [ description ] contains the restricted words : camouflage;";

describe("onlyRestrictedWordsInRejection", () => {
  it("is true when banned words are all Jumia complained about", () => {
    expect(onlyRestrictedWordsInRejection(CAMOUFLAGE)).toBe(true);
  });

  it("is false when something else is wrong too, or nothing was banned", () => {
    expect(onlyRestrictedWordsInRejection(`${CAMOUFLAGE}\nThe column [product_weight] is missing from the file.`)).toBe(false);
    expect(onlyRestrictedWordsInRejection("Image is blurry")).toBe(false);
    expect(onlyRestrictedWordsInRejection(null)).toBe(false);
  });
});

describe("restrictedBrandWordsInRejection", () => {
  it("reads the brand Jumia's quality check refused in the name, as Jumia spelled it", () => {
    expect(restrictedBrandWordsInRejection("quality check: Restricted Brand: Police in NAME - Seller not in approved list"))
      .toEqual(["Police"]);
  });

  it("is empty for any other rejection, including a refused brand field", () => {
    expect(restrictedBrandWordsInRejection("Kindly Provide Product's Health/Food Regulation Registration Number.")).toEqual([]);
    expect(restrictedBrandWordsInRejection("You're not allowed to sell this brand")).toEqual([]);
    expect(restrictedBrandWordsInRejection(null)).toEqual([]);
  });
});

describe("removeWordsFromText", () => {
  it("takes the word out of a title and tidies what's left", () => {
    expect(removeWordsFromText("Police Officer Role Play Costume Set - Vest, Handcuffs", ["Police"], { line: true }))
      .toBe("Officer Role Play Costume Set - Vest, Handcuffs");
    expect(removeWordsFromText("Costume Set - Police", ["police"], { line: true })).toBe("Costume Set");
    expect(removeWordsFromText("Vest, police, Handcuffs", ["Police"], { line: true })).toBe("Vest, Handcuffs");
  });

  it("only takes whole words", () => {
    expect(removeWordsFromText("Policeman figure", ["Police"])).toBe("Policeman figure");
  });
});
