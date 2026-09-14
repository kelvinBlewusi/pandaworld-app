/**
 * Text embeddings via Google's Gemini embedding API.
 *
 * Used for:
 *   - Embedding the Jumia category tree once (backfill + on sync)
 *   - Embedding product descriptions at auto-analyze time
 *   - pgvector cosine-similarity lookups (see
 *     lib/jumia/category-search.ts → searchCategoriesByEmbedding)
 *
 * Cost-aware: embedding-class models are essentially free at our
 * scale (~$0.00001 per 1k tokens). Embedding all ~10k Jumia
 * categories once costs ~$0.10. Per-listing embedding ~$0.0001.
 *
 * Model fallback chain: the embedding API has been renamed a few
 * times. We try each in order until one works on the user's API key.
 * All three produce 768-dim normalised vectors compatible with
 * pgvector's vector(768) column.
 */

/**
 * Embedding-model fallback chain for the AI Studio backend.
 *
 * Order matters: the FIRST name in this list is tried first on every
 * cold-start until one succeeds. `gemini-embedding-001` is the one
 * that resolves on the user's current AI Studio key, so it goes first.
 * Operationally: cache hits skip this list entirely (see
 * `_resolvedEmbeddingModel` below). This order only matters on the
 * first call of a new serverless process when AI Studio is the backend.
 *
 * On Vertex AI, we hit `text-embedding-005` directly — no fallback list
 * needed because the model catalogue is predictable per project.
 */
import { trackGeminiCall } from "@/lib/ai/quota-telemetry";

const EMBEDDING_MODELS_TO_TRY = [
  "gemini-embedding-001",    // works on current key — try first
  "text-embedding-004",      // older public name; 404s on some keys
  "embedding-001",           // legacy fallback
];

/** Vertex AI's stable, fast embedding model. Provisioned-warm — no cold start. */
const VERTEX_EMBEDDING_MODEL = "text-embedding-005";

const EMBED_TIMEOUT_MS = 20_000;

// Cache the first model that works on this server process so we
// don't waste a fallback attempt on every single call.
let _resolvedEmbeddingModel: string | null = null;

export interface EmbedTextResult {
  /** 768-dim vector. */
  vector: number[];
  /** Model used (lets callers spot drift if we ever swap models). */
  model: string;
  /** Which backend served the call — useful in Vercel logs. */
  backend?: "vertex" | "ai-studio";
}

// ─── Backend selection ──────────────────────────────────────────────────────

/**
 * True iff this process is configured to use Vertex AI for embeddings.
 * Mirrors the same condition as lib/ai/gemini-client.ts so vision and
 * embeddings stay on the same backend.
 */
function isVertexEmbeddingsEnabled(): boolean {
  return Boolean(
    process.env.GCP_PROJECT_ID &&
      process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
  );
}

// ─── Vertex AI access-token cache ───────────────────────────────────────────
//
// The Vertex predict endpoint uses Bearer auth (OAuth2 access token derived
// from the service account JSON). Tokens last 1 hour. Caching here avoids
// re-signing a JWT on every embed call — a single token serves thousands
// of requests in the same process.

let _vertexAuthClient: import("google-auth-library").GoogleAuth | null = null;
let _vertexAccessToken: { token: string; expires: number } | null = null;

async function getVertexAccessToken(): Promise<string> {
  // 60-second safety buffer — refresh before expiry.
  const now = Date.now();
  if (_vertexAccessToken && _vertexAccessToken.expires > now + 60_000) {
    return _vertexAccessToken.token;
  }

  if (!_vertexAuthClient) {
    const credsRaw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!credsRaw) {
      throw new Error("GOOGLE_APPLICATION_CREDENTIALS_JSON is required for Vertex embeddings.");
    }
    const credentials = JSON.parse(credsRaw);
    // Dynamic import — google-auth-library ships with @google-cloud/vertexai.
    // Lazy-import so AI-Studio-only deployments don't pay the cost of loading it.
    const { GoogleAuth } = await import("google-auth-library");
    _vertexAuthClient = new GoogleAuth({
      credentials,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    });
  }

  const client = await _vertexAuthClient.getClient();
  const tokenResp = await client.getAccessToken();
  if (!tokenResp.token) {
    throw new Error("Vertex auth returned no access token");
  }
  // tokenResp.res?.data?.expires_in is in seconds; default to 50 min if absent
  const expiresInSec =
    (tokenResp.res?.data as { expires_in?: number } | undefined)?.expires_in ?? 3000;
  _vertexAccessToken = {
    token:   tokenResp.token,
    expires: now + expiresInSec * 1000,
  };
  return tokenResp.token;
}

/**
 * Pay the Vertex embed path's one-off per-process cost up front, off the
 * critical path.
 *
 * The first embed call in a fresh serverless process does three things
 * before it can talk to the model: dynamic-import google-auth-library,
 * sign a JWT, and fetch an OAuth token. All of that lands INSIDE
 * searchCategoriesByEmbedding's 4s race, and confirmed live on
 * 2026-09-13 it blew straight through it — "embedding search TIMED OUT
 * after 4000ms" on a cold process with Vertex correctly configured and
 * the pgvector RPC verified healthy. The semantic layer was being
 * discarded on exactly the requests that were already slowest.
 *
 * The token is cached for ~50 minutes (see getVertexAccessToken), so a
 * warm process never pays this again. Callers should start this early and
 * NOT await it — the point is to overlap it with work that was going to
 * happen anyway (Pass A's vision call runs ~5s), so retrieval finds the
 * token already cached and only the <1s predict call races the budget.
 *
 * Never throws: a failed warm-up just means the next real call pays the
 * cost as before.
 */
export async function warmEmbeddingBackend(): Promise<void> {
  if (!isVertexEmbeddingsEnabled()) return;
  try {
    await getVertexAccessToken();
  } catch (e) {
    console.warn(`[embeddings] backend warm-up failed (non-fatal): ${(e as Error).message}`);
  }
}

// ─── Per-backend embed implementations ──────────────────────────────────────

/**
 * Vertex AI `text-embedding-005:predict` call.
 *
 * Request shape (different from AI Studio's `embedContent`):
 *   POST .../publishers/google/models/text-embedding-005:predict
 *   {
 *     instances:  [{ task_type: "RETRIEVAL_QUERY", content: "..." }],
 *     parameters: { outputDimensionality: 768 }
 *   }
 *
 * Response shape:
 *   { predictions: [{ embeddings: { values: [...] } }] }
 *
 * task_type matters for retrieval quality — using RETRIEVAL_QUERY for
 * the auto-analyze use case (matches "search the category tree for this
 * product description"). For indexing the categories themselves we'd
 * use RETRIEVAL_DOCUMENT — but the backfill route does that elsewhere.
 */
async function embedViaVertex(text: string): Promise<EmbedTextResult> {
  const project  = process.env.GCP_PROJECT_ID!;
  const location = process.env.VERTEX_AI_LOCATION ?? "us-central1";
  const token    = await getVertexAccessToken();

  const url =
    `https://${location}-aiplatform.googleapis.com/v1/projects/${project}` +
    `/locations/${location}/publishers/google/models/${VERTEX_EMBEDDING_MODEL}:predict`;

  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      instances:  [{ task_type: "RETRIEVAL_QUERY", content: text }],
      parameters: { outputDimensionality: 768 },
    }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `Vertex embed ${VERTEX_EMBEDDING_MODEL} failed: ${res.status} ${body.slice(0, 300)}`,
    );
  }

  const data = (await res.json()) as {
    predictions?: Array<{ embeddings?: { values?: number[] } }>;
  };
  const values = data.predictions?.[0]?.embeddings?.values;

  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(
      `Vertex embed empty vector. response=${JSON.stringify(data).slice(0, 300)}`,
    );
  }

  // text-embedding-005 returns 768-dim by default when outputDimensionality
  // is requested. Belt-and-braces: clip to 768 if anything else came back.
  let vector = values;
  if (vector.length > 768) vector = vector.slice(0, 768);
  if (vector.length !== 768) {
    throw new Error(
      `Vertex embed: expected 768-dim vector, got ${values.length}`,
    );
  }

  // Re-normalise to unit length (same convention as the AI Studio path —
  // pgvector cosine-distance only behaves correctly with unit-norm vectors).
  const sumSq = vector.reduce((s, x) => s + x * x, 0);
  const norm  = Math.sqrt(sumSq);
  if (norm > 0 && Math.abs(norm - 1) > 1e-4) {
    vector = vector.map((x) => x / norm);
  }

  return { vector, model: VERTEX_EMBEDDING_MODEL, backend: "vertex" };
}

/**
 * Attempt the embed call against ONE specific AI Studio model. Returns
 * a skipReason on a "model not available" error so the caller can try
 * the next one. Throws on real errors (auth, network, malformed
 * response) because retrying with a different model won't fix those.
 */
async function tryEmbedOneModel(
  modelName: string,
  text: string,
): Promise<EmbedTextResult | { skipReason: string }> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY not set");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:embedContent?key=${apiKey}`;

  // outputDimensionality:768 is required for gemini-embedding-001 (defaults
  // to 3072 otherwise). text-embedding-004 / embedding-001 ignore it and
  // always return 768, so passing it for all three models is safe.
  // gemini-embedding-001 is a Matryoshka model — truncating to 768 is the
  // documented use-case, no quality loss vs. the full 3072.
  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      model:                `models/${modelName}`,
      content:              { parts: [{ text }] },
      outputDimensionality: 768,
    }),
    signal:  AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });

  // Model-not-found / not-enabled — return skip signal so caller
  // moves to the next model name in the fallback list.
  if (res.status === 404) {
    const body = await res.text().catch(() => "");
    return { skipReason: `404 ${body.slice(0, 200)}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // 400 with "model not supported" is also a fallback signal
    if (res.status === 400 && /not\s*(found|support|enabled)/i.test(body)) {
      return { skipReason: `${res.status} ${body.slice(0, 200)}` };
    }
    // Anything else (auth, quota, rate-limit) is a real error
    throw new Error(`embed ${modelName} failed: ${res.status} ${body.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    embedding?: { values?: number[] };
  };

  const raw = data.embedding?.values;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `embed ${modelName}: empty vector. response=${JSON.stringify(data).slice(0, 300)}`,
    );
  }

  // gemini-embedding-001 occasionally returns the full 3072-dim vector
  // even when outputDimensionality is requested (older API versions).
  // If so, truncate to first 768 dims — safe for Matryoshka-trained models.
  let vector = raw;
  if (vector.length > 768) {
    vector = vector.slice(0, 768);
  }

  // Refuse anything else weird (e.g. 1536 from a model we don't know).
  if (vector.length !== 768) {
    // Returning a skip signal so the caller can try the next model name
    // instead of bailing out of the whole fallback chain.
    return {
      skipReason: `unexpected vector length ${raw.length} (need 768)`,
    };
  }

  // Re-normalise to unit length. Matryoshka truncation breaks the original
  // unit-norm property; re-normalising restores it so cosine-distance
  // queries against pgvector behave correctly.
  const sumSq = vector.reduce((s, x) => s + x * x, 0);
  const norm  = Math.sqrt(sumSq);
  if (norm > 0 && Math.abs(norm - 1) > 1e-4) {
    vector = vector.map((x) => x / norm);
  }

  return { vector, model: modelName, backend: "ai-studio" };
}

/**
 * The model `embedText` would use right now.
 *
 * Exists so stored vectors can be compared against the live backend
 * WITHOUT embedding anything: jumia_categories.embedding_model records
 * what wrote each row, and the backfill re-embeds whatever no longer
 * matches this. That is the check that was missing when the category
 * index stayed on gemini-embedding-001 while queries moved to Vertex's
 * text-embedding-005 — four months of confident nonsense, because
 * nothing ever compared the two.
 *
 * Exact on Vertex, where the model is fixed. On AI Studio the model is
 * resolved by a fallback chain, so before the first successful call this
 * returns the first candidate — the one that will be tried first, and in
 * practice the one that answers. A row mislabelled that way costs one
 * needless re-embed on the next run, never a silent mismatch.
 */
export function currentEmbeddingModel(): string {
  if (isVertexEmbeddingsEnabled()) return VERTEX_EMBEDDING_MODEL;
  return _resolvedEmbeddingModel ?? EMBEDDING_MODELS_TO_TRY[0];
}

/**
 * Embed a single piece of text. Routes through Vertex AI when configured
 * (GCP_PROJECT_ID + GOOGLE_APPLICATION_CREDENTIALS_JSON set) — Vertex's
 * text-embedding-005 is provisioned-warm and returns in <1s consistently,
 * eliminating the 30-40s cold-start outliers we hit on AI Studio's
 * gemini-embedding-001.
 *
 * Falls back to the AI Studio model-fallback chain when Vertex isn't
 * configured (preserves zero-config local dev + safe rollback).
 *
 * Throws on real errors (auth, rate limit, network) so the caller can
 * decide whether to retry.
 */
export async function embedText(text: string): Promise<EmbedTextResult> {
  const clean = text.trim();
  if (clean.length === 0) {
    throw new Error("embedText called with empty input");
  }
  const truncated = clean.length > 2000 ? clean.slice(0, 2000) : clean;

  // Vertex path — predictable model, no fallback chain needed because
  // text-embedding-005 is always GA on Vertex projects with billing.
  //
  // Counted like every other Google call (see lib/ai/quota-telemetry.ts).
  // Embeddings share a project quota bucket with generation, and a full
  // category re-embed is ~27,700 calls in a burst — by far the heaviest
  // thing this system ever does to that quota, so it is exactly the
  // workload peak concurrency needs to be visible for.
  if (isVertexEmbeddingsEnabled()) {
    return trackGeminiCall(() => embedViaVertex(truncated));
  }

  // AI Studio fast path: we've already resolved a working model
  if (_resolvedEmbeddingModel) {
    const result = await tryEmbedOneModel(_resolvedEmbeddingModel, truncated);
    if ("vector" in result) return result;
    // The cached model stopped working (rare); fall through to discovery.
    console.warn(
      `[embeddings] cached model ${_resolvedEmbeddingModel} returned skip: ${result.skipReason}. Rediscovering.`,
    );
    _resolvedEmbeddingModel = null;
  }

  // AI Studio model-discovery loop.
  const skipReasons: string[] = [];
  for (const modelName of EMBEDDING_MODELS_TO_TRY) {
    const result = await tryEmbedOneModel(modelName, truncated);
    if ("vector" in result) {
      _resolvedEmbeddingModel = modelName;
      console.info(`[embeddings] using model: ${modelName} backend=ai-studio`);
      return result;
    }
    skipReasons.push(`${modelName}: ${result.skipReason}`);
  }

  throw new Error(
    `embedText: no embedding model available on this API key. Tried: ${skipReasons.join(" | ")}`,
  );
}

/**
 * Embed many texts in batches. Helpful for backfilling the
 * jumia_categories table without hammering the rate limit.
 *
 * Returns an array same length as input. Each slot is either:
 *   - EmbedTextResult on success
 *   - { error: "..." } on failure (so the caller can surface why,
 *     not just "null = failed")
 *
 * Concurrency is capped at 5 in-flight requests — embedding endpoints
 * share a quota bucket with text generation, so higher concurrency
 * risks 429s.
 */
export type EmbedBatchSlot =
  | EmbedTextResult
  | { error: string };

export async function embedTextBatch(
  texts: string[],
  concurrency = 5,
): Promise<EmbedBatchSlot[]> {
  const out: EmbedBatchSlot[] = new Array(texts.length).fill(null) as EmbedBatchSlot[];
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= texts.length) return;
      try {
        out[i] = await embedText(texts[i]);
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        console.warn(`[embeddings] embedText failed for idx=${i}: ${msg.slice(0, 200)}`);
        out[i] = { error: msg };
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}

/**
 * Format a SQL-ready pgvector literal: `[0.1,0.2,...]`. Use when
 * binding the vector into a parameterised query — pgvector accepts
 * either array syntax or the bracketed literal.
 */
export function toPgvectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
