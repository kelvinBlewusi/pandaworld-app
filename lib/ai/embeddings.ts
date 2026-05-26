/**
 * Text embeddings via Google text-embedding-004.
 *
 * Used for:
 *   - Embedding the Jumia category tree once (backfill + on sync)
 *   - Embedding product descriptions at auto-analyze time
 *   - pgvector cosine-similarity lookups (see
 *     lib/jumia/category-search.ts → searchCategoriesByEmbedding)
 *
 * Cost-aware: text-embedding-004 is essentially free at our scale
 * (~$0.00001 per 1k tokens). Embedding all ~10k Jumia categories
 * once costs ~$0.10. Per-listing embedding ~$0.0001.
 *
 * REST-based (the JS SDK didn't expose embeddings cleanly when this
 * was written). Single fetch per call, 768-dim float32 vector
 * returned as a plain JS number[].
 */

const EMBEDDING_MODEL = "text-embedding-004";
const EMBED_TIMEOUT_MS = 20_000;

export interface EmbedTextResult {
  /** 768-dim cosine-normalised vector. */
  vector: number[];
  /** Model used (lets callers spot drift if we ever swap models). */
  model: string;
}

/**
 * Embed a single piece of text. Returns the 768-dim vector or throws
 * on failure (no silent fallbacks — the caller decides whether to
 * skip the row or retry).
 *
 * Empty / whitespace-only input throws — embeddings of empty
 * strings are useless and waste a quota credit.
 */
export async function embedText(text: string): Promise<EmbedTextResult> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY not set");

  const clean = text.trim();
  if (clean.length === 0) {
    throw new Error("embedText called with empty input");
  }

  // Truncate at 2000 chars — text-embedding-004 supports up to
  // 2048 tokens (~8000 chars) but we never need more than a few
  // hundred chars for category names or product descriptions. Keeps
  // latency predictable.
  const truncated = clean.length > 2000 ? clean.slice(0, 2000) : clean;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;

  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      model:   `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text: truncated }] },
    }),
    signal:  AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`embedText failed: ${res.status} ${errText.slice(0, 300)}`);
  }

  const data = (await res.json()) as {
    embedding?: { values?: number[] };
  };

  const vector = data.embedding?.values;
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error("embedText: empty embedding returned");
  }
  // Sanity check on dimension — text-embedding-004 always returns 768.
  // If this fails the model changed and our pgvector column is wrong.
  if (vector.length !== 768) {
    throw new Error(
      `embedText: expected 768-dim vector, got ${vector.length}. Migration needed.`,
    );
  }

  return { vector, model: EMBEDDING_MODEL };
}

/**
 * Embed many texts in batches. Helpful for backfilling the
 * jumia_categories table without hammering the rate limit.
 *
 * Concurrency is capped at 5 in-flight requests — text-embedding-004
 * is on the same Gemini quota bucket as the Flash text models, so
 * higher concurrency risks 429s. Returns results in the same order
 * as the input.
 *
 * Failed embeddings come back as `null` so the caller can skip the
 * row and retry later.
 */
export async function embedTextBatch(
  texts: string[],
  concurrency = 5,
): Promise<Array<EmbedTextResult | null>> {
  const out: Array<EmbedTextResult | null> = new Array(texts.length).fill(null);
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= texts.length) return;
      try {
        out[i] = await embedText(texts[i]);
      } catch (e) {
        console.warn(`[embeddings] embedText failed for idx=${i}: ${(e as Error).message}`);
        out[i] = null;
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
  // No spaces; pgvector parses `[1,2,3]` faster than `[1, 2, 3]`.
  return `[${vector.join(",")}]`;
}
