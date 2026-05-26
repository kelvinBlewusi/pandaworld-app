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

/** All produce 768-dim vectors compatible with our pgvector column. */
const EMBEDDING_MODELS_TO_TRY = [
  "text-embedding-004",      // current public name as of late 2024
  "gemini-embedding-001",    // newer alias on some accounts
  "embedding-001",           // legacy name still working on older keys
];

const EMBED_TIMEOUT_MS = 20_000;

// Cache the first model that works on this server process so we
// don't waste a fallback attempt on every single call.
let _resolvedEmbeddingModel: string | null = null;

export interface EmbedTextResult {
  /** 768-dim vector. */
  vector: number[];
  /** Model used (lets callers spot drift if we ever swap models). */
  model: string;
}

/**
 * Attempt the embed call against ONE specific model. Returns null
 * on a "model not available" error so the caller can try the next
 * one. Throws on real errors (auth, network, malformed response)
 * because retrying with a different model won't fix those.
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

  return { vector, model: modelName };
}

/**
 * Embed a single piece of text. Tries each model in
 * EMBEDDING_MODELS_TO_TRY until one returns a vector. Caches the
 * working model for subsequent calls.
 *
 * Throws on real errors (auth, rate limit, network) so the caller
 * can decide whether to retry. Throws only with the LAST error
 * encountered after exhausting the fallback list.
 */
export async function embedText(text: string): Promise<EmbedTextResult> {
  const clean = text.trim();
  if (clean.length === 0) {
    throw new Error("embedText called with empty input");
  }
  const truncated = clean.length > 2000 ? clean.slice(0, 2000) : clean;

  // Fast path: we've already resolved a working model
  if (_resolvedEmbeddingModel) {
    const result = await tryEmbedOneModel(_resolvedEmbeddingModel, truncated);
    if ("vector" in result) return result;
    // The cached model stopped working (rare); fall through to discovery.
    console.warn(
      `[embeddings] cached model ${_resolvedEmbeddingModel} returned skip: ${result.skipReason}. Rediscovering.`,
    );
    _resolvedEmbeddingModel = null;
  }

  const skipReasons: string[] = [];
  for (const modelName of EMBEDDING_MODELS_TO_TRY) {
    const result = await tryEmbedOneModel(modelName, truncated);
    if ("vector" in result) {
      _resolvedEmbeddingModel = modelName;
      console.info(`[embeddings] using model: ${modelName}`);
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
