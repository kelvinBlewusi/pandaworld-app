/**
 * Gemini-client abstraction — backend-agnostic Gemini call surface.
 *
 * Today PandaWorld can talk to Gemini through two different Google paths:
 *   1. Vertex AI (production-grade, via service-account auth)
 *   2. Google AI Studio (consumer API key — what we used pre-migration)
 *
 * Both expose the SAME Gemini models (3.1 Flash Lite, 2.5 Flash, etc.) and
 * the SAME per-token pricing. Vertex AI's advantages:
 *   - 10× higher default rate limits (1000+ RPM vs ~360 RPM on AI Studio)
 *   - Regional routing (us-central1, europe-west1, etc.) — lower latency
 *   - No embedding cold-start (provisioned warm)
 *   - Cloud Billing integration + budgets
 *   - Service-account auth (rotatable, scoped, audit-logged)
 *
 * Backend selection (resolved per process):
 *   - If `GCP_PROJECT_ID` AND `GOOGLE_APPLICATION_CREDENTIALS_JSON` are set
 *     → Vertex AI
 *   - Otherwise → AI Studio (preserves zero-config local dev)
 *
 * Roll-back path: unset the two Vertex env vars in Vercel, redeploy. We're
 * instantly back on AI Studio with no code change required.
 *
 * TODO(margin optimization, not a bug — do when there's time, not urgent):
 * The extension's fill prompt (lib/ai/extension-fill.ts) sends ~18,000
 * characters of identical boilerplate (Jumia content policy, restricted
 * words, style guide, output rules) on every single call — only the
 * per-listing FIELDS/image actually varies. Vertex AI supports context
 * caching for a repeated prompt prefix, which would let that fixed chunk
 * be billed once instead of on every autofill. Worth implementing once
 * there's real call volume to justify it — see the margin math worked
 * out for the "check the thin margins" request, Aug 2026.
 */

import {
  GoogleGenerativeAI,
  type GenerativeModel as AIStudioModel,
} from "@google/generative-ai";
import {
  VertexAI,
  type GenerativeModel as VertexModel,
  type Part as VertexPart,
} from "@google-cloud/vertexai";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * A single content part — text or inline binary (image). Same shape both
 * SDKs accept once you wrap them in the right contents structure. Callers
 * pass an array of these; the abstraction routes them correctly.
 */
export type GeminiPart =
  | { text: string }
  | { inlineData: { data: string; mimeType: string } };

export interface GeminiCallResult {
  /** The model's text response (extracted from candidates[0].content.parts[]). */
  text:   string;
  /** Which model actually answered (echoes the input modelName). */
  model:  string;
  /** Which backend served this — useful for telemetry and log diagnosis. */
  backend: "vertex" | "ai-studio";
}

// ─── Backend resolution ─────────────────────────────────────────────────────

let _vertexClient: VertexAI | null = null;
let _aiStudioClient: GoogleGenerativeAI | null = null;

/**
 * True iff the running process is configured to use Vertex AI as the
 * Gemini backend. Decision-once-per-process — both clients lazy-init below.
 */
export function isVertexEnabled(): boolean {
  return Boolean(
    process.env.GCP_PROJECT_ID &&
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
  );
}

/**
 * Lazy-load + cache the Vertex AI client for the lifetime of the process.
 * The service-account JSON is provided via env var rather than file path
 * so Vercel's secret manager can hold it.
 */
function getVertexClient(): VertexAI {
  if (_vertexClient) return _vertexClient;

  const credsRaw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!credsRaw) {
    throw new Error(
      "GOOGLE_APPLICATION_CREDENTIALS_JSON is required when GCP_PROJECT_ID is set.",
    );
  }

  let credentials: Record<string, unknown>;
  try {
    credentials = JSON.parse(credsRaw);
  } catch (e) {
    throw new Error(
      `GOOGLE_APPLICATION_CREDENTIALS_JSON is not valid JSON: ${(e as Error).message}`,
    );
  }

  // Some Vercel env-var paste flows escape the newlines in the private key.
  // GoogleAuth happily accepts a key with literal `\n` characters — it
  // de-escapes during the JWT sign. No extra normalisation needed here.

  _vertexClient = new VertexAI({
    project:  process.env.GCP_PROJECT_ID!,
    location: process.env.VERTEX_AI_LOCATION ?? "us-central1",
    googleAuthOptions: { credentials },
  });

  return _vertexClient;
}

/**
 * Lazy-load + cache the AI Studio client. Used when Vertex env vars are
 * absent (local dev) or as a hard fallback during rollback.
 */
function getAIStudioClient(): GoogleGenerativeAI {
  if (_aiStudioClient) return _aiStudioClient;
  if (!process.env.GOOGLE_API_KEY) {
    throw new Error(
      "GOOGLE_API_KEY is required when Vertex AI is not configured.",
    );
  }
  _aiStudioClient = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  return _aiStudioClient;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Run a generateContent call through the active backend.
 *
 * Why this layer exists rather than calling either SDK directly:
 *   - The two SDKs have slightly different request shapes. Vertex AI
 *     requires `generateContent({ contents: [...] })` — no array shorthand.
 *     AI Studio accepts both. This wraps both behind a single signature.
 *   - The two SDKs have slightly different response shapes too. AI Studio
 *     provides `result.response.text()` as a convenience. Vertex AI gives
 *     `result.response.candidates[].content.parts[].text`. This unifies them.
 *
 * Callers pass an array of parts (text + inline image data). The abstraction
 * converts to whichever backend's expected shape.
 *
 * Returns the extracted text + backend identity for telemetry.
 */
export async function callGeminiBackend(
  modelName: string,
  parts: GeminiPart[],
): Promise<GeminiCallResult> {
  if (isVertexEnabled()) {
    const vertex = getVertexClient();
    const model: VertexModel = vertex.getGenerativeModel({ model: modelName });
    const result = await model.generateContent({
      contents: [{ role: "user", parts: parts as VertexPart[] }],
    });
    const candidate = result.response?.candidates?.[0];
    const responseParts = candidate?.content?.parts ?? [];
    const text = responseParts
      .filter((p): p is { text: string } => typeof (p as { text?: unknown }).text === "string")
      .map((p) => p.text)
      .join("");
    return { text, model: modelName, backend: "vertex" };
  }

  const ai = getAIStudioClient();
  const model: AIStudioModel = ai.getGenerativeModel({ model: modelName });
  const result = await model.generateContent(parts);
  return {
    text:    result.response.text(),
    model:   modelName,
    backend: "ai-studio",
  };
}

/**
 * Diagnostic helper — surfaces in Vercel logs which backend is live so
 * we can tell at a glance whether the migration env vars took effect.
 * Idempotent: only logs on first call per process.
 */
let _backendLogged = false;
export function logActiveBackendOnce(): void {
  if (_backendLogged) return;
  _backendLogged = true;
  if (isVertexEnabled()) {
    console.info(
      `[gemini] backend=vertex project=${process.env.GCP_PROJECT_ID} location=${process.env.VERTEX_AI_LOCATION ?? "us-central1"}`,
    );
  } else {
    console.info("[gemini] backend=ai-studio (Vertex not configured)");
  }
}
