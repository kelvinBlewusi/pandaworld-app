/**
 * Listing quality score — pure function, 0–100.
 *
 * Configure the publish gate via env: NEXT_PUBLIC_QUALITY_THRESHOLD (default 60).
 * Call calculateQualityScore() anywhere; it has no side effects.
 */

import type { ListingRow } from "@/lib/supabase/types";
import type { JumiaCategoryAttribute } from "@/lib/jumia/categories";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface QualityBreakdown {
  score:              number;   // 0–100 overall
  requiredFields:     number;   // % of required fields filled (weight 40)
  contentLength:      number;   // description + highlights length score (weight 20)
  imageCount:         number;   // images score (weight 20)
  variantCoverage:    number;   // has variants with price/qty (weight 10)
  specifications:     number;   // weight, dimensions, material (weight 10)
  issues:             string[]; // human-readable reasons for deductions
}

// ─── Configurable threshold ───────────────────────────────────────────────────

export const DEFAULT_THRESHOLD = 60;

export function getPublishThreshold(): number {
  const raw = typeof window !== "undefined"
    ? undefined
    : process.env.QUALITY_SCORE_MIN;
  return raw ? parseInt(raw, 10) : DEFAULT_THRESHOLD;
}

// ─── Scorer ───────────────────────────────────────────────────────────────────

export function calculateQualityScore(
  listing:  Partial<ListingRow>,
  attrs:    JumiaCategoryAttribute[],
  variants: { globalPrice?: string; quantity?: string }[]
): QualityBreakdown {
  const issues: string[] = [];

  // ── 1. Required fields (40 pts) ──────────────────────────────────────────
  // Always-required base fields
  const coreRequired = [
    { key: "title",         label: "Product name" },
    { key: "description",   label: "Description" },
    { key: "brand",         label: "Brand" },
    { key: "color",         label: "Color" },
    { key: "selling_price", label: "Price" },
    { key: "category_code", label: "Category" },
  ] as const;

  const dynRequired = attrs.filter((a) => a.required);
  const totalRequired = coreRequired.length + dynRequired.length;

  let filledRequired = 0;
  for (const f of coreRequired) {
    const val = listing[f.key as keyof typeof listing];
    if (val != null && String(val).trim() !== "") {
      filledRequired++;
    } else {
      issues.push(`Missing required field: ${f.label}`);
    }
  }

  const dynAttrs = (listing.dynamic_attributes ?? {}) as Record<string, string>;
  for (const attr of dynRequired) {
    if (dynAttrs[attr.name]?.trim()) {
      filledRequired++;
    } else {
      issues.push(`Missing required category field: ${attr.label}`);
    }
  }

  const requiredPct = totalRequired > 0 ? filledRequired / totalRequired : 1;
  const requiredScore = Math.round(requiredPct * 40);

  // ── 2. Content quality (20 pts) ──────────────────────────────────────────
  const descLen = (listing.description ?? "").length;
  const highlightsText = listing.highlights ?? "";
  const bulletCount = (highlightsText.match(/•/g) ?? []).length;

  let contentScore = 0;
  if (descLen >= 200) contentScore += 10;
  else if (descLen >= 80) contentScore += 6;
  else if (descLen > 0)  contentScore += 3;
  else issues.push("Description is too short or missing");

  if (bulletCount >= 4) contentScore += 10;
  else if (bulletCount >= 2) contentScore += 5;
  else if (bulletCount > 0)  contentScore += 2;
  else issues.push("Add at least 4 bullet points in Highlights");

  // ── 3. Images (20 pts) ──────────────────────────────────────────────────
  const imageCount = (listing.images ?? []).filter(Boolean).length;
  let imageScore = 0;
  if (imageCount >= 6)      imageScore = 20;
  else if (imageCount >= 3) imageScore = 14;
  else if (imageCount >= 1) imageScore = 8;
  else issues.push("Add at least one product image");

  // ── 4. Variants (10 pts) ─────────────────────────────────────────────────
  let variantScore = 0;
  if (variants.length > 1) {
    const hasPrice = variants.every((v) => parseFloat(v.globalPrice ?? "0") > 0);
    const hasQty   = variants.every((v) => parseInt(v.quantity ?? "0", 10) > 0);
    if (hasPrice && hasQty) variantScore = 10;
    else variantScore = 5;
  } else if (variants.length === 1) {
    const v = variants[0];
    if (parseFloat(v.globalPrice ?? "0") > 0 && parseInt(v.quantity ?? "0", 10) > 0) {
      variantScore = 8;
    } else {
      variantScore = 4;
    }
  } else {
    issues.push("Add at least one variant with price and quantity");
  }

  // ── 5. Specifications (10 pts) ───────────────────────────────────────────
  let specScore = 0;
  if (listing.weight_kg != null)    specScore += 3;
  else issues.push("Add product weight for better search ranking");
  if (listing.main_material?.trim()) specScore += 3;
  if (listing.warranty_duration?.trim()) specScore += 4;
  else issues.push("Add warranty duration to increase quality");

  // ── Total ────────────────────────────────────────────────────────────────
  const score = Math.min(100, requiredScore + contentScore + imageScore + variantScore + specScore);

  return {
    score,
    requiredFields:  requiredScore,
    contentLength:   contentScore,
    imageCount:      imageScore,
    variantCoverage: variantScore,
    specifications:  specScore,
    issues,
  };
}

// ─── Score label helpers ──────────────────────────────────────────────────────

export function scoreLabel(score: number): string {
  if (score >= 80) return "Excellent";
  if (score >= 60) return "Good";
  if (score >= 40) return "Fair";
  return "Poor";
}

export function scoreColor(score: number): string {
  if (score >= 80) return "emerald";
  if (score >= 60) return "blue";
  if (score >= 40) return "amber";
  return "red";
}
