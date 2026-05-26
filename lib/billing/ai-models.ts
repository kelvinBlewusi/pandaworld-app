/**
 * Tier-aware Gemini model picker.
 *
 * Strategy (May 2026, post $10 API-credit purchase):
 *
 *   Free tier      → gemini-2.0-flash         (cheaper, ~33% less per call)
 *   Starter / Pro / Business → gemini-2.5-flash         (better quality)
 *
 *   Image generation (polish / rebuild):
 *     gemini-2.5-flash-image-preview (the only viable Gemini image-gen
 *     model right now). Free tier doesn't get image gen at all
 *     (gated by polish quota = 0).
 *
 * Why this split:
 *   - The $10 API budget funds ~2k–3k full listings on 2.5 Flash or
 *     ~3.5k–4.5k on 2.0 Flash. Routing free users to the cheaper
 *     model preserves credit for paying customers who deserve the
 *     better quality.
 *   - Quality difference is real but modest for the structured-JSON
 *     output our prompts produce. Free users still get useable
 *     listings; paid users get the polish.
 *   - When we get the Google for Startups credits ($300–$1k), we can
 *     promote everyone to 2.5 Flash with one config change here.
 *
 * Admin override: admins always get the best model regardless of
 * "plan" (they're testing the production experience).
 */

import type { Plan } from "@/lib/billing/plans";

/** Kind of AI call — different models for different purposes. */
export type ModelKind =
  | "vision"      // multimodal: image + text in, JSON out (listing analysis)
  | "text"        // text-only in, JSON out (description-only path, rejection resolver)
  | "image-gen";  // image in, image out (polish + rebuild)

// ── Model name constants ────────────────────────────────────────────────────
// Hardcoded model IDs are kept in this one file so swapping Gemini
// versions later is a single-line change. The Gemini API also returns
// these names from /v1beta/models — see lib/actions/ai.ts'
// discoverWorkingModel() for the fallback list.

const MODEL_CHEAP_FAST    = "gemini-2.0-flash";
const MODEL_PREMIUM_TEXT  = "gemini-2.5-flash";
const MODEL_PREMIUM_VISION = "gemini-2.5-flash";

// Image generation — currently only one viable Gemini model.
// `gemini-2.5-flash-image-preview` is the public preview ID; if
// Google promotes it to GA the name will change and we update here.
const MODEL_IMAGE_GEN     = "gemini-2.5-flash-image-preview";

/**
 * Pick the right Gemini model for a (plan, kind) combination.
 *
 * Admins are always treated as paid for model selection (they pay
 * the API cost in their testing time anyway, and we want them to see
 * the production experience).
 */
export function pickModelForPlan(
  plan: Plan,
  kind: ModelKind,
  opts: { isAdmin?: boolean } = {},
): string {
  const treatAsPaid = opts.isAdmin === true || plan !== "free";

  switch (kind) {
    case "image-gen":
      // Only one model; tier doesn't change which we use. The polish
      // quota gates whether the user can call this at all (Free = 0).
      return MODEL_IMAGE_GEN;

    case "vision":
      return treatAsPaid ? MODEL_PREMIUM_VISION : MODEL_CHEAP_FAST;

    case "text":
      return treatAsPaid ? MODEL_PREMIUM_TEXT : MODEL_CHEAP_FAST;
  }
}

/**
 * Helper: returns true if this plan/admin combination is entitled to
 * the premium-model experience. Use in UI when you want to surface
 * the model upgrade as a feature.
 */
export function isOnPremiumModel(plan: Plan, opts: { isAdmin?: boolean } = {}): boolean {
  return opts.isAdmin === true || plan !== "free";
}
