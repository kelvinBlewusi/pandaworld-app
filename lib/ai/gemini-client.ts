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

import { readUsage, recordAiUsage } from "@/lib/ai/usage";
import {
  GoogleGenerativeAI,
  type GenerativeModel as AIStudioModel,
} from "@google/generative-ai";
// Vertex goes through @google/genai, NOT @google-cloud/vertexai. The
// latter has been deprecated since 2025-06-24 with a stated removal date
// of 2026-06-24 — a date that has now passed, and it printed that warning
// on every single call. @google/genai is Google's replacement and speaks
// to both Vertex and AI Studio; only the Vertex half is migrated here,
// because the AI Studio path is the rollback (see isVertexEnabled) and
// changing both at once would remove the thing we fall back to.
import { GoogleGenAI, type Part as VertexPart } from "@google/genai";

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

let _vertexClient: GoogleGenAI | null = null;
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
function getVertexClient(): GoogleGenAI {
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

  _vertexClient = new GoogleGenAI({
    vertexai: true,
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
/**
 * Grounding tool declaration for both SDKs, as a raw pass-through object
 * rather than either SDK's typed `Tool` union — both `@google/generative-ai`
 * (0.24.1) and `@google/genai` (2.22.0) only type the OLDER
 * `googleSearchRetrieval` tool (1.5-era, dynamic-retrieval-based); neither
 * has caught up to `google_search`, the tool current Gemini generations use.
 * Verified this is still safe: both SDKs' generateContent() passes `tools`
 * straight through to `JSON.stringify(request)` with no key transformation
 * or schema validation (checked their installed source directly, not just
 * docs), and `{"google_search": {}}` is the documented current wire shape
 * for the classic generateContent REST endpoint on both Vertex and AI
 * Studio. Revisit this cast once either SDK ships a real `GoogleSearchTool`
 * type — this is a deliberate, verified exception to "don't guess API
 * shapes," not a habit to repeat elsewhere.
 */
const GOOGLE_SEARCH_TOOL = { google_search: {} };

export async function callGeminiBackend(
  modelName: string,
  parts: GeminiPart[],
  opts: { preferBackend?: "vertex" | "ai-studio"; groundWithSearch?: boolean; json?: boolean } = {},
): Promise<GeminiCallResult> {
  // Per-call backend preference. Vertex and AI Studio expose DIFFERENT model
  // catalogues despite sharing model names and pricing: confirmed live (Aug
  // 26 2026) that gemini-3.5-flash-lite and gemini-3.1-flash-lite both 404 on
  // this project's Vertex publisher catalogue in us-central1, while AI
  // Studio's own listing carries them. So a caller that wants a newer model
  // than Vertex serves can ask for AI Studio explicitly.
  //
  // Falls back to the default resolution when AI Studio isn't configured
  // (no GOOGLE_API_KEY) — a preference, never a hard requirement, so setting
  // it can't take the whole route down. Omitting opts keeps the historical
  // behaviour byte-for-byte: Vertex when configured, AI Studio otherwise.
  const preferAiStudio =
    opts.preferBackend === "ai-studio" && Boolean(process.env.GOOGLE_API_KEY);

  if (!preferAiStudio && isVertexEnabled()) {
    const vertex = getVertexClient();
    // Three shape changes from @google-cloud/vertexai, all here:
    //   - no per-model object; the model name is an argument
    //   - tools move inside `config`
    //   - the result IS the response (no `.response` wrapper)
    // `json`: the reply is one JSON value (responseMimeType), for callers that parse it.
    const config = {
      ...(opts.groundWithSearch ? { tools: [GOOGLE_SEARCH_TOOL] as unknown as import("@google/genai").Tool[] } : {}),
      ...(opts.json ? { responseMimeType: "application/json" } : {}),
    };
    const result = await vertex.models.generateContent({
      model:    modelName,
      contents: [{ role: "user", parts: parts as VertexPart[] }],
      ...(Object.keys(config).length > 0 ? { config } : {}),
    });
    const candidate = result.candidates?.[0];
    const responseParts = candidate?.content?.parts ?? [];
    const text = responseParts
      .filter((p): p is { text: string } => typeof (p as { text?: unknown }).text === "string")
      .map((p) => p.text)
      .join("");
    await recordAiUsage({ model: modelName, backend: "vertex", ...readUsage(result) });
    return { text, model: modelName, backend: "vertex" };
  }

  const ai = getAIStudioClient();
  const model: AIStudioModel = ai.getGenerativeModel({ model: modelName });
  const result = await model.generateContent(
    opts.groundWithSearch || opts.json
      ? {
          contents: [{ role: "user", parts: parts as import("@google/generative-ai").Part[] }],
          ...(opts.groundWithSearch ? { tools: [GOOGLE_SEARCH_TOOL] as unknown as import("@google/generative-ai").Tool[] } : {}),
          ...(opts.json ? { generationConfig: { responseMimeType: "application/json" } } : {}),
        }
      : parts,
  );
  await recordAiUsage({ model: modelName, backend: "ai-studio", ...readUsage(result.response) });
  return {
    text:    result.response.text(),
    model:   modelName,
    backend: "ai-studio",
  };
}

// ─── Function calling (the assistant's agent mode) ──────────────────────────

/** A tool the model may call: its name, what it does, its arguments as JSON Schema. */
export interface GeminiTool { name: string; description: string; parameters: Record<string, unknown> }

/** One turn of a conversation with tools, in the API's own shape (parts kept verbatim, thought signatures included). */
export type GeminiTurn = { role: "user" | "model"; parts: Record<string, unknown>[] };

export interface GeminiToolResult {
  /** The model's calls, in order (`id`, when the API gives one, goes back with the answer). */
  calls: { name: string; args: Record<string, unknown>; id?: string }[];
  /** Any text it wrote instead of (or with) calls. */
  text: string;
  /** Its turn as it came, to send back with the tools' answers: Gemini 3 needs its thought signatures returned. */
  turn: GeminiTurn;
  backend: "vertex" | "ai-studio";
}

let _aiStudioGenAI: GoogleGenAI | null = null;
function getAIStudioGenAI(): GoogleGenAI {
  if (_aiStudioGenAI) return _aiStudioGenAI;
  if (!process.env.GOOGLE_API_KEY) throw new Error("GOOGLE_API_KEY is required for AI Studio.");
  _aiStudioGenAI = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });
  return _aiStudioGenAI;
}

/**
 * One call with tools the model may call (Gemini function calling), for the
 * assistant's agent mode (lib/assistant-v2/agent.ts). Through @google/genai on
 * both backends: the older AI Studio SDK drops the thought signatures Gemini 3
 * needs back with the tools' answers. `mode` "ANY" makes it call a tool
 * rather than write text; `allowed`, which of the tools it may call this time.
 */
export async function callGeminiWithTools(
  modelName: string,
  turns: GeminiTurn[],
  opts: { system: string; tools: GeminiTool[]; mode?: "AUTO" | "ANY"; allowed?: string[]; preferBackend?: "vertex" | "ai-studio" },
): Promise<GeminiToolResult> {
  const aiStudio = (opts.preferBackend === "ai-studio" && Boolean(process.env.GOOGLE_API_KEY)) || !isVertexEnabled();
  const client = aiStudio ? getAIStudioGenAI() : getVertexClient();
  const result = await client.models.generateContent({
    model: modelName,
    contents: turns as unknown as import("@google/genai").Content[],
    config: {
      systemInstruction: opts.system,
      tools: [{ functionDeclarations: opts.tools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }],
      toolConfig: {
        functionCallingConfig: {
          mode: (opts.mode ?? "AUTO") as import("@google/genai").FunctionCallingConfigMode,
          // Every tool stays declared (earlier turns call them); only these may be called now.
          ...(opts.mode === "ANY" && opts.allowed?.length ? { allowedFunctionNames: opts.allowed } : {}),
        },
      },
    },
  });
  const backend = aiStudio ? "ai-studio" as const : "vertex" as const;
  await recordAiUsage({ model: modelName, backend, ...readUsage(result) });
  const parts = (result.candidates?.[0]?.content?.parts ?? []) as Record<string, unknown>[];
  const calls = parts
    .map((p) => p.functionCall as { id?: string; name?: string; args?: Record<string, unknown> } | undefined)
    .filter((c): c is { id?: string; name: string; args?: Record<string, unknown> } => !!c?.name)
    .map((c) => ({ name: c.name, args: c.args ?? {}, ...(c.id ? { id: c.id } : {}) }));
  const text = parts.filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text as string).join("");
  return { calls, text, turn: { role: "model", parts }, backend };
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
