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
import { embedTextBatch, toPgvectorLiteral } from "@/lib/ai/embeddings";

export interface EmbedCategoriesResult {
  embedded: number;
  remaining: number;
  done: boolean;
  embed_errors: Array<{ code: number; path: string; error: string }>;
  update_errors: Array<{ code: number; error: string }>;
  attempted: number;
}

export async function embedPendingCategories(batchSize: number): Promise<EmbedCategoriesResult> {
  const db = createServerClient();

  // 1. Fetch the next batch of unembedded categories. Sorted by code so
  //    successive runs predictably chew through the table from low → high.
  const { data: pending, error: fetchErr } = await db
    .from("jumia_categories")
    .select("code, name, path, attribute_set_name")
    .is("embedding", null)
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

  // 3. Embed in parallel (capped concurrency to respect rate limits).
  const results = await embedTextBatch(texts, 5);

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
      const { error: updateErr } = await db
        .from("jumia_categories")
        .update({ embedding: literal })
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

  // 5. How many still need embedding?
  const { count: remaining } = await db
    .from("jumia_categories")
    .select("code", { count: "exact", head: true })
    .is("embedding", null);

  const done = (remaining ?? 0) === 0;

  console.info(
    `[embed-categories] ${embedded} embedded this run; ${remaining ?? 0} remaining; done=${done}; embed_errors=${embedErrors.length}; update_errors=${updateErrors.length}`,
  );

  return { embedded, remaining: remaining ?? 0, done, embed_errors: embedErrors, update_errors: updateErrors, attempted: pending.length };
}
