/**
 * Classify a Jumia rejection into something the system can act on.
 *
 * A rejection message used to be a dead end: the seller was told what
 * Jumia said ("The column [product_weight] is missing from the file") and
 * left to work out what that meant and where to fix it. Most of these
 * fall into a small number of shapes, and most of them the system can
 * genuinely repair on its own by re-running the draft.
 *
 * Deliberately conservative about what counts as auto-fixable. Telling a
 * seller "I fixed it" and re-pushing the same broken payload is worse than
 * telling them plainly that only they can supply the missing price.
 *
 * "Fixable by rerun" means calling runAutoAnalyze() again on the same
 * images (lib/actions/auto-analyze.ts) — the exact pipeline that drafted
 * the listing the first time, given the rejection reason as extra
 * context. That's a genuinely different (and much more capable) repair
 * than the single-purpose attribute refill this classifier used to be
 * scoped to: a full rerun re-derives title, description, category AND
 * dynamic_attributes from the images, so it can fix a title that repeats
 * the brand name, a category that turned out too broad, or a description
 * that was too short — not just an invalid attribute value.
 *
 * What a rerun categorically CANNOT do — because runAutoAnalyze never
 * touches these fields, by the same seller-owns-commercial-terms rule
 * this codebase applies everywhere else — is invent a price, a stock
 * count, a sale-price date, a barcode, or a re-uploaded image file. A
 * message about any of those stays "seller" no matter how much it
 * resembles something rerunnable: classifying it otherwise spends a
 * Gemini call and a push attempt on fields a rerun cannot change, then
 * fails identically and tells the seller "I fixed it" a moment before
 * proving it didn't. That shape — auto-fix promised, same rejection
 * returned — is worse for trust than saying up front that this one needs
 * them.
 *
 * Patterns below are matched against Jumia's actual wire shape: a
 * bracketed placeholder ([ ]) once the value is filled in. A few classes
 * of error (seen in Jumia's own API reference rather than a live
 * rejection yet) use an unfilled {0}/{1} template instead — matched the
 * same way, since the surrounding words are what identifies the error,
 * not what's inside the brackets.
 */

import { restrictedWordsInJumiaRejection } from "@/lib/ai/restricted-words";

export type RemedyKind =
  /** Worth a full re-draft (runAutoAnalyze) informed by the rejection —
   *  a bad title, an over-broad category, a short description, or a
   *  category-attribute value the schema rejects. */
  | "rerun"
  /** Every attribute Jumia complained about is "not visible for category"
   *  — our OWN cached schema is wrong (it lists an attribute Jumia's live
   *  validation doesn't accept for this category), not the listing. Fixed
   *  by removing exactly those attributes from the cache (see
   *  removeAttributesFromCache in lib/jumia/categories.ts) and pushing
   *  again — preflightAttributes already drops anything not in the
   *  schema, so no redraft is needed once the cache is corrected. */
  | "not_visible_attributes"
  /** Jumia already has this SKU. The push path generates a fresh suffix
   *  on the next attempt, so simply pushing again resolves it. */
  | "repush"
  /** Jumia named a banned word ("The Attribute [ description ] contains
   *  the restricted words : color may vary"). Recorded as a learned word
   *  (lib/jumia/learned-restricted-words.ts), which the pre-push check
   *  strips, so pushing again is the whole fix: no redraft. */
  | "restricted_words"
  /** Only the seller can supply this — a price, a barcode, a re-uploaded
   *  image. Never pretend to fix it. */
  | "seller"
  /** Unrecognised. Worth one automatic attempt (rerun + push) because
   *  attribute problems are by far the most common cause, but say so
   *  honestly rather than claiming to know. */
  | "unknown";

export interface Remedy {
  kind: RemedyKind;
  /** One line, addressed to the seller, in their terms rather than
   *  Jumia's. */
  explanation: string;
}

/**
 * True when, after stripping out every "Attribute [x] is not visible for
 * category [y]." complaint, nothing meaningful is left in the message —
 * i.e. the ENTIRE rejection is that one complaint repeated across several
 * attributes, not that complaint mixed with something else. A mixed
 * message (say, a not-visible attribute alongside an invalid price) means
 * more than a stale cache is wrong, so it should fall through to the
 * generic rerun bucket instead of being treated as a pure cache-correction
 * case.
 *
 * Tolerates one trailing fragment cut off anywhere inside the complaint
 * ("Attribute [warranty_address]", "Attribute [warranty_duration] is not
 * visi"): stored rejections were cut at 500 characters until 2026-10-01,
 * and a 13-attribute one for Educational Tablets was read as a mixed
 * message and redrafted, which can't help, instead of dropping the fields.
 */
function isEntirelyNotVisibleAttributeComplaints(msg: string): boolean {
  // The " | " between them is ours (refreshPendingFeedStatus joining
  // Jumia's error lists), not another complaint: left in, a rejection that
  // was nothing but these read as mixed and Fix redrafted the listing.
  const stripped = msg
    .replace(/attribute\s*\[\s*[^\]]+?\s*\]\s+is not visible for category\s*\[\s*[^\]]*\]\.?/gi, "")
    .replace(/\s*\|\s*/g, " ")
    .trim();
  return stripped === "" || isCutOffNotVisibleComplaint(stripped);
}

/** "Attribute [x" … "Attribute [x] is not visible for category [y": one complaint cut off before its end. */
function isCutOffNotVisibleComplaint(fragment: string): boolean {
  const m = /^attribute\s*\[\s*[^\]]*(?:\]\s*([\s\S]*))?$/i.exec(fragment);
  if (!m) return false;
  const rest = (m[1] ?? "").toLowerCase().replace(/\s+/g, " ").replace(/\.$/, "");
  const full = "is not visible for category [";
  return full.startsWith(rest) || (rest.startsWith(full) && !rest.includes("]"));
}

export function classifyJumiaRejection(raw: string | null | undefined): Remedy {
  const msg = (raw ?? "").toLowerCase();

  if (!msg.trim()) {
    return { kind: "unknown", explanation: "Jumia didn't say why." };
  }

  // ── Banned words, before the attribute bucket below, whose "the
  // attribute" test also matches this message. Classed there, a
  // 2026-09-29 rejection for "color may vary" was redrafted (the phrase
  // survived: it wasn't on our list) and rejected again, and the seller
  // was told "Some category fields Jumia wants are missing or invalid".
  const banned = restrictedWordsInJumiaRejection(raw);
  if (banned.length > 0) {
    const named = banned.map((w) => `"${w}"`).join(", ");
    return {
      kind: "restricted_words",
      explanation: `Jumia doesn't allow ${named} in listings — I'll take ${banned.length === 1 ? "it" : "them"} out and resubmit.`,
    };
  }

  // ── Duplicate VARIATION, checked before the generic duplicate/repush
  // rule below. "Duplicate Variation on Product with seller sku [x] and
  // Product set parent sku [y]" contains the word "duplicate", which would
  // otherwise be caught by the SKU-duplicate rule further down and
  // classified "repush" — but minting a fresh SKU suffix changes nothing
  // about which variation values collide. The seller has to give the two
  // variants different values (a size, a colour) before either can push.
  if (/duplicate variation/.test(msg)) {
    return { kind: "seller", explanation: "Two of the variants on this product have the same variation value (e.g. both marked the same size or colour) — Jumia needs them to differ." };
  }

  // ── Our OWN pre-push hold, not a Jumia rejection — see
  // resolveVariantRowVariation in lib/jumia/api.ts. A rerun redrafts the
  // whole listing from the photo, but the seller's own typed variation
  // value is exactly what didn't match the category's stocked options —
  // redrafting it again is the same guess, not a different one.
  if (/isn'?t one of this category'?s stocked options/.test(msg)) {
    return { kind: "seller", explanation: "The variation value isn't one of this category's stocked options — pick one of the ones listed, or use the editor to add a new option." };
  }

  // ── Jumia's OWN async rejection for the same problem the local hold
  // above exists to catch before push ever happens.
  //
  // Confirmed live (2026-09-19 batch, Baby Carrier): "Attribute [variation]
  // with invalid value [Navy Blue]." — the local check in
  // resolveVariantRowVariation didn't catch this one (the category's
  // variant-axis schema hadn't synced at push time), so it fell through to
  // the generic "Attribute [...]" pattern below and was misclassified
  // "rerun". That's wrong for the identical reason the local hold's own
  // branch above exists: runAutoAnalyze re-derives variant labels from the
  // SAME photos on every pass (see the variant-persist step in
  // lib/actions/auto-analyze.ts), so a rerun reproduces the same invalid
  // guess, not a different one. Checked before the generic attribute
  // pattern, and narrowly on the literal "variation" attribute name only —
  // "Attribute [color_family] with invalid value [...]" and similar stay
  // "rerun", since those ARE dynamic attributes a rerun regenerates fully.
  if (/attribute\s*\[\s*variation\s*\]\s*with invalid value/.test(msg)) {
    return { kind: "seller", explanation: "The variation value Jumia has isn't one of this category's stocked options — pick one of the ones listed, or use the editor to add a new option." };
  }

  // ── The product's name/title — a rerun rewrites this from scratch ─────
  //
  // runAutoAnalyze regenerates the title on every pass, so a rejection
  // about what the CURRENT title says is exactly the shape a fresh draft
  // fixes — as long as the rerun is told what went wrong (see
  // buildRerunContext in lib/whatsapp/intake.ts), so it doesn't just
  // regenerate the identical mistake.
  if (/product name.{0,40}(contains|has).{0,10}(brand|seller|company) name/.test(msg)
    || /product name.{0,40}prohibited character/.test(msg)) {
    return { kind: "rerun", explanation: "The title repeats the brand, seller or company name (or uses a blocked character) — redrafting the title should clear this." };
  }
  if (/trademark.{0,80}protected.{0,80}brand/.test(msg)) {
    return { kind: "rerun", explanation: "Jumia sees a trademarked term without a matching brand — redrafting should set the brand correctly or reword the title." };
  }

  // ── Brand banned for this shop's country ────────────────────────────────
  //
  // Real rejection: "You're not allowed to sell this brand in Ghana." This
  // is a country-level sell-ban Jumia enforces on their side — distinct
  // from checkRestrictedBrand's own brand×category FORBIDDEN/QC matrix
  // (lib/jumia/prohibited-catalog.ts), which has no entry for it. Without
  // this branch the message fell through to "unknown", which IS
  // auto-fixable — so a rerun (which never touches the brand a seller
  // actually has) kept redrafting and resubmitting the same forbidden
  // brand, wasting a push every time.
  if (/not allowed to sell this brand/.test(msg)) {
    return { kind: "seller", explanation: "Jumia doesn't allow this brand to be sold in this shop's country — a redraft can't change that; use a different brand or check with Jumia support." };
  }

  if (/description/.test(msg) && /(short|50|length|characters)/.test(msg)) {
    return { kind: "rerun", explanation: "The description was too short for Jumia — redrafting will write a longer one." };
  }
  // "You can't list products in this category" is checked here — before
  // "category not found" further down — because it's about the SAME
  // category still resolving but being too broad, whereas "not found"
  // means the code itself is stale. Both are rerunnable (a fresh
  // category pick either way), but kept as separate branches since they
  // read differently to a seller watching the messages go by.
  if (/can'?t list products in this category|more specific|leaf/.test(msg)) {
    return { kind: "rerun", explanation: "Jumia won't accept this category — redrafting will pick a more specific one." };
  }

  // ── Price, stock: seller-owned everywhere else in this codebase ───────
  //
  // "mandatory" is Jumia's own word for several of these ("The initial
  // Stock is mandatory...", "The Global Price is mandatory...") and
  // doesn't overlap with "required|missing|invalid|must" at all — a real
  // gap that let both fall through to "unknown" and waste an automatic
  // rerun+resubmit cycle that could never have supplied a price or a
  // stock count either way — runAutoAnalyze never touches either field.
  if (/\bprice\b/.test(msg) && /(required|missing|invalid|must|mandatory)/.test(msg)) {
    return { kind: "seller", explanation: "Jumia needs a price on this product, and I never set prices myself." };
  }
  if (/\bstock\b/.test(msg) && /(required|missing|invalid|must|mandatory)/.test(msg)) {
    return { kind: "seller", explanation: "Jumia needs a stock quantity on this product, and I never set stock myself." };
  }

  // ── Sale price / global price business rules ───────────────────────────
  //
  // All genuinely seller decisions — a date range, a discount, a currency
  // choice. None of them are fields runAutoAnalyze sets, so none are
  // rerunnable.
  if (/(global )?sale price/.test(msg) && /(startat|endat|before|after|bigger than the current date)/.test(msg)) {
    return { kind: "seller", explanation: "The sale price's start/end dates don't work — they need to be in the future, and the start date has to come before the end date." };
  }
  if (/(global )?sale price discount/.test(msg)) {
    return { kind: "seller", explanation: "The sale discount is outside what Jumia allows for this category — adjust the sale price." };
  }
  if (/(global )?sale price/.test(msg) && /(zero|negative|two decimal|greater than or equal price)/.test(msg)) {
    return { kind: "seller", explanation: "The sale price itself isn't valid — it must be positive, less than the regular price, and have at most two decimal places." };
  }
  if (/(startat|endat) is mandatory when sale price is filled/.test(msg)) {
    return { kind: "seller", explanation: "A sale price needs both a start and an end date." };
  }
  if (/(global )?price\b.{0,60}(equal or more than|equal or less than|two decimal|negative|should not be zero)/.test(msg)) {
    return { kind: "seller", explanation: "The price itself isn't valid for this category — check Jumia's price limits, decimal places, and that it isn't zero or negative." };
  }

  // ── Barcode / GTIN ──────────────────────────────────────────────────────
  if (/barcode ean.{0,40}already exists/.test(msg)) {
    return { kind: "seller", explanation: "That barcode (EAN/GTIN) is already used by another product on Jumia — remove it or use the correct one." };
  }

  // ── Images ──────────────────────────────────────────────────────────────
  //
  // A rerun can't fix a FILE — it drafts text and attributes from the
  // images already uploaded, it doesn't re-upload or re-encode them.
  if (/main ?image.{0,20}(mandatory|cannot be empty)/.test(msg)) {
    return { kind: "seller", explanation: "This product has no main image — Jumia won't accept a listing without one." };
  }
  if (/image/.test(msg) && /extension.{0,20}not allowed/.test(msg)) {
    return { kind: "seller", explanation: "One of the images is in a format Jumia doesn't accept — re-save it as JPEG or PNG and re-upload." };
  }
  if (/image/.test(msg) && /dimensions?.{0,80}(height|width)/.test(msg)) {
    return { kind: "seller", explanation: "One of the images is outside Jumia's size range (200-3000px on each side) — resize it and re-upload." };
  }
  if (/(image|photo)/.test(msg) && /(invalid|size|resolution|missing|failed|timeout|should be a link|invalid link)/.test(msg)) {
    return { kind: "seller", explanation: "Jumia rejected the images — they may need re-uploading." };
  }

  // ── A category code that no longer resolves ────────────────────────────
  //
  // Different from "too broad" above: the stored code itself is stale
  // (deleted, renumbered). A rerun never reuses the old code — it always
  // re-derives a category from scratch — so this self-heals the same way.
  //
  // The Product-Set / cross-variant case is kept separate and NOT
  // rerunnable: "Selected primary category has a different attribute list
  // than Category X — use the same category as the Product Set" is about
  // this listing's SIBLING variants under one parentSku, which
  // runAutoAnalyze has no visibility into. Rerunning this listing alone
  // could pick a category that disagrees with its siblings even more,
  // not less — that one needs a human coordinating across the set.
  if (isStaleCategoryError(msg)) {
    return { kind: "rerun", explanation: "Jumia doesn't recognise this product's category anymore — redrafting will pick a live one." };
  }
  if (/(attribute list than category|use the same category as the product set)/.test(msg)) {
    return { kind: "seller", explanation: "This product's category doesn't match its sibling variants — they need to share one category, which needs you to coordinate across the set." };
  }

  // ── Locked after approval ───────────────────────────────────────────────
  if (/cannot be updated since the product has been already approved/.test(msg)) {
    return { kind: "seller", explanation: "This field is locked because the product has already been approved on Jumia at least once — that can't be changed by re-pushing." };
  }

  // ── Shop-level / connection problems, not this listing's content ──────
  if (/does not have permissions to the provided shop/.test(msg)) {
    return { kind: "seller", explanation: "Jumia says this account doesn't have permission for this shop — try disconnecting and reconnecting Jumia from Settings." };
  }
  if (/submitted currency.{0,40}different from the shop default currency/.test(msg)) {
    return { kind: "seller", explanation: "This product's price is in the wrong currency for this shop — reconnecting Jumia usually fixes a stale currency setting." };
  }

  // ── Jumia's own configuration, not this listing at all ─────────────────
  //
  // Jumia's own wording ("Please contact the support team", "missing
  // validations associated") says this isn't about the payload — it's
  // their attribute-set metadata. Resubmitting, rerunning, or editing
  // anything on our side fails identically every time.
  if (/missing validations associated/.test(msg)) {
    return { kind: "seller", explanation: "Jumia's own setup for this attribute looks broken on their side — this needs Jumia seller support, not an edit here." };
  }

  // ── Duplicate SKU: the one case a blind re-push actually fixes ────────
  //
  // Checked after duplicate-variation above, and before the general
  // attribute pattern below (which would otherwise catch "already
  // exists" text near the word "sku" too aggressively).
  if (/duplicate|already exists|sku.*(taken|exists)/.test(msg)) {
    return { kind: "repush", explanation: "Jumia already has this SKU. Pushing again generates a fresh one." };
  }

  // ── A named top-level field, generically ────────────────────────────────
  //
  // "Required field [Product.Brand.Code] is missing or null." Checked
  // BEFORE the attribute pattern below — it also contains "required" and
  // "missing", and would otherwise be misread as a rerunnable
  // dynamic_attributes problem. Brand IS something a rerun sets (it's
  // part of every draft pass), so a path naming it gets a rerun; any
  // other top-level field a rerun doesn't touch stays seller-owned.
  const namedField = msg.match(/required field \[([\w.]+)\] is missing or null/);
  if (namedField) {
    if (/brand/i.test(namedField[1])) {
      return { kind: "rerun", explanation: "The brand wasn't resolved to something Jumia recognises — redrafting will try again." };
    }
    const field = namedField[1].split(".").pop() ?? namedField[1];
    return { kind: "seller", explanation: `Jumia needs ${field.toLowerCase()} set on this product — that's not something a redraft can supply.` };
  }

  // ── Every complaint is "not visible for category" — OUR cache is wrong ──
  //
  // Checked before the generic attribute-problems bucket below, which
  // would otherwise also match "is not visible for category" and send
  // this down a rerun. A rerun can't fix this: runAutoAnalyze just refills
  // the same attribute with a new value, and Jumia rejects it again for
  // the same reason — the attribute isn't rejected because of what value
  // it holds, it's rejected because our cached schema says this category
  // accepts an attribute that Jumia's real per-category validation
  // doesn't. Confirmed live, 2026-09-21 (category 1022994, "Compact
  // Refrigerators" — checked directly against Jumia's own Vendor Center
  // form): "Attribute [color_family] is not visible for category [Compact
  // Refrigerators]. Attribute [main_material] is not visible for category
  // [Compact Refrigerators]. ..." repeated across seven attributes.
  // Removing exactly those attributes from the cache (see
  // removeAttributesFromCache in lib/jumia/categories.ts) and pushing
  // again is what actually clears it — preflightAttributes already drops
  // anything not in the schema, so no redraft is needed once the cache is
  // corrected. A message that mixes this complaint with a different kind
  // of problem falls through to the generic rerun bucket instead, since
  // that mix means something beyond a stale cache is also wrong.
  if (/is not visible for category/.test(msg) && isEntirelyNotVisibleAttributeComplaints(msg)) {
    return {
      kind: "not_visible_attributes",
      explanation: "Some of this category's fields aren't actually usable there — I'll remove them and resubmit.",
    };
  }

  // ── Attribute problems — the common, genuinely fixable case ────────────
  //
  // Matches both the bracketed live shape ("Attribute [x] is not visible
  // for category [y]") and the unfilled template shape ("Attribute [{0}]
  // ... value [{1}] ...") — the word before the bracket/brace is what
  // identifies these, not what's inside it.
  if (
    /column\s*[\[{]/.test(msg) ||
    /attribute\s*[\[{]/.test(msg) ||
    /the attribute\b/.test(msg) ||
    /is not visible for category/.test(msg) ||
    /invalid value/.test(msg) ||
    /not found on payload/.test(msg) ||
    /(not a valid number|should be a boolean|should be in accordance to the format)/.test(msg) ||
    /should have a value with a length between/.test(msg) ||
    (/missing/.test(msg) && /(field|attribute|column)/.test(msg)) ||
    /required/.test(msg)
  ) {
    return { kind: "rerun", explanation: "Some category fields Jumia wants are missing or invalid." };
  }

  return { kind: "unknown", explanation: "I'm not certain what Jumia objected to." };
}

/** True when the system should attempt an automatic repair rather than
 *  handing straight back to the seller. */
export function isAutoFixable(kind: RemedyKind): boolean {
  return kind === "rerun" || kind === "not_visible_attributes" || kind === "repush" || kind === "restricted_words" || kind === "unknown";
}

/**
 * Jumia no longer recognises the listing's category code at all (deleted
 * or renumbered) — as opposed to refusing a category that still exists.
 * Any redraft has to re-pick, even a category the seller chose.
 */
export function isStaleCategoryError(raw: string | null | undefined): boolean {
  return /category not found by code|category attribute set not found/i.test(raw ?? "");
}

/**
 * A stable identifier for "this listing got this same rejection" — cheap
 * enough to store on the listing row and compare on the next Fix & resubmit
 * tap, so a rerun that changes nothing can be told apart from a genuinely
 * new problem. Kind is included because the same rejection text should
 * never realistically map to two kinds, but keeping it explicit costs
 * nothing and documents the intent.
 */
export function rejectionFingerprint(kind: RemedyKind, rejectionText: string): string {
  const normalized = rejectionText.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
  return `${kind}:${normalized}`;
}

/**
 * Should THIS automatic-repair attempt be refused because it would just
 * repeat one that already failed?
 *
 * Real production loop (2026-09-17/18 chat log): a category rejection on
 * the same listing got "Fix & resubmit" tapped, redrafted, and rejected
 * again with the identical "You can't list products in this category"
 * message — repeatedly, over more than an hour, without ever telling the
 * seller that automatic fixing wasn't working. Capping this to one attempt
 * per fingerprint before handing back to the seller is what closes it.
 *
 * "repush" is exempt: a duplicate-SKU rejection is resolved by a genuinely
 * fresh SKU each attempt (see pushListingToJumia's isRetry), so a second
 * attempt is not "the same fix repeating" the way a rerun is. "not_visible_
 * attributes" is exempt for the same reason: each attempt removes the
 * offending names from the cache before pushing again, so a second attempt
 * pushes a genuinely corrected schema, not a repeat of the same guess.
 */
export function shouldBlockRepeatedAutoFix(
  kind:  RemedyKind,
  fingerprint: string,
  prior: { fingerprint: string | null; count: number },
): boolean {
  if (kind === "repush" || kind === "not_visible_attributes") return false;
  return prior.fingerprint === fingerprint && prior.count >= 1;
}

/**
 * Pull the specific schema attribute name out of a Jumia rejection, when
 * it names one — "Attribute [color_family] is not visible for category
 * [Laptops]." → "color_family".
 *
 * Powers "See Rejected Field" on the review page: rather than leaving the
 * seller to scan a form that can run to dozens of fields for whichever one
 * Jumia meant, the button jumps straight to it.
 *
 * Deliberately narrow. Matches only the live wire shape — a real,
 * filled-in bracket right after "attribute" or "column" — never the
 * unfilled {0}/{1} template shape some of Jumia's docs use, which carries
 * no real field name to scroll to. And it never matches a Product-Name/
 * title rejection: that field lives in the title input, not this schema,
 * so a name pulled from "Product name...contains Brand name" would send
 * the seller to a form field that was never the problem.
 */
export function extractRejectedAttributeName(raw: string | null | undefined): string | null {
  const msg = raw ?? "";
  const match = msg.match(/\b(?:attribute|column)\s*\[\s*([^\]]+?)\s*\]/i);
  const name = match?.[1] ?? null;
  // An unfilled template placeholder ("[{0}]") is not a real name.
  if (name && /^\{.*\}$/.test(name)) return null;
  return name;
}

/**
 * Pull EVERY attribute name out of a "not visible for category" rejection
 * — unlike extractRejectedAttributeName above, which only ever returns the
 * first match (built for "jump to this one field on the review page"),
 * this powers removeAttributesFromCache, which needs the complete set
 * Jumia complained about in one rejection so it can correct the cache in
 * one pass rather than one automatic-repair cycle per attribute.
 *
 * A trailing truncated fragment ("Attribute [warranty_address]" with no
 * closing "is not visible..." clause) never completes the pattern and is
 * silently dropped — there's no confirmed category name to act on for it.
 */
export function extractNotVisibleAttributeNames(raw: string | null | undefined): string[] {
  const msg = raw ?? "";
  const re = /attribute\s*\[\s*([^\]]+?)\s*\]\s+is not visible for category/gi;
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(msg)) !== null) {
    // Once each: a stored rejection can repeat its complaints (" | ").
    if (!names.includes(match[1])) names.push(match[1]);
  }
  // A last complaint cut off when the message was stored, once its clause
  // has begun ("Attribute [warranty_duration] is not visi"): its name counts
  // too. A bare "Attribute [x]" could be any complaint, so it doesn't.
  const tail = msg
    .replace(/attribute\s*\[\s*[^\]]+?\s*\]\s+is not visible for category\s*\[\s*[^\]]*\]\.?/gi, "")
    .trim();
  const cutName = /^attribute\s*\[\s*([^\]]+?)\s*\]\s+is\b/i.exec(tail)?.[1];
  if (names.length > 0 && cutName && isCutOffNotVisibleComplaint(tail) && !names.includes(cutName)) names.push(cutName);
  return names;
}

/**
 * Reduce a stored jumia_error value to plain, human-readable text.
 *
 * The column holds a JSON-stringified Jumia error object most of the
 * time, but plain text is also possible depending on which push path
 * wrote it (see lib/jumia/push-listing.ts). classifyJumiaRejection's own
 * regexes tolerate either shape well enough (the JSON's punctuation
 * rarely breaks a keyword match), but anything that hands this text
 * onward — a rerun's AI prompt, a seller-facing message — needs the
 * clean form, not a blob of braces and quotes.
 *
 * A rejected feed can carry several distinct problems in one `errors[]`
 * array (a variation value AND a decimal capacity, say) — joining all of
 * them, rather than only `errors[0]`, is what lets a rerun's AI prompt and
 * a seller-facing message address everything Jumia reported instead of
 * one reason at a time.
 */
export function extractRejectionText(raw: string | null | undefined): string {
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    const single = [parsed?.message, parsed?.errorMessage, parsed?.error].find(
      (c) => typeof c === "string",
    );
    if (typeof single === "string") return single;
    if (Array.isArray(parsed?.errors)) {
      const joined = parsed.errors.filter((e: unknown) => typeof e === "string").join(" | ");
      if (joined) return joined;
    }
    return JSON.stringify(parsed);
  } catch {
    return raw;
  }
}
