import {
  classifyJumiaRejection,
  isAutoFixable,
  extractRejectedAttributeName,
  extractNotVisibleAttributeNames,
  extractRejectionText,
  rejectionFingerprint,
  shouldBlockRepeatedAutoFix,
} from "@/lib/jumia/rejection-remedy";

// Real rejection strings from this account's failed pushes.
describe("classifyJumiaRejection", () => {
  it("names a banned word and fixes it by resubmitting, not redrafting", () => {
    // The exact live rejection, 2026-09-29. It used to fall into the
    // attribute bucket ("the attribute"): redrafted, rejected again, and
    // the seller told "Some category fields Jumia wants are missing".
    const r = classifyJumiaRejection(
      "The highlighted word has been placed on the blacklist, prohibiting its usage in Ghana\nThe Attribute [ description ] contains the restricted words : color may vary;",
    );
    expect(r.kind).toBe("restricted_words");
    expect(r.explanation).toBe(`Jumia doesn't allow "color may vary" in listings — I'll take it out and resubmit.`);
    expect(isAutoFixable(r.kind)).toBe(true);
  });

  it("treats a missing column as fixable by a rerun of the draft", () => {
    // The exact message from a live rejection.
    const r = classifyJumiaRejection("The column [product_weight] is missing from the file.");
    expect(r.kind).toBe("rerun");
    expect(isAutoFixable(r.kind)).toBe(true);
  });

  it("treats a not-visible attribute as a cache correction, not a rerun", () => {
    const r = classifyJumiaRejection("Attribute [color_family] is not visible for category [Laptops].");
    expect(r.kind).toBe("not_visible_attributes");
    expect(isAutoFixable(r.kind)).toBe(true);
  });

  // The exact live rejection this remedy kind was built from — a batch
  // rejection naming seven attributes, one of them truncated mid-sentence.
  // Confirmed by the seller directly against Jumia's own Vendor Center
  // form: none of the seven are actually offered for this category.
  it("classifies the live multi-attribute Compact Refrigerators rejection as a cache correction", () => {
    const live = "Attribute [color_family] is not visible for category [Compact Refrigerators]. Attribute [main_material] is not visible for category [Compact Refrigerators]. Attribute [manufacturer_txt] is not visible for category [Compact Refrigerators]. Attribute [capacity_litres] is not visible for category [Compact Refrigerators]. Attribute [material_family] is not visible for category [Compact Refrigerators]. Attribute [note] is not visible for category [Compact Refrigerators]. Attribute [warranty_address]";
    const r = classifyJumiaRejection(live);
    expect(r.kind).toBe("not_visible_attributes");
  });

  // A mixed rejection — a not-visible attribute alongside a different kind
  // of problem — means more than a stale cache is wrong, so it should
  // still fall through to a full rerun rather than only clearing the
  // cache and missing the other issue.
  it("falls through to rerun when a not-visible complaint is mixed with a different problem", () => {
    const mixed = "Attribute [color_family] is not visible for category [Laptops]. The column [product_weight] is missing from the file.";
    const r = classifyJumiaRejection(mixed);
    expect(r.kind).toBe("rerun");
  });

  it("treats an invalid enum value as fixable", () => {
    expect(classifyJumiaRejection("Attribute [material_family] with invalid value [Fabric].").kind).toBe("rerun");
  });

  // The important half: never claim to fix what only the seller can.
  it("never auto-fixes a missing price", () => {
    const r = classifyJumiaRejection("Price is required for this product.");
    expect(r.kind).toBe("seller");
    expect(isAutoFixable(r.kind)).toBe(false);
    expect(r.explanation).toMatch(/price/i);
  });

  // A rerun rewrites the description from scratch, so an over-short one
  // IS fixable now — this is the opposite of the old assumption
  // (attribute-refill-only), which could never touch it.
  it("reruns a too-short description rather than handing it to the seller", () => {
    const r = classifyJumiaRejection("Description must be at least 50 characters.");
    expect(r.kind).toBe("rerun");
    expect(isAutoFixable(r.kind)).toBe(true);
  });

  // Same reasoning: a rerun picks a fresh category, so a too-broad one is
  // rerunnable now, not seller-only.
  it("reruns an unlistable category rather than handing it to the seller", () => {
    const r = classifyJumiaRejection("You can't list products in this category. Please choose a different (more specific) category and try again.");
    expect(r.kind).toBe("rerun");
    expect(isAutoFixable(r.kind)).toBe(true);
  });

  it("never auto-fixes an image problem", () => {
    expect(classifyJumiaRejection("Image resolution is invalid.").kind).toBe("seller");
  });

  // Live rejection, 2026-09-19 batch: an Electric Kettle's brand isn't
  // sellable in the shop's country. This used to fall through to
  // "unknown" (auto-fixable), so "Fix & resubmit" kept redrafting and
  // resubmitting the same forbidden brand — a rerun can never change it.
  it("never auto-fixes a brand banned for the shop's country", () => {
    const r = classifyJumiaRejection("You're not allowed to sell this brand in Ghana");
    expect(r.kind).toBe("seller");
    expect(isAutoFixable(r.kind)).toBe(false);
    expect(r.explanation).toMatch(/brand/i);
  });

  it("puts a seller-only cause ahead of the attribute pattern when both could match", () => {
    // "Price is required" contains "required", which the attribute rule
    // also matches. Order matters: an automatic re-push of a listing with
    // no price fails identically and wastes the seller's time.
    const r = classifyJumiaRejection("Attribute [price] is required for this product.");
    expect(r.kind).toBe("seller");
  });

  it("re-pushes a duplicate SKU without spending an AI call", () => {
    const r = classifyJumiaRejection("Duplicate SKU: this product already exists.");
    expect(r.kind).toBe("repush");
    expect(isAutoFixable(r.kind)).toBe(true);
  });

  it("attempts a repair for an unrecognised error, but says it isn't certain", () => {
    const r = classifyJumiaRejection("Something entirely unexpected happened on our side.");
    expect(r.kind).toBe("unknown");
    expect(isAutoFixable(r.kind)).toBe(true);
    expect(r.explanation).toMatch(/not certain/i);
  });

  it("handles a missing or empty error without throwing", () => {
    for (const input of [null, undefined, "", "   "]) {
      const r = classifyJumiaRejection(input);
      expect(r.kind).toBe("unknown");
      expect(r.explanation.length).toBeGreaterThan(0);
    }
  });

  it("always returns an explanation a seller could read aloud", () => {
    for (const msg of [
      "The column [product_weight] is missing from the file.",
      "Price is required.",
      "Duplicate SKU",
      "mystery",
    ]) {
      const r = classifyJumiaRejection(msg);
      expect(r.explanation).not.toMatch(/\[|\]/);   // no raw Jumia field syntax
      expect(r.explanation.length).toBeGreaterThan(10);
    }
  });
});

// Every message below is quoted verbatim from Jumia's own published error
// catalogue (2026-09-16). runAutoAnalyze — the rerun a "rerun" kind
// triggers — regenerates title, description, category AND
// dynamic_attributes from the images, so it can fix any of those; it
// never touches price, stock, a sale-price date, a barcode, or a
// re-uploaded image file, so a message about THOSE must never come back
// "rerun" no matter how much it resembles one.
describe("classifyJumiaRejection — the full Jumia error catalogue", () => {
  it("catches a duplicate VARIATION before the generic duplicate/repush rule", () => {
    // Contains the word "duplicate", which the SKU rule below would
    // otherwise claim — but minting a fresh SKU suffix (what "repush"
    // does) changes nothing about which variation values collide.
    const r = classifyJumiaRejection("Duplicate Variation on Product with seller sku [abc123] and Product set parent sku [xyz789]");
    expect(r.kind).toBe("seller");
    expect(isAutoFixable(r.kind)).toBe(false);
  });

  // Real live rejection (listings.jumia_error, 2026-09-19 batch), the
  // FULL composite message refreshPendingFeedStatus actually stores —
  // not just the bare Jumia fragment — since that composite text is what
  // classifyJumiaRejection is called with in production
  // (handleFixAndResubmit reads it straight off the listing row). A
  // different wire shape ("Product with parentSKU [X] and variation [Y]")
  // than the one above ("Product with seller sku [x] and Product set
  // parent sku [y]"), so worth its own fixture even though both share the
  // same "duplicate variation" trigger.
  it("catches a duplicate VARIATION inside the full multi-variant status line Jumia actually sent", () => {
    const r = classifyJumiaRejection(
      "1 of 4 variants went live. Jumia rejected PA-MU8ULMI7-BLK, PA-MU8ULMI7-GRN, PA-MU8ULMI7-BLU: " +
      "Duplicate Variation on Product with parentSKU [PA-MU8ULMI7] and variation [XXL]",
    );
    expect(r.kind).toBe("seller");
    expect(isAutoFixable(r.kind)).toBe(false);
  });

  // Our OWN pre-push hold (lib/jumia/api.ts resolveVariantRowVariation),
  // not a Jumia rejection — a rerun can't do any better than the first
  // guess since it's the seller's own typed value that didn't match.
  it("never auto-fixes our own 'not a stocked option' variation hold", () => {
    const r = classifyJumiaRejection(
      `Variation "Navy Blue" isn't one of this category's stocked options (Black, Blue, Grey, Red, White) — pick one of those, or use the editor if you genuinely stock a new one.`,
    );
    expect(r.kind).toBe("seller");
    expect(isAutoFixable(r.kind)).toBe(false);
  });

  // Real live rejection (listings.jumia_error, 2026-09-19 batch, Baby
  // Carrier): Jumia's OWN async verdict for the identical problem the
  // local hold above exists to catch before push — the local check missed
  // this one (the category's variant-axis schema hadn't synced yet), and
  // without this branch it fell through to the generic attribute pattern
  // below and came back "rerun" — wrong, since a rerun re-derives variant
  // labels from the SAME photos and reproduces the same guess.
  it("never auto-fixes Jumia's own 'invalid variation value' rejection either", () => {
    const r = classifyJumiaRejection("Attribute [variation] with invalid value [Navy Blue].");
    expect(r.kind).toBe("seller");
    expect(isAutoFixable(r.kind)).toBe(false);
  });

  it("reruns a title/brand-name problem instead of stopping at the seller", () => {
    for (const msg of [
      "Product name or translations [Red Nike Shoe] contains Brand name [Nike].",
      "Product name or translations [John's Shop Special] contains Seller name [John] or Company name [John Ltd].",
      "Product Name [Ch3ap Phone] has prohibited characters [3]",
      "Product Name [Ch3ap Phone] has prohibited characters [3] not allowed for language [en].",
    ]) {
      const r = classifyJumiaRejection(msg);
      expect(r.kind).toBe("rerun");
    }
  });

  it("reruns a trademark/brand mismatch", () => {
    const r = classifyJumiaRejection("You have referred to a trademark that is protected, but you have not accurately specified the corresponding brand of the product.");
    expect(r.kind).toBe("rerun");
  });

  it("catches 'mandatory' price/stock wording the original 'required|missing|invalid|must' set missed", () => {
    // Jumia's own word for these two doesn't overlap with the original
    // seller-check vocabulary at all — both fell through to "unknown"
    // and wasted an automatic rerun+resubmit that could never have
    // supplied a price or a stock count — runAutoAnalyze doesn't touch
    // either field.
    expect(classifyJumiaRejection("The Global Price is mandatory in order to create a Product.").kind).toBe("seller");
    expect(classifyJumiaRejection("The initial Stock is mandatory in order to create a Product.").kind).toBe("seller");
  });

  it("treats every sale-price and global-price business rule as seller-owned", () => {
    for (const msg of [
      "The Global Sale Price StartAt and Sale Price EndAt must be bigger than the current date.",
      "The Global Sale Price StartAt is after than Sale Price EndAt.",
      "The Global Sale Price should not be zero.",
      "The Global Sale Price should not be greater than or equal Price.",
      "EndAt is mandatory when Sale Price is filled.",
      "StartAt is mandatory when Sale Price is filled.",
      "The Global Sale Price cannot have more than two decimal places.",
      "The Global Sale Price should not be a negative value.",
      "The Global StartAt and EndAt are mandatory when Sale Price is filled.",
      "Global Sale Price discount [10%] must be equal or less than [5%]",
      "Global Sale Price discount [2%] must be equal or bigger than [5%]",
      "The Global Price [3] must be equal or more than [5].",
      "The Global Price [500] must be equal or less than [100].",
      "The Global Price cannot have more than two decimal places.",
      "The Global Price should not be a negative value.",
      "The Global Price should not be zero.",
    ]) {
      const r = classifyJumiaRejection(msg);
      expect(r.kind).toBe("seller");
    }
  });

  it("never re-pushes a duplicate barcode as if a fresh SKU would help", () => {
    const r = classifyJumiaRejection("A product with the Barcode EAN [6009123456789] already exists.");
    expect(r.kind).toBe("seller");
  });

  it("catches image failures the original word list missed", () => {
    expect(classifyJumiaRejection("Connection timeout while connecting to specified Image URL [http://example.com/a.jpg].").kind).toBe("seller");
    expect(classifyJumiaRejection("Product Image [a.gif] extension [gif] is not allowed. The available image extension list are [[JPEG, JPG, PNG]].").kind).toBe("seller");
    expect(classifyJumiaRejection("Product Image [a.jpg] Dimensions Height X should be between 200 and 3000 and Width Y should be between 200 and 3000.").kind).toBe("seller");
    expect(classifyJumiaRejection("The [MainImage] is mandatory and cannot be empty.").kind).toBe("seller");
  });

  // A rerun never reuses the old category code — it always re-derives one
  // from scratch — so a stale code self-heals the same way a too-broad
  // category does.
  it("reruns a category code that no longer resolves", () => {
    for (const msg of [
      "Category not found by Code [12345]",
      "Category Attribute Set not found using Category code 12345 and name Laptops",
    ]) {
      const r = classifyJumiaRejection(msg);
      expect(r.kind).toBe("rerun");
    }
  });

  // Different from the two above: this is about SIBLING variants under one
  // parentSku disagreeing, which a single-listing rerun has no visibility
  // into and could make worse, not better.
  it("sends a cross-variant category mismatch to the seller, not a rerun", () => {
    const r = classifyJumiaRejection("Selected primary category [Laptops] has a different attribute list than Category [Phones]. Please use the same category as the Product Set.");
    expect(r.kind).toBe("seller");
    expect(isAutoFixable(r.kind)).toBe(false);
  });

  it("never re-pushes a field Jumia has locked after approval", () => {
    const r = classifyJumiaRejection("The [Category] cannot be updated since the product has been already approved in at least one country.");
    expect(r.kind).toBe("seller");
  });

  it("points a shop-permission failure at reconnecting rather than editing the listing", () => {
    const r = classifyJumiaRejection("The user does not have permissions to the provided shop.");
    expect(r.kind).toBe("seller");
    expect(r.explanation).toMatch(/reconnect/i);
  });

  it("points a currency mismatch at reconnecting", () => {
    const r = classifyJumiaRejection("The submitted currency [USD] is different from the shop default currency [GHS]");
    expect(r.kind).toBe("seller");
  });

  it("never retries when Jumia's own attribute metadata is broken", () => {
    const r = classifyJumiaRejection("The attribute [warranty_period] is missing validations associated. Please contact the support");
    expect(r.kind).toBe("seller");
    expect(r.explanation).toMatch(/jumia/i);
  });

  it("still treats genuine attribute-value problems as rerunnable, including the unfilled {n} template shape", () => {
    for (const msg of [
      "Attribute [{0}] not found on payload",
      "The attribute [{0}] with the value [{1}] is a not valid number.",
      "The attribute [{0}] with the value [{1}] is a not valid number with decimal [{2}]",
      "The attribute [{0}] with the value [{1}] is a not valid number without decimals",
      "The attribute [{0}] with the value [{1}] should not be null or a negative value",
      "Attribute [{0}] should have a value with a length between [{1}] and [{2}].",
      "Attribute [{0}] with language [{1}] should have a value with a length between [{2}] and [{3}].",
      "The attribute [{0}] with value [{1}] should be in accordance to the format [{2}]",
      "Attribute [{0}] with value [{1}] should be a boolean.",
      // A restricted word INSIDE an attribute value (as opposed to the
      // product title) is genuinely rerunnable — Gemini regenerating that
      // one field's value has a real chance of avoiding the flagged word.
      "The Attribute [material] contains the restricted words : [banned_word];",
    ]) {
      const r = classifyJumiaRejection(msg);
      expect(r.kind).toBe("rerun");
    }
  });

  it("reruns a generic 'required field missing' rejection when it names the brand", () => {
    const r = classifyJumiaRejection("Required field [Product.Brand.Code] is missing or null.");
    expect(r.kind).toBe("rerun");
  });

  it("still hands an unrecognised named field to the seller", () => {
    const r = classifyJumiaRejection("Required field [Product.WarrantyAddress] is missing or null.");
    expect(r.kind).toBe("seller");
    expect(r.explanation.toLowerCase()).toContain("warrantyaddress");
  });

  it("treats a missing variation on the product itself as seller-owned", () => {
    // Not a schema attribute value — the product-level variation field.
    // Still falls through every specific rule to a safe default; assert
    // it is at least never wrongly promised a fix that can't apply here.
    const r = classifyJumiaRejection("The product [abc] does not have defined a valid variation.");
    expect(isAutoFixable(r.kind) ? r.kind !== "rerun" : true).toBe(true);
  });
});

describe("extractRejectedAttributeName", () => {
  it("pulls the attribute name from the live bracketed shape", () => {
    expect(extractRejectedAttributeName("Attribute [color_family] is not visible for category [Laptops].")).toBe("color_family");
    expect(extractRejectedAttributeName("The column [product_weight] is missing from the file.")).toBe("product_weight");
    expect(extractRejectedAttributeName("Attribute [material_family] with invalid value [Fabric].")).toBe("material_family");
    expect(extractRejectedAttributeName("The Attribute [material] contains the restricted words : [banned_word];")).toBe("material");
  });

  it("never matches the unfilled {n} template shape — there's no real name to scroll to", () => {
    expect(extractRejectedAttributeName("Attribute [{0}] not found on payload")).toBeNull();
    expect(extractRejectedAttributeName("The attribute [{0}] with the value [{1}] is a not valid number.")).toBeNull();
  });

  it("never matches a title/brand-name rejection — that field isn't in the schema form", () => {
    expect(extractRejectedAttributeName("Product name or translations [Red Nike Shoe] contains Brand name [Nike].")).toBeNull();
  });

  it("returns null for anything with no bracketed field at all", () => {
    expect(extractRejectedAttributeName("The Global Price should not be zero.")).toBeNull();
    expect(extractRejectedAttributeName(null)).toBeNull();
    expect(extractRejectedAttributeName(undefined)).toBeNull();
  });
});

describe("extractNotVisibleAttributeNames", () => {
  it("pulls every attribute name out of the live multi-attribute rejection, dropping the truncated trailing fragment", () => {
    const live = "Attribute [color_family] is not visible for category [Compact Refrigerators]. Attribute [main_material] is not visible for category [Compact Refrigerators]. Attribute [manufacturer_txt] is not visible for category [Compact Refrigerators]. Attribute [capacity_litres] is not visible for category [Compact Refrigerators]. Attribute [material_family] is not visible for category [Compact Refrigerators]. Attribute [note] is not visible for category [Compact Refrigerators]. Attribute [warranty_address]";
    expect(extractNotVisibleAttributeNames(live)).toEqual([
      "color_family",
      "main_material",
      "manufacturer_txt",
      "capacity_litres",
      "material_family",
      "note",
    ]);
  });

  it("returns a single name for a single-attribute rejection", () => {
    expect(extractNotVisibleAttributeNames("Attribute [color_family] is not visible for category [Laptops].")).toEqual(["color_family"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(extractNotVisibleAttributeNames("The column [product_weight] is missing from the file.")).toEqual([]);
    expect(extractNotVisibleAttributeNames(null)).toEqual([]);
    expect(extractNotVisibleAttributeNames(undefined)).toEqual([]);
  });
});

describe("extractRejectionText", () => {
  it("returns plain text unchanged", () => {
    expect(extractRejectionText("You can't list products in this category.")).toBe("You can't list products in this category.");
  });

  it("unwraps a JSON object down to its message field", () => {
    expect(extractRejectionText(JSON.stringify({ message: "Description too short." }))).toBe("Description too short.");
  });

  it("falls back through errorMessage, then error, then all of errors[] joined", () => {
    expect(extractRejectionText(JSON.stringify({ errorMessage: "A" }))).toBe("A");
    expect(extractRejectionText(JSON.stringify({ error: "B" }))).toBe("B");
    expect(extractRejectionText(JSON.stringify({ errors: ["C", "D"] }))).toBe("C | D");
  });

  it("prefers a single message/errorMessage/error field over errors[] even when both are present", () => {
    expect(extractRejectionText(JSON.stringify({ message: "Primary reason.", errors: ["C", "D"] }))).toBe("Primary reason.");
  });

  it("unwraps a JSON-encoded plain string", () => {
    expect(extractRejectionText(JSON.stringify("Just a string"))).toBe("Just a string");
  });

  it("falls back to the raw text when JSON parsing fails", () => {
    expect(extractRejectionText("not json at all")).toBe("not json at all");
  });

  it("stringifies the object when none of the known keys are present", () => {
    expect(extractRejectionText(JSON.stringify({ code: 42 }))).toBe(JSON.stringify({ code: 42 }));
  });

  it("returns empty string for null/undefined", () => {
    expect(extractRejectionText(null)).toBe("");
    expect(extractRejectionText(undefined)).toBe("");
  });
});

// Fix 4: real production loop (2026-09-17/18 chat log) — a category
// rejection kept getting "Fix & resubmit" -> redraft -> resubmit -> the
// IDENTICAL rejection, repeatedly for over an hour, with no message ever
// telling the seller automatic fixing wasn't working.
describe("rejectionFingerprint + shouldBlockRepeatedAutoFix", () => {
  const categoryMsg = "You can't list products in this category. Please choose a different (more specific) category and try again.";

  it("produces the same fingerprint for the same kind + rejection text", () => {
    const a = rejectionFingerprint("rerun", categoryMsg);
    const b = rejectionFingerprint("rerun", categoryMsg);
    expect(a).toBe(b);
  });

  it("produces a different fingerprint for a different rejection text", () => {
    const a = rejectionFingerprint("rerun", categoryMsg);
    const b = rejectionFingerprint("rerun", "Attribute [color_family] is not visible for category [Laptops].");
    expect(a).not.toBe(b);
  });

  it("does not block the first automatic attempt (no prior fingerprint yet)", () => {
    const fp = rejectionFingerprint("rerun", categoryMsg);
    expect(shouldBlockRepeatedAutoFix("rerun", fp, { fingerprint: null, count: 0 })).toBe(false);
  });

  it("blocks a second automatic attempt at the identical rejection shape", () => {
    const fp = rejectionFingerprint("rerun", categoryMsg);
    expect(shouldBlockRepeatedAutoFix("rerun", fp, { fingerprint: fp, count: 1 })).toBe(true);
  });

  it("does not block when the rejection changed shape since the last attempt", () => {
    const fp = rejectionFingerprint("rerun", categoryMsg);
    const priorFp = rejectionFingerprint("rerun", "Attribute [color_family] is not visible for category [Laptops].");
    expect(shouldBlockRepeatedAutoFix("rerun", fp, { fingerprint: priorFp, count: 1 })).toBe(false);
  });

  // Duplicate-SKU rejections are exempt: each attempt genuinely mints a
  // fresh SKU (pushListingToJumia's isRetry), so a second attempt is not
  // "the same fix repeating" the way a rerun is.
  it("never blocks a repush (duplicate SKU), even at the same fingerprint", () => {
    const fp = rejectionFingerprint("repush", "Jumia already has this SKU.");
    expect(shouldBlockRepeatedAutoFix("repush", fp, { fingerprint: fp, count: 5 })).toBe(false);
  });

  // not_visible_attributes is exempt for the same reason repush is: each
  // attempt removes the offending names from the cache before pushing
  // again, so a second attempt pushes a genuinely corrected schema, not a
  // repeat of the same guess.
  it("never blocks a not_visible_attributes fix, even at the same fingerprint", () => {
    const fp = rejectionFingerprint("not_visible_attributes", "Attribute [color_family] is not visible for category [Compact Refrigerators].");
    expect(shouldBlockRepeatedAutoFix("not_visible_attributes", fp, { fingerprint: fp, count: 5 })).toBe(false);
  });
});
