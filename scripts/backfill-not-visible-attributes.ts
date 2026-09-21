/**
 * One-off (and safely re-runnable) sweep: mine every historical "Attribute
 * [x] is not visible for category [y]" rejection out of jumia_feed_outcomes
 * and correct jumia_category_attributes for every category involved, not
 * just whichever one a seller happens to hit next.
 *
 * Why this needed a script rather than waiting on the reactive fix
 * (classifyJumiaRejection's "not_visible_attributes" remedy, lib/jumia/
 * rejection-remedy.ts): Jumia's /catalog/attribute-sets/{sid} endpoint is
 * a SHARED template — the sid backing "Compact Refrigerators" alone is
 * reused by 1,643 unrelated categories in our synced tree, and several
 * other sids are shared by 1,000-5,000+ categories each. Every one of
 * those categories can carry the identical stale-cache problem, and the
 * reactive fix only corrects a category the moment a live seller happens
 * to push to it and gets rejected. This script closes that gap for every
 * rejection we've already logged, instead of waiting for it to recur.
 *
 * Confirmed live, 2026-09-21 (category 1022994, "Compact Refrigerators"):
 * the rejection a seller saw named 7 attributes, but a FULLER historical
 * rejection for the same category in jumia_feed_outcomes named 9 — two
 * more (warranty_duration, package_content) that hadn't shown up yet.
 * Scanning full history rather than only the latest error per listing is
 * why this script exists instead of just re-running the seller's own
 * error string once.
 *
 * Run:
 *   npm run backfill-not-visible-attributes
 *
 * Required env vars: same as the rest of the app (NEXT_PUBLIC_SUPABASE_URL
 * + SUPABASE_SERVICE_ROLE_KEY).
 */

import { createClient } from "@supabase/supabase-js";
import { extractNotVisibleAttributeNames } from "../lib/jumia/rejection-remedy";
import { removeAttributesFromCache } from "../lib/jumia/categories";

const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "✗ Missing Supabase credentials. Set NEXT_PUBLIC_SUPABASE_URL and " +
    "SUPABASE_SERVICE_ROLE_KEY in .env.local or your shell environment. " +
    "(A read-only anon key isn't enough — this script writes to " +
    "jumia_category_attributes.)",
  );
  process.exit(1);
}

const PAGE_SIZE = 1000;

async function main() {
  const db = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const rows: Array<{ category_code: string | null; raw_error: string }> = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from("jumia_feed_outcomes")
      .select("category_code, raw_error")
      .eq("outcome", "rejected")
      .ilike("raw_error", "%is not visible for category%")
      .range(from, from + PAGE_SIZE - 1);

    if (error) {
      console.error("✗ Supabase query failed:", error.message);
      process.exit(2);
    }
    const page = (data ?? []) as typeof rows;
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }

  console.info(`Scanning ${rows.length} logged "not visible for category" rejection(s)...`);

  // category_code -> union of every attribute name Jumia has ever named
  // as not-visible for it, across every rejection on record.
  const byCategory = new Map<number, Set<string>>();
  let skippedNoCategory = 0;
  let skippedNoNames = 0;

  for (const row of rows) {
    const categoryCode = row.category_code ? parseInt(row.category_code, 10) : NaN;
    if (!categoryCode || Number.isNaN(categoryCode)) {
      skippedNoCategory++;
      continue;
    }
    const names = extractNotVisibleAttributeNames(row.raw_error);
    if (names.length === 0) {
      skippedNoNames++;
      continue;
    }
    const set = byCategory.get(categoryCode) ?? new Set<string>();
    for (const n of names) set.add(n);
    byCategory.set(categoryCode, set);
  }

  if (skippedNoCategory > 0) console.info(`  (${skippedNoCategory} row(s) had no usable category_code — skipped)`);
  if (skippedNoNames > 0) console.info(`  (${skippedNoNames} row(s) matched the phrase but named no extractable attribute — skipped)`);

  if (byCategory.size === 0) {
    console.info("Nothing to correct — no category had an extractable not-visible attribute.");
    return;
  }

  console.info(`\n${byCategory.size} categor${byCategory.size === 1 ? "y needs" : "ies need"} correcting:\n`);

  let totalRemoved = 0;
  for (const [categoryCode, names] of Array.from(byCategory.entries())) {
    const nameList = Array.from(names);
    const { data: existing } = await db
      .from("jumia_category_attributes")
      .select("name")
      .eq("category_code", categoryCode)
      .in("name", nameList);
    const stillCached = (existing ?? []).map((r) => (r as { name: string }).name);

    console.info(`— category ${categoryCode}: ${nameList.join(", ")}`);
    if (stillCached.length === 0) {
      console.info("  (already clean — none of these are in the cache anymore)");
      continue;
    }
    console.info(`  removing ${stillCached.length} row(s) still cached: ${stillCached.join(", ")}`);

    await removeAttributesFromCache(categoryCode, nameList);
    totalRemoved += stillCached.length;
  }

  console.info(`\nDone. ${totalRemoved} stale attribute row(s) removed across ${byCategory.size} categor${byCategory.size === 1 ? "y" : "ies"}.`);
}

main().catch((e) => {
  console.error("✗ Script failed:", e);
  process.exit(1);
});
