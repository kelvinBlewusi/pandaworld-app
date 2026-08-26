/**
 * Tier-aware Gemini model picker.
 *
 * Strategy (May 2026, with paid Gemini credits):
 *
 *   Free                    → gemini-2.5-flash-lite   (cheapest, ~50% less than 2.0 Flash)
 *   Starter / Pro           → gemini-2.5-flash        (production sweet spot)
 *   Business + Admin        → gemini-2.5-pro          (best reasoning, slower, ~5–10× cost)
 *
 *   Image editing (polish / rebuild — all paid):
 *     gemini-2.5-flash-image-preview
 *
 *   Image generation from text (Business + Admin only):
 *     imagen-3.0-generate-002 — purpose-built text-to-image
 *
 * Why this split:
 *   - Free funnel runs on the cheapest viable model. Quality is OK
 *     for structured-JSON output, well within Jumia QC acceptance.
 *   - Starter / Pro get the standard production model. Same as Free
 *     used to use, but now meaningfully better than what Free sees.
 *   - Business gets the premium model — they pay GHS 120/mo and
 *     deserve the visible quality bump (better category accuracy,
 *     fewer hallucinated attributes, smarter override handling).
 *   - Image FROM SCRATCH (no source photo) is Business-only because
 *     it's the marketing differentiator: "Don't have product photos?
 *     We'll generate them for you." Justifies the price jump.
 *
 * Admin override: always treated as Business (premium).
 */

import type { Plan } from "@/lib/billing/plans";

/** Kind of AI call — different models for different purposes. */
export type ModelKind =
  | "vision"             // multimodal: image + text in, JSON out (listing analysis)
  | "text"               // text-only in, JSON out (description-only path, rejection resolver)
  | "image-edit"         // image in, image out (polish + rebuild from a real photo)
  | "image-from-scratch" // text in, image out (Business-only "no photo? we'll make one")
  | "embedding";         // text in, vector out (category similarity search)

// ── Model name constants ────────────────────────────────────────────────────
// Hardcoded model IDs in one file so swapping Gemini versions later
// is a single-line change. The Gemini API returns these names from
// /v1beta/models — see lib/actions/ai.ts' discoverWorkingModel() for
// the runtime discovery fallback.

const MODEL_LITE       = "gemini-2.5-flash-lite";          // Free tier
const MODEL_STANDARD   = "gemini-2.5-flash";               // Starter / Pro
const MODEL_PREMIUM    = "gemini-2.5-pro";                 // Business / Admin

// The model used by the auto-analyze pipeline for the "own images"
// listing flow — regardless of seller tier. Pinned here so a single
// edit re-routes every Free / Starter / Pro / Business analyze call
// without touching the per-tier ladder above.
//
// May 2026 (rev. post-Vertex migration): pinned to gemini-2.5-flash-lite.
// We previously used "gemini-3.1-flash-lite" — a string that 404s on
// both AI Studio and Vertex AI (Vertex's catalogue exposes the 2.5
// generation; 3.x is not GA). The fallback chain was silently
// catching the 404 and dropping to gemini-2.5-flash, which is slower
// (~15s/call vs ~3s/call on flash-lite). 3 passes × 15s pushed us
// past Vercel's 60s function ceiling. Switching to 2.5-flash-lite as
// the primary fixes the 404 outright and gives the fast inference
// we wanted in the first place.
const MODEL_OWN_IMAGES_FLOW = "gemini-2.5-flash-lite";

// The Chrome extension's autofill. Was gemini-2.5-pro (Aug 2026) for
// better category-attribute accuracy and fewer hallucinated values, then
// briefly tried both gemini-3.5-flash-lite and gemini-3.1-flash-lite for
// a quality bump at the flash-lite speed/cost tier — BOTH confirmed LIVE
// (Vercel logs, Aug 26 2026) to 404 on this project's Vertex Publisher
// Model catalogue in us-central1: "Publisher model
// ...gen-lang-client-0721987658/locations/us-central1... not found".
// Settled back on gemini-2.5-flash-lite: the 3.x generation genuinely
// isn't in this project/region's Vertex catalogue yet, regardless of
// what AI Studio's own model listing shows (same gap this codebase hit
// with 3.1 once before, May 2026 — see MODEL_OWN_IMAGES_FLOW above).
// Don't re-try a 3.x primary here without first confirming — via a live
// call, not a marketing page — that Vertex's catalogue for THIS project
// actually serves it.
const MODEL_EXTENSION_FILL = MODEL_LITE;

// Image editing — currently only one viable Gemini model. Used by
// the "Polish" and "Rebuild as studio shot" buttons (which take an
// existing seller photo as input).
const MODEL_IMAGE_EDIT = "gemini-2.5-flash-image-preview";

// Image FROM SCRATCH — Google Imagen 3. Purpose-built text-to-image,
// produces studio-quality product shots from a description alone.
// Business-tier only (see api/generate-product-image/route.ts).
const MODEL_IMAGE_FROM_SCRATCH = "imagen-3.0-generate-002";

// Text embeddings — for category retrieval. 768-dim vectors.
// Used by lib/ai/embeddings.ts to embed product descriptions and
// jumia_categories rows; pgvector cosine similarity finds the
// nearest categories.
const MODEL_EMBEDDING = "text-embedding-004";

/**
 * Pick the right Gemini model for a (plan, kind) combination.
 *
 * Admins are always treated as Business (premium) for model
 * selection — they're testing the production experience and we want
 * them to see the best version.
 */
export function pickModelForPlan(
  plan: Plan,
  kind: ModelKind,
  opts: { isAdmin?: boolean } = {},
): string {
  const tier: "free" | "standard" | "premium" =
    opts.isAdmin === true || plan === "business"
      ? "premium"
      : plan === "free"
        ? "free"
        : "standard"; // starter, pro

  switch (kind) {
    case "image-edit":
      // Same model for all paid tiers; Free is gated at the quota layer.
      return MODEL_IMAGE_EDIT;

    case "image-from-scratch":
      // Business-only feature; routes/UI also gate this.
      return MODEL_IMAGE_FROM_SCRATCH;

    case "embedding":
      // One embedding model across the board — embeddings don't have
      // meaningful "premium" tiers.
      return MODEL_EMBEDDING;

    case "vision":
    case "text":
      // The big-three text/vision models split by tier.
      if (tier === "premium")  return MODEL_PREMIUM;
      if (tier === "standard") return MODEL_STANDARD;
      return MODEL_LITE;
  }
}

/**
 * Helper: true if this plan/admin is on the PREMIUM model
 * (Gemini 2.5 Pro). Use to surface "you're using our best AI"
 * messaging in the UI for Business / Admin users.
 */
export function isOnPremiumModel(plan: Plan, opts: { isAdmin?: boolean } = {}): boolean {
  return opts.isAdmin === true || plan === "business";
}

/**
 * Model used by the "own images" listing-analyze flow — same for
 * every tier. Called by the auto-analyze route via resolveModel()
 * when forceBestModel:true is passed.
 *
 * Returns the dedicated own-images model for vision/text kinds; for
 * other kinds (image-edit / image-from-scratch / embedding) it falls
 * back to the standard per-kind model so the contract still works
 * for any caller that flips forceBestModel on those kinds.
 */
export function pickModelForOwnImagesFlow(kind: ModelKind): string {
  switch (kind) {
    case "vision":
    case "text":
      return MODEL_OWN_IMAGES_FLOW;
    case "image-edit":
      return MODEL_IMAGE_EDIT;
    case "image-from-scratch":
      return MODEL_IMAGE_FROM_SCRATCH;
    case "embedding":
      return MODEL_EMBEDDING;
  }
}

/** Model for the Chrome extension's single-call autofill — see MODEL_EXTENSION_FILL above. */
export function pickModelForExtensionFill(): string {
  return MODEL_EXTENSION_FILL;
}

/**
 * Helper: true if this plan is entitled to image-from-scratch
 * generation (Imagen 3). Currently Business + Admin only.
 */
export function canGenerateImagesFromScratch(
  plan: Plan,
  opts: { isAdmin?: boolean } = {},
): boolean {
  return opts.isAdmin === true || plan === "business";
}
