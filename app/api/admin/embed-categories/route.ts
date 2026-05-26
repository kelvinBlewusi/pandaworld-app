import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/billing/admin";
import { embedTextBatch, toPgvectorLiteral } from "@/lib/ai/embeddings";

// Embedding ~10k categories takes a few minutes total. Bump the
// serverless timeout above the default 10s. Each batch is processed
// in parallel (5 in flight) so total wall time ≈ 10k / 5 * 0.4s ≈ 13min
// — but we limit per-call to 200 categories, so a single invocation
// takes ~16s. Call repeatedly until done.
export const maxDuration = 60;

// ─── POST /api/admin/embed-categories ────────────────────────────────────────
//
// One-time (and ongoing) backfill of jumia_categories.embedding for
// rows that don't have one yet. Idempotent — re-running only touches
// rows where embedding IS NULL.
//
// Auth:
//   - Requires authenticated Clerk user
//   - Requires that user to be in ADMIN_USER_IDS (env-var allowlist)
//
// Body (optional):
//   { batch_size: number }   // how many categories to embed this call
//                            // (default 200; max 500 to stay inside the
//                            // 60s serverless timeout)
//
// Returns:
//   {
//     embedded: number,      // rows updated this run
//     remaining: number,     // rows still without an embedding
//     done: boolean,         // true if remaining === 0
//   }
//
// Usage:
//   curl -X POST https://pandaworldai.site/api/admin/embed-categories \
//        -H "Cookie: __session=..."   (your Clerk session cookie)
//   Repeat until { done: true }.

const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE     = 500;

export async function POST(req: NextRequest) {
  // Admin gate — env-var allowlist (lib/billing/admin.ts)
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });
  if (!isAdmin(userId)) {
    return new NextResponse("Forbidden — admin only", { status: 403 });
  }

  // Parse optional batch_size from the body
  let batchSize = DEFAULT_BATCH_SIZE;
  try {
    const body = await req.json().catch(() => ({}));
    if (typeof body.batch_size === "number" && body.batch_size > 0) {
      batchSize = Math.min(MAX_BATCH_SIZE, Math.floor(body.batch_size));
    }
  } catch { /* no body — that's fine */ }

  const db = createServerClient();

  // 1. Fetch the next batch of unembedded categories.
  //    Sorted by code so successive runs predictably chew through
  //    the table from low → high.
  const { data: pending, error: fetchErr } = await db
    .from("jumia_categories")
    .select("code, name, path, attribute_set_name")
    .is("embedding", null)
    .order("code")
    .limit(batchSize);

  if (fetchErr) {
    console.error("[embed-categories] fetch failed:", fetchErr.message);
    return NextResponse.json({ error: fetchErr.message }, { status: 500 });
  }

  if (!pending || pending.length === 0) {
    return NextResponse.json({
      embedded:  0,
      remaining: 0,
      done:      true,
    });
  }

  // 2. Build the text to embed for each category. We use the full path
  //    + attribute-set name because that captures the most semantic
  //    information (e.g. "Phones & Tablets > Mobile Phones > Smartphones"
  //    embeds better than just "Smartphones").
  const texts = pending.map((c) => {
    const parts = [c.path];
    if (c.attribute_set_name) parts.push(`(${c.attribute_set_name})`);
    return parts.join(" ");
  });

  // 3. Embed in parallel (capped concurrency to respect rate limits).
  const results = await embedTextBatch(texts, 5);

  // 4. Update each row that got a successful embedding. Collect errors
  //    along the way so we can surface them in the response — running the
  //    backfill is opaque otherwise (the route just keeps returning
  //    "0 embedded, N remaining" with no clue what's failing).
  const embedErrors: Array<{ code: number; path: string; error: string }> = [];
  const updateErrors: Array<{ code: number; error: string }> = [];
  let embedded = 0;

  await Promise.all(
    pending.map(async (cat, i) => {
      const slot = results[i];

      // Slot shape: { vector, model } on success, { error } on failure.
      if (!("vector" in slot)) {
        if (embedErrors.length < 10) {
          embedErrors.push({
            code:  cat.code,
            path:  cat.path,
            error: slot.error.slice(0, 300),
          });
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
          updateErrors.push({
            code:  cat.code,
            error: updateErr.message.slice(0, 300),
          });
        }
        console.warn(
          `[embed-categories] update failed for code=${cat.code}: ${updateErr.message}`,
        );
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

  return NextResponse.json({
    embedded,
    remaining: remaining ?? 0,
    done,
    // Diagnostics — empty arrays on a healthy run. Populated when
    // something's wrong so we can read it from the browser without
    // tailing Vercel logs.
    embed_errors:   embedErrors,
    update_errors:  updateErrors,
    attempted:      pending.length,
  });
}
