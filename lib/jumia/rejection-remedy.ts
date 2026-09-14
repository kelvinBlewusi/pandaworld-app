/**
 * Classify a Jumia rejection into something the system can act on.
 *
 * A rejection message used to be a dead end: the seller was told what
 * Jumia said ("The column [product_weight] is missing from the file") and
 * left to work out what that meant and where to fix it. Most of these
 * fall into a small number of shapes, and one of them the system can
 * genuinely repair on its own.
 *
 * Deliberately conservative about what counts as auto-fixable. Telling a
 * seller "I fixed it" and re-pushing the same broken payload is worse than
 * telling them plainly that only they can supply the missing price.
 */

export type RemedyKind =
  /** Category attributes are missing or invalid — re-filling the schema
   *  from the category and pushing again is a real fix. */
  | "refill"
  /** Jumia already has this SKU. The push path generates a fresh suffix
   *  on the next attempt, so simply pushing again resolves it. */
  | "repush"
  /** Only the seller can supply this — a price, a longer description, a
   *  more specific category. Never pretend to fix it. */
  | "seller"
  /** Unrecognised. Worth one automatic attempt (refill + push) because
   *  attribute problems are by far the most common cause, but say so
   *  honestly rather than claiming to know. */
  | "unknown";

export interface Remedy {
  kind: RemedyKind;
  /** One line, addressed to the seller, in their terms rather than
   *  Jumia's. */
  explanation: string;
}

export function classifyJumiaRejection(raw: string | null | undefined): Remedy {
  const msg = (raw ?? "").toLowerCase();

  if (!msg.trim()) {
    return { kind: "unknown", explanation: "Jumia didn't say why." };
  }

  // Seller-only problems first: these must never be misread as fixable,
  // because an automatic re-push would just fail again and burn a cycle.
  if (/price/.test(msg) && /(required|missing|invalid|must)/.test(msg)) {
    return { kind: "seller", explanation: "Jumia needs a price on this product, and I never set prices myself." };
  }
  if (/description/.test(msg) && /(short|50|length|characters)/.test(msg)) {
    return { kind: "seller", explanation: "The description is too short for Jumia — it needs at least 50 characters." };
  }
  if (/can'?t list products in this category|more specific|leaf/.test(msg)) {
    return { kind: "seller", explanation: "Jumia won't accept this category — it needs a more specific one." };
  }
  if (/image|photo/.test(msg) && /(invalid|size|resolution|missing|failed)/.test(msg)) {
    return { kind: "seller", explanation: "Jumia rejected the images — they may need re-uploading." };
  }

  if (/duplicate|already exists|sku.*(taken|exists)/.test(msg)) {
    return { kind: "repush", explanation: "Jumia already has this SKU. Pushing again generates a fresh one." };
  }

  // Attribute problems — the common, genuinely fixable case. Matches both
  // "The column [product_weight] is missing from the file" and
  // "Attribute [x] is not visible for category [y]" and invalid enums.
  if (
    /column \[/.test(msg) ||
    /attribute \[/.test(msg) ||
    /is not visible for category/.test(msg) ||
    /invalid value/.test(msg) ||
    (/missing/.test(msg) && /(field|attribute|column)/.test(msg)) ||
    /required/.test(msg)
  ) {
    return { kind: "refill", explanation: "Some category fields Jumia wants are missing or invalid." };
  }

  return { kind: "unknown", explanation: "I'm not certain what Jumia objected to." };
}

/** True when the system should attempt an automatic repair rather than
 *  handing straight back to the seller. */
export function isAutoFixable(kind: RemedyKind): boolean {
  return kind === "refill" || kind === "repush" || kind === "unknown";
}
