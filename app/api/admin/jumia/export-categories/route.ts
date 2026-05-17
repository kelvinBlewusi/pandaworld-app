import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import { fetchAndCacheCategoryTree } from "@/lib/jumia/categories";

// Vercel serverless function timeout. The category-list walk takes
// ~5-10s; we set 60s as a comfortable Hobby-tier-compatible ceiling.
// If you upgrade to Pro you can raise this up to 300; Enterprise up to
// 900. This export DOES NOT walk attribute schemas (those land on demand
// via /api/jumia/categories/[code]/attributes), so 60s is plenty.
export const maxDuration = 60;

// ─── GET /api/admin/jumia/export-categories ───────────────────────────────────
//
// Dumps the full Jumia category tree from Supabase as a CSV file. Designed
// for opening directly in a browser — Content-Disposition triggers a
// download, then the seller drags the file into Google Sheets (File →
// Import → Upload → Replace spreadsheet OR comma-separated paste).
//
// Query params:
//   ?live=1   — re-sync from Jumia BEFORE exporting (slow: ~30-60s). Default
//               just dumps the existing Supabase cache. Use ?live=1 when
//               comparing against Vendor Center's current list.
//   ?format=tsv — tab-separated instead of comma-separated. Useful for
//               direct paste into Google Sheets without an import dialog
//               (tabs auto-split into columns).
//
// Columns:
//   Code, L1, L2, L3, L4, L5, FullPath, Listable, IsLeaf,
//   AttributeSetName, AttributeSetSid, SyncedAt
//
// L1–L5 break the breadcrumb path into hierarchy columns so you can group
// / filter / pivot in Sheets. FullPath is the original "L1 > L2 > L3"
// string for reference. Listable is YES iff attribute_set_sid is non-null
// (the canonical Jumia signal — see lib/jumia/categories.ts).

export async function GET(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const live   = req.nextUrl.searchParams.get("live")   === "1";
  const format = req.nextUrl.searchParams.get("format") === "tsv" ? "tsv" : "csv";

  // Optional: re-sync the category LIST from Jumia before dumping. The
  // category list alone walks ~10 pages in ~5-10s; we deliberately SKIP
  // the per-category attribute walk here (~80-100s, would time out the
  // Vercel function and produces data not even used in the CSV anyway).
  // Attribute schemas are fetched on demand by the picker via
  // /api/jumia/categories/[code]/attributes when a seller actually needs
  // them. Soft-fails — if sync errors out, we fall through to cache.
  if (live) {
    try {
      const { accessToken } = await getValidJumiaCredentials(userId);
      const result = await fetchAndCacheCategoryTree(accessToken, { syncAttributes: false });
      console.info(
        `[export-categories] Live sync complete — ${result.categories} categories refreshed`,
      );
    } catch (e) {
      console.warn(`[export-categories] Live sync failed (${(e as Error).message}); using cached data`);
    }
  }

  // ── Read every category from cache, sorted by full path ───────────────────
  const db = createServerClient();
  const { data, error } = await db
    .from("jumia_categories")
    .select("code, name, path, attribute_set_sid, attribute_set_name, is_leaf, synced_at")
    .order("path");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as Array<{
    code:               number;
    name:               string;
    path:               string;
    attribute_set_sid:  string | null;
    attribute_set_name: string | null;
    is_leaf:            boolean | null;
    synced_at:          string | null;
  }>;

  // ── Build CSV ─────────────────────────────────────────────────────────────
  const sep = format === "tsv" ? "\t" : ",";
  const header = [
    "Code", "L1", "L2", "L3", "L4", "L5",
    "FullPath", "Listable", "IsLeaf",
    "AttributeSetName", "AttributeSetSid", "SyncedAt",
  ];

  const escape = (v: string | number | null | undefined): string => {
    if (v == null) return "";
    const s = String(v);
    if (format === "tsv") {
      // TSV: strip tabs and newlines; no other escaping.
      return s.replace(/[\t\r\n]/g, " ");
    }
    // CSV: RFC 4180 — quote if contains comma, quote, or newline. Double
    // any embedded quotes.
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines = [header.map(escape).join(sep)];

  for (const row of rows) {
    const parts = row.path.split(/\s*>\s*/);   // split on " > " breadcrumb separator
    const levels = [0, 1, 2, 3, 4].map((i) => parts[i] ?? "");
    const fullPath = row.path;
    const listable = row.attribute_set_sid != null ? "YES" : "NO";
    const isLeaf   = row.is_leaf ? "YES" : "NO";

    const values: Array<string | number | null> = [
      row.code,
      ...levels,
      fullPath,
      listable,
      isLeaf,
      row.attribute_set_name,
      row.attribute_set_sid,
      row.synced_at,
    ];
    lines.push(values.map(escape).join(sep));
  }

  const body = lines.join("\n") + "\n";
  const filename =
    `jumia-categories-${new Date().toISOString().slice(0, 10)}.${format}`;

  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type":        format === "tsv"
        ? "text/tab-separated-values; charset=utf-8"
        : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // No caching — the export should reflect the latest cache state.
      "Cache-Control":       "no-store",
      // Summary headers for quick scripting / debugging.
      "X-Category-Count":    String(rows.length),
      "X-Listable-Count":    String(rows.filter((r) => r.attribute_set_sid != null).length),
    },
  });
}
