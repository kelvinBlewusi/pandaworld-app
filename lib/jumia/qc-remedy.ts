/**
 * What to do about a listing Jumia's quality check rejected.
 *
 * Upload errors have fixed, technical wording, and lib/jumia/rejection-
 * remedy.ts reads them. QC rejections are a reviewer's (or Jumia's AI's)
 * reason and comment, and that classifier reads every one as "unknown",
 * whose only answer is a redraft: no use for a missing FDA number, a
 * banned brand or blurry photos. So QC rejections are decided here:
 *
 *   1. A table of Jumia's known reasons (qcActionFromTable): its reason
 *      list (Poor Quality, Image Corrupt, Brand Banned, Wrong Image,
 *      Product Pricing, Wrong Description, Wrong Title, Wrong Brand) plus
 *      what production has shown (Wrong Category with a suggested
 *      category, a Health/Food Regulation Registration Number, "Other
 *      Reason" with nothing said).
 *   2. Anything else goes to the AI (qcActionFromAi), which picks one of
 *      the same actions.
 *
 * The actions only ever fix what we can fix (a redraft, a category Jumia
 * named) and ask the seller for what only they know (an FDA number, the
 * real brand, a price, new photos, the reason itself). Nothing here
 * invents a seller's facts.
 */

import { callGeminiBackend } from "@/lib/ai/gemini-client";
import { jumiaSuggestedCategoryPath } from "@/lib/jumia/qc-followup";

export type QcAction =
  /** Jumia named the category it wants. */
  | { kind: "switch_category"; path: string }
  /** The category is wrong but Jumia didn't say which: ask the seller. */
  | { kind: "ask_category" }
  /** Something only the seller has, for one of the category's fields (an
   *  FDA number, a certificate). field is null when the category has no
   *  such field; the answer then goes in the description. */
  | { kind: "ask_value"; field: string | null; fieldLabel: string; question: string }
  | { kind: "ask_brand"; why: string }
  | { kind: "ask_price"; why: string }
  | { kind: "ask_photos"; why: string }
  /** Jumia gave no reason: ask the seller to paste Vendor Center's. */
  | { kind: "ask_details" }
  /** Title, description or attributes: a redraft can fix it. */
  | { kind: "redraft"; why: string }
  /** Nothing anyone can change on the listing fixes it. */
  | { kind: "cannot_fix"; why: string };

export interface QcContext {
  reason:       string | null;
  comment:      string | null;
  title:        string | null;
  brand:        string | null;
  categoryPath: string | null;
  /** The listing's category fields, from jumia_category_attributes. */
  fields:       { name: string; label: string | null }[];
}

/** Jumia's words with its empty placeholders dropped. */
function said(ctx: Pick<QcContext, "reason" | "comment">): { reason: string | null; comment: string | null } {
  const reason = ctx.reason?.trim() && !/^other reasons?$/i.test(ctx.reason.trim()) ? ctx.reason.trim() : null;
  const comment = ctx.comment?.trim() && !/^rejected\.?$/i.test(ctx.comment.trim()) ? ctx.comment.trim() : null;
  return { reason, comment };
}

/** "Wrong Brand: the logo shows Nivea" → " (Wrong Brand: the logo shows Nivea)". */
function because(ctx: Pick<QcContext, "reason" | "comment">): string {
  const { reason, comment } = said(ctx);
  const text = [reason, comment].filter(Boolean).join(": ");
  return text ? ` (${text})` : "";
}

const REGULATORY_RE = /\b(fda|fdb|nafdac|kebs|gsa|regulat\w*|registration (?:number|no)|reg\.? ?no|certificat\w*|licen[cs]e\w*)\b/i;

/** The category field the seller's answer belongs in, for a regulatory ask. */
function regulatoryField(fields: QcContext["fields"], text: string): { field: string | null; fieldLabel: string } {
  const find = (re: RegExp) => fields.find((f) => re.test(f.name) || re.test(f.label ?? ""));
  const wantsCert = /certificat/i.test(text) && !/fda|registration|regulat/i.test(text);
  const hit = wantsCert
    ? find(/certif/i)
    : find(/\bfda\b|^fda$/i) ?? find(/regist/i) ?? find(/licen/i) ?? find(/certif/i);
  if (hit) return { field: hit.name, fieldLabel: hit.label ?? hit.name };
  return { field: null, fieldLabel: wantsCert ? "Certification" : "FDA registration number" };
}

/**
 * The known reasons. Null when none matches, for the AI to decide.
 * Order matters: the most specific signals first.
 */
export function qcActionFromTable(ctx: QcContext): QcAction | null {
  const { reason, comment } = said(ctx);
  const suggested = jumiaSuggestedCategoryPath(comment) ?? jumiaSuggestedCategoryPath(reason);
  if (suggested) return { kind: "switch_category", path: suggested };
  if (!reason && !comment) return { kind: "ask_details" };

  const text = [reason, comment].filter(Boolean).join(" — ");
  const why = because(ctx);

  if (/prohibit|not (?:allowed|permitted) (?:to be )?(?:sold|listed|on jumia)|illegal|forbidden product|banned product/i.test(text)) {
    return { kind: "cannot_fix", why: `Jumia doesn't allow this product to be sold on its site${why}.` };
  }
  if (REGULATORY_RE.test(text)) {
    const { field, fieldLabel } = regulatoryField(ctx.fields, text);
    const isFda = /fda|fdb|nafdac|registration|regulat/i.test(text);
    return {
      kind: "ask_value",
      field,
      fieldLabel,
      question: isFda
        ? "What is the product's FDA registration number? It's usually printed on the pack or label."
        : `Jumia's quality check asks for: ${comment ?? reason}. What should I put?`,
    };
  }
  if (/(?:banned|restricted|unauthori[sz]ed|blocked) brand|brand (?:is )?(?:banned|restricted|blocked|not allowed|not authori[sz]ed)/i.test(text)) {
    return {
      kind: "cannot_fix",
      why: `Jumia doesn't let your shop sell this brand${why}. If you're an authorised seller of it, Jumia seller support can turn it on for your shop.`,
    };
  }
  if (/counterfeit|replica|\bfake\b|knock-?off|imitation/i.test(text)) {
    return {
      kind: "cannot_fix",
      why: `Jumia's quality check thinks this may not be genuine${why}. Only genuine products can be listed. If it is genuine, Jumia seller support can review it with your proof of purchase.`,
    };
  }
  if (/duplicate|already (?:exists|listed|on jumia)|same product/i.test(text)) {
    return {
      kind: "cannot_fix",
      why: `Jumia already has this product${why}, and it allows one listing per product, so it can't be added again as new.`,
    };
  }
  if (/brand/i.test(text)) return { kind: "ask_brand", why };
  if (/image|photo|picture|watermark|blur|resolution|background|pixel|corrupt|copyright|stock photo|poor quality/i.test(text)) {
    return { kind: "ask_photos", why };
  }
  if (/pric/i.test(text)) return { kind: "ask_price", why };
  if (/categor/i.test(text)) return { kind: "ask_category" };
  if (/title|\bname\b|description|highlight|spelling|grammar|content|information|incomplete|missing|specification|attribute|detail|dimension|weight|\bsize\b|colou?r|variation|keyword/i.test(text)) {
    return { kind: "redraft", why: `Jumia's quality check flagged the listing's details${why}.` };
  }
  return null;
}

// The same small, cheap model family the chat-intent fallback uses
// (lib/whatsapp/intent.ts), one step up for reading a reviewer's reason.
const INTERPRET_MODEL = "gemini-2.5-flash";

const AI_KINDS = new Set(["redraft", "ask_value", "ask_brand", "ask_price", "ask_photos", "ask_category", "ask_details", "cannot_fix"]);

/**
 * The AI's reading of a reason the table doesn't know. Null when it fails
 * or answers with something unusable.
 */
export async function qcActionFromAi(ctx: QcContext): Promise<QcAction | null> {
  const { reason, comment } = said(ctx);
  const fieldList = ctx.fields.slice(0, 80).map((f) => `${f.name}${f.label && f.label !== f.name ? ` (${f.label})` : ""}`).join(", ");
  const clip = (s: string | null, n: number) => (s ?? "").replace(/"/g, "'").slice(0, n);
  const prompt = [
    "Jumia's quality check rejected a seller's product listing. Decide the ONE action that fixes it.",
    "",
    `Rejection reason: "${clip(reason, 200) || "(none)"}"`,
    `Rejection comment: "${clip(comment, 800) || "(none)"}"`,
    `Listing title: "${clip(ctx.title, 200)}"`,
    `Brand: "${clip(ctx.brand, 80)}"`,
    `Category: "${clip(ctx.categoryPath, 200)}"`,
    `Category fields: ${fieldList || "(unknown)"}`,
    "",
    "Actions (reply with exactly one JSON object):",
    '{"action":"redraft","why":"..."} - an AI rewrite of the title, description or attributes fixes it',
    '{"action":"ask_value","field":"<one of the category fields, or null>","fieldLabel":"...","question":"<question to the seller>"} - only the seller has a fact Jumia wants (a registration number, a certificate, a measurement)',
    '{"action":"ask_brand","why":"..."} - the brand is wrong or missing; ask the seller for the real brand',
    '{"action":"ask_price","why":"..."} - the price is the problem; ask the seller for a new one',
    '{"action":"ask_photos","why":"..."} - the photos are the problem; ask for new ones',
    '{"action":"ask_category"} - the category is wrong and Jumia did not say which is right',
    '{"action":"ask_details"} - the rejection says too little to act on',
    '{"action":"cannot_fix","why":"..."} - no change to the listing can fix it (prohibited product, banned brand, counterfeit, duplicate)',
    "",
    "Never choose redraft for a fact only the seller knows. Write why/question in plain, short English for the seller.",
    "Reply with ONLY the JSON object, no markdown.",
  ].join("\n");

  try {
    const { text: raw } = await callGeminiBackend(INTERPRET_MODEL, [{ text: prompt }]);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const p = JSON.parse(match[0]) as Record<string, unknown>;
    const action = typeof p.action === "string" ? p.action : "";
    if (!AI_KINDS.has(action)) return null;
    const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 300) : null);
    const why = str(p.why) ? ` (${str(p.why)})` : because(ctx);

    switch (action) {
      case "redraft":      return { kind: "redraft", why: `Jumia's quality check flagged the listing${why}.` };
      case "ask_brand":    return { kind: "ask_brand", why };
      case "ask_price":    return { kind: "ask_price", why };
      case "ask_photos":   return { kind: "ask_photos", why };
      case "ask_category": return { kind: "ask_category" };
      case "ask_details":  return { kind: "ask_details" };
      case "cannot_fix":   return { kind: "cannot_fix", why: str(p.why) ?? `Jumia's quality check rejected it${because(ctx)}, and no change to the listing can fix that.` };
      case "ask_value": {
        const question = str(p.question);
        if (!question) return null;
        const named = str(p.field);
        const field = named ? ctx.fields.find((f) => f.name === named) ?? null : null;
        return {
          kind: "ask_value",
          field: field?.name ?? null,
          fieldLabel: field?.label ?? str(p.fieldLabel) ?? named ?? "Detail",
          question,
        };
      }
    }
    return null;
  } catch (e) {
    console.warn(`[qc-remedy] AI interpretation failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * The action for a QC rejection: the table first, then the AI, then a
 * redraft (what every QC rejection got before this existed, one attempt).
 */
export async function decideQcAction(ctx: QcContext): Promise<{ action: QcAction; source: "table" | "ai" | "fallback" }> {
  const known = qcActionFromTable(ctx);
  if (known) return { action: known, source: "table" };
  const ai = await qcActionFromAi(ctx);
  if (ai) return { action: ai, source: "ai" };
  return { action: { kind: "redraft", why: `Jumia's quality check rejected it${because(ctx)}.` }, source: "fallback" };
}
