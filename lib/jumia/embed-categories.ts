/**
 * Category-embedding backfill — the pipeline behind POST
 * /api/admin/embed-categories, extracted so a scheduled cron (see
 * app/api/cron/embed-categories/route.ts) can run the exact same batch
 * unconditionally instead of needing an admin to click "run" repeatedly
 * until { done: true }.
 *
 * Idempotent — only touches jumia_categories rows where embedding IS
 * NULL, so re-running (or running on a daily schedule) only ever costs
 * work for categories a sync has newly added since the last run.
 */

import { createServerClient } from "@/lib/supabase/server";
import { embedTextBatch, toPgvectorLiteral, currentEmbeddingModel } from "@/lib/ai/embeddings";

export interface EmbedCategoriesResult {
  embedded: number;
  remaining: number;
  done: boolean;
  embed_errors: Array<{ code: number; path: string; error: string }>;
  update_errors: Array<{ code: number; error: string }>;
  attempted: number;
}

/** In-flight embed calls per batch. See the note at its use site. */
const EMBED_CONCURRENCY = 10;

export async function embedPendingCategories(batchSize: number): Promise<EmbedCategoriesResult> {
  const db = createServerClient();
  const model = currentEmbeddingModel();

  // 1. Fetch the next batch of categories that need embedding: never
  //    embedded, OR embedded by a DIFFERENT model than the one in use.
  //
  //    That second clause is the whole point. This used to select only
  //    `WHERE embedding IS NULL`, which meant that once coverage hit
  //    100% the daily cron became a permanent no-op — it could not
  //    rewrite a stale vector even in principle. So when embedding
  //    queries moved from AI Studio's gemini-embedding-001 to Vertex's
  //    text-embedding-005 (2026-05-29), the 27,720-row index stayed in
  //    the old vector space and no scheduled job could ever heal it.
  //    Both models emit 768 dimensions, so nothing errored; pgvector
  //    just compared unrelated spaces and returned confident nonsense
  //    for four months.
  //
  //    Keying on the model instead makes a backend switch self-healing:
  //    the next run simply re-embeds whatever no longer matches.
  //    Sorted by code so successive runs predictably chew through the
  //    table from low → high.
  const staleFilter = `embedding.is.null,embedding_model.is.null,embedding_model.neq.${model}`;

  const { data: pending, error: fetchErr } = await db
    .from("jumia_categories")
    .select("code, name, path, attribute_set_name")
    .or(staleFilter)
    .order("code")
    .limit(batchSize);

  if (fetchErr) {
    console.error("[embed-categories] fetch failed:", fetchErr.message);
    throw new Error(fetchErr.message);
  }

  if (!pending || pending.length === 0) {
    return { embedded: 0, remaining: 0, done: true, embed_errors: [], update_errors: [], attempted: 0 };
  }

  // 2. Build the text to embed for each category — full path + attribute
  //    set name captures the most semantic information (e.g. "Phones &
  //    Tablets > Mobile Phones > Smartphones" embeds better than just
  //    "Smartphones").
  const texts = pending.map((c) => {
    const parts = [c.path];
    if (c.attribute_set_name) parts.push(`(${c.attribute_set_name})`);
    return parts.join(" ");
  });

  // 3. Embed in parallel.
  //
  //    embedTextBatch defaults to 5, chosen when AI Studio was the only
  //    backend and embeddings shared a tight quota bucket with text
  //    generation. On Vertex, text-embedding-005 is provisioned-warm with
  //    far more headroom, and this job is the one workload where the
  //    difference matters: a full re-embed is ~27,700 calls, and at 5 in
  //    flight (~0.5s each) that is over an hour of wall clock.
  //
  //    Kept deliberately moderate rather than maximal — this shares a
  //    project quota with the analysis pipeline, and starving a seller's
  //    draft to finish a backfill faster is a bad trade. Every call is
  //    counted (lib/ai/quota-telemetry.ts), so if this ever does push the
  //    project into 429s it shows up as quotaErrors rather than as
  //    mysterious drafting failures.
  const results = await embedTextBatch(texts, EMBED_CONCURRENCY);

  // 4. Update each row that got a successful embedding.
  const embedErrors: Array<{ code: number; path: string; error: string }> = [];
  const updateErrors: Array<{ code: number; error: string }> = [];
  let embedded = 0;

  await Promise.all(
    pending.map(async (cat, i) => {
      const slot = results[i];
      if (!("vector" in slot)) {
        if (embedErrors.length < 10) {
          embedErrors.push({ code: cat.code, path: cat.path, error: slot.error.slice(0, 300) });
        }
        return;
      }

      const literal = toPgvectorLiteral(slot.vector);
      // Stamp the model alongside the vector, always in the same write.
      // A vector without its model is exactly the state that made the
      // 2026-05 mismatch undetectable.
      const { error: updateErr } = await db
        .from("jumia_categories")
        .update({ embedding: literal, embedding_model: slot.model })
        .eq("code", cat.code);

      if (updateErr) {
        if (updateErrors.length < 10) {
          updateErrors.push({ code: cat.code, error: updateErr.message.slice(0, 300) });
        }
        console.warn(`[embed-categories] update failed for code=${cat.code}: ${updateErr.message}`);
      } else {
        embedded++;
      }
    }),
  );

  // 5. How many still need embedding — same predicate as the fetch, or
  //    the loop in app/api/cron/embed-categories would stop early while
  //    stale rows remained.
  const { count: remaining } = await db
    .from("jumia_categories")
    .select("code", { count: "exact", head: true })
    .or(staleFilter);

  const done = (remaining ?? 0) === 0;

  console.info(
    `[embed-categories] model=${model}; ${embedded} embedded this run; ${remaining ?? 0} remaining; done=${done}; embed_errors=${embedErrors.length}; update_errors=${updateErrors.length}`,
  );

  return { embedded, remaining: remaining ?? 0, done, embed_errors: embedErrors, update_errors: updateErrors, attempted: pending.length };
}
