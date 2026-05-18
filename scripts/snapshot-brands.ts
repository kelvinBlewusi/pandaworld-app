/**
 * Snapshot the current `jumia_brands` table to a bundled JSON file that
 * ships with the repo. The seed function in lib/jumia/brands.ts reads
 * this file to bootstrap fresh deployments — so brand resolution at
 * push time works even before the admin runs their first manual sync.
 *
 * Run from the project root after a successful admin sync at
 * /admin/brands:
 *
 *   npm run snapshot-brands
 *
 * Required env vars (same as the rest of the app):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   (or NEXT_PUBLIC_SUPABASE_ANON_KEY if RLS allows read)
 *
 * The script overwrites supabase/seed/jumia-brands.json. Commit the
 * result so the new baseline ships with the next deploy.
 */

import { createClient } from "@supabase/supabase-js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

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

const OUTPUT_PATH = join(process.cwd(), "supabase/seed/jumia-brands.json");

async function main() {
  const t0 = Date.now();
  console.info(`▶ Snapshotting jumia_brands from ${SUPABASE_URL}…`);

  const db = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Page through in 1000-row chunks — Supabase's hard server-side
  // max_rows cap (default 1000) overrides any single-call .range().
  // Without paging we'd ship a tiny snapshot that's useless as a
  // day-1 safety net.
  const PAGE = 1000;
  const data: Array<Record<string, unknown>> = [];
  let from = 0;
  for (let i = 0; i < 200; i++) {
    const to = from + PAGE - 1;
    const { data: chunk, error } = await db
      .from("jumia_brands")
      .select("code, name")
      .order("code")
      .range(from, to);
    if (error) {
      console.error("✗ Supabase query failed:", error.message);
      process.exit(2);
    }
    if (!chunk || chunk.length === 0) break;
    data.push(...chunk);
    if (chunk.length < PAGE) break;
    from = to + 1;
  }

  if (data.length === 0) {
    console.warn(
      "⚠ No brands in jumia_brands. Run the admin sync first " +
      "(/admin/brands → Refresh from Jumia), then re-run this script.",
    );
    process.exit(3);
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2) + "\n", "utf8");

  console.info(
    `✓ Wrote ${data.length} brands to ${OUTPUT_PATH} in ${Date.now() - t0}ms.`,
  );
  console.info("  Commit the file so the new baseline ships with the next deploy.");
}

main().catch((e) => {
  console.error("✗ Unexpected error:", e);
  process.exit(99);
});
