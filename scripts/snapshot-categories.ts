/**
 * Snapshot the current `jumia_categories` table to a bundled JSON file
 * that ships with the repo. The seed function in lib/jumia/categories.ts
 * reads this file to bootstrap fresh deployments — so the picker is
 * never blank before the admin's first manual sync.
 *
 * Run from the project root after a successful admin sync:
 *
 *   npm run snapshot-categories
 *
 * Required env vars (same as the rest of the app):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (or NEXT_PUBLIC_SUPABASE_ANON_KEY if RLS allows read)
 *
 * The script overwrites supabase/seed/jumia-categories.json. Commit
 * the result so the new baseline ships with the next deploy.
 *
 * Cadence: re-run quarterly, or after Jumia has added notable new
 * categories you want to ship to fresh deploys without waiting for the
 * first admin sync.
 */

import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

// Run via: npm run snapshot-categories
// The npm script uses Node's built-in --env-file flag to load .env.local
// automatically. (Node 20+.) If you need to load both .env and .env.local,
// pass multiple flags or invoke the script directly.

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

const OUTPUT_PATH = join(process.cwd(), "supabase/seed/jumia-categories.json");

async function main() {
  const t0 = Date.now();
  console.info(`▶ Snapshotting jumia_categories from ${SUPABASE_URL}…`);

  const db = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await db
    .from("jumia_categories")
    .select(
      "code, name, path, parent_code, level, is_leaf, attribute_set_sid, attribute_set_name",
    )
    .order("code");

  if (error) {
    console.error("✗ Supabase query failed:", error.message);
    process.exit(2);
  }
  if (!data || data.length === 0) {
    console.warn(
      "⚠ No categories in jumia_categories. Run the admin sync first " +
      "(/admin/categories → Refresh from Jumia), then re-run this script.",
    );
    process.exit(3);
  }

  // Ensure the seed directory exists.
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });

  // Pretty-print so diffs are reviewable.
  writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");

  const totalListable = data.filter((c) => c.attribute_set_sid != null).length;
  console.info(
    `✓ Wrote ${data.length} categories (${totalListable} listable) to ` +
    `${OUTPUT_PATH} in ${Date.now() - t0}ms.`,
  );
  console.info("  Commit the file so the new baseline ships with the next deploy.");
}

main().catch((err) => {
  console.error("✗ Snapshot failed:", err);
  process.exit(99);
});
