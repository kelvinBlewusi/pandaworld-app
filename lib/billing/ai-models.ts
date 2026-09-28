/**
 * Which Gemini model each kind of AI call uses. One model per kind for
 * every seller: the plan tiers that used to pick between Flash-Lite,
 * Flash and Pro were removed 2026-09-28 with the move to credits, so a
 * seller's draft now costs the same whoever they are (see
 * lib/ai/usage.ts for what each call costs).
 */

/** Kind of AI call — different models for different purposes. */
export type ModelKind =
  | "vision"             // multimodal: image + text in, JSON out (listing analysis)
  | "text"               // text-only in, JSON out (description-only path, rejection resolver)
  | "image-edit"         // image in, image out (polish + rebuild from a real photo)
  | "image-from-scratch" // text in, image out ("no photo? we'll make one")
  | "embedding";         // text in, vector out (category similarity search)

// ── Model name constants ────────────────────────────────────────────────────
// Hardcoded model IDs in one file so swapping Gemini versions later
// is a single-line change. The Gemini API returns these names from
// /v1beta/models — see lib/actions/ai.ts' discoverWorkingModel() for
// the runtime discovery fallback.

// The model every listing draft, refill and rejection fix uses — the
// "own images" flow's model, now the only text/vision model outside the
// extension. Pinned here so a swap is a one-line edit.
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

// The Chrome extension's autofill. History: gemini-2.5-pro (Aug 2026) for
// better category-attribute accuracy, then gemini-2.5-flash-lite for speed,
// then briefly tried both gemini-3.5-flash-lite and gemini-3.1-flash-lite
// for a quality bump at the flash-lite tier — BOTH confirmed LIVE (Vercel
// logs, Aug 26 2026) to 404 on this project's Vertex Publisher Model
// catalogue in us-central1: "Publisher model
// ...gen-lang-client-0721987658/locations/us-central1... not found".
//
// Aug 26 2026: the "Name comes back Generic" report turned out NOT to be a
// model-quality problem at all — the diagnostic proved Gemini returned real
// titles and a client-side write clobbered them (fixed in content.js). So
// there's no longer a reason to carry gemini-2.5-pro's cost and latency
// here; Pro was also measured at ~50s per autofill against a 60s function
// ceiling, which is too close to the edge for production.
//
// Aug 30 2026: moved BACK to gemini-2.5-flash-lite on Vertex, at the
// seller's request — this was the last configuration that ran with no
// model-side issues, before the 3.x detour. Confirmed live, AFTER real
// billing was attached to the GCP project, that Vertex's Publisher Model
// catalogue for this project STILL 404s on both gemini-3.5-flash-lite and
// gemini-3.1-flash-lite — billing didn't change it.
//
// Sep 3 2026: moved to gemini-3.1-flash-lite again, this time via AI STUDIO
// rather than Vertex — see extension-fill.ts's `preferBackend: "ai-studio"`
// on the callGeminiBackend call, which is the actual fix here, not this
// constant alone. AI Studio's catalogue has always carried the 3.x line;
// only Vertex's Publisher Model catalogue 404s on it (confirmed twice
// above). The "no proven quality reason to prefer it" reasoning from the
// last round no longer holds: the extension prompt now carries a hard
// 1500/800-character minimum for Description/Highlights, and 2.5-flash-lite
// had already been caught live shipping under-length content despite an
// explicit instruction not to — a newer-generation model is a direct,
// targeted response to that failure mode, not a speculative upgrade.
// REQUIRES GOOGLE_API_KEY to be set in the Vercel env for AI Studio to
// actually be used — if it's ever unset, callGeminiBackend's preferBackend
// silently falls back to Vertex, where this exact model 404s (confirmed
// twice above). Verify via Vercel logs (`[gemini] backend=...`) after
// deploying this, the same way every prior model change here was verified
// — don't assume it worked from the code alone.
const MODEL_EXTENSION_FILL = "gemini-3.1-flash-lite";

// Image editing — currently only one viable Gemini model. Used by
// the "Polish" and "Rebuild as studio shot" buttons (which take an
// existing seller photo as input).
const MODEL_IMAGE_EDIT = "gemini-2.5-flash-image-preview";

// Image FROM SCRATCH — Google Imagen 3. Purpose-built text-to-image,
// produces studio-quality product shots from a description alone.
// Admin-only (see api/generate-product-image/route.ts).
const MODEL_IMAGE_FROM_SCRATCH = "imagen-3.0-generate-002";

// Text embeddings — for category retrieval. 768-dim vectors.
// Used by lib/ai/embeddings.ts to embed product descriptions and
// jumia_categories rows; pgvector cosine similarity finds the
// nearest categories.
const MODEL_EMBEDDING = "text-embedding-004";

/**
 * The model for a kind of call — the same for every seller. Called by
 * lib/actions/ai.ts's resolveModel().
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
