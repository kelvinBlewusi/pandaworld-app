/**
 * Print recent Jumia rejects that might still need a gate + test.
 *
 * The "promote" workflow (CONTRIBUTING.md) is manual: read a rejected
 * row's raw_error from jumia_feed_outcomes, decide whether it's a new
 * class, add a preflight/listing-ready gate or a classifyJumiaRejection
 * branch, and lock it in with a test using the exact string. This script
 * does the tedious first part of that — scanning what actually happened
 * in production — so a promote pass starts from a short list instead of a
 * blank page.
 *
 * Flags a row when EITHER is true:
 *   - classifyJumiaRejection(raw_error).kind === "unknown" (nothing
 *     recognises this shape yet)
 *   - none of the five test files CONTRIBUTING.md names appears to
 *     contain this string (a cheap, deliberately approximate substring
 *     check — a real match still needs a human to confirm it tests the
 *     SAME thing, not just that the words happen to appear)
 *
 * Run:
 *   npm run print-unfixed-rejects
 *
 * Required env vars: same as the rest of the app (NEXT_PUBLIC_SUPABASE_URL
 * + SUPABASE_SERVICE_ROLE_KEY, or NEXT_PUBLIC_SUPABASE_ANON_KEY as a
 * read-only fallback).
 */

import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyJumiaRejection } from "../lib/jumia/rejection-remedy";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "✗ Missing Supabase credentials. Set NEXT_PUBLIC_SUPABASE_URL and " +
    "SUPABASE_SERVICE_ROLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY) in .env.local " +
    "or your shell environment.",
  );
  process.exit(1);
}

// The five files CONTRIBUTING.md names as where a Jumia-reject fix's test
// belongs — kept in sync with that list by hand.
const TEST_FILES = [
  "__tests__/rejection-remedy.test.ts",
  "__tests__/jumia-preflight.test.ts",
  "__tests__/listing-ready.test.ts",
  "__tests__/prohibited-catalog.test.ts",
  "__tests__/restricted-words.test.ts",
];

function loadTestSource(): string {
  return TEST_FILES
    .map((f) => {
      try {
        return readFileSync(join(process.cwd(), f), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n---\n");
}

/** A short, normalized excerpt of the raw error to search test source
 *  for — the full string rarely appears verbatim (tests often assert on
 *  a fragment, or the message carries listing-specific values like a
 *  SKU), so this checks a truncated, lowercased slice instead of an
 *  exact match. */
function excerptFor(rawError: string): string {
  return rawError.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 40);
}

async function main() {
  const db = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await db
    .from("jumia_feed_outcomes")
    .select("id, listing_id, outcome, raw_error, category_code, country, created_at")
    .in("outcome", ["rejected", "blocked_locally"])
    .not("raw_error", "is", null)
    .order("created_at", { ascending: false })
    .limit(500);

  if (error) {
    console.error("✗ Supabase query failed:", error.message);
    process.exit(2);
  }

  const rows = data ?? [];
  if (rows.length === 0) {
    console.info("No rejected/blocked_locally rows in jumia_feed_outcomes yet.");
    return;
  }

  const testSource = loadTestSource().toLowerCase();
  const seen = new Set<string>();
  let flagged = 0;

  for (const row of rows) {
    const rawError = String(row.raw_error ?? "");
    if (!rawError.trim()) continue;

    const remedy = classifyJumiaRejection(rawError);
    const excerpt = excerptFor(rawError);
    const covered = excerpt.length > 0 && testSource.includes(excerpt);

    if (remedy.kind !== "unknown" && covered) continue;

    // De-dupe on the excerpt, not the row — the same class rejects many
    // listings, and this is meant to be a short promote list, not a log.
    if (seen.has(excerpt)) continue;
    seen.add(excerpt);
    flagged++;

    console.info(
      `\n— ${row.outcome} · kind=${remedy.kind} · category=${row.category_code ?? "?"} · country=${row.country ?? "?"}`,
    );
    console.info(`  raw_error: ${rawError}`);
    if (!covered) console.info("  ⚠ no test file appears to cover this string");
    if (remedy.kind === "unknown") console.info("  ⚠ classifyJumiaRejection doesn't recognise this shape");
  }

  console.info(`\n${flagged} distinct class(es) flagged out of ${rows.length} row(s) checked.`);
}

main().catch((e) => {
  console.error("✗ Script failed:", e);
  process.exit(1);
});
