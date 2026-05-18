import { auth } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import { isAdmin } from "@/lib/auth/is-admin";
import { createServerClient } from "@/lib/supabase/server";
import { selectAllPaginated } from "@/lib/supabase/paginate";
import { getBrandsLastSyncedAt } from "@/lib/jumia/brands";
import { AdminBrandsClient } from "./client";

// ─── Admin Brands Page ───────────────────────────────────────────────────────
//
// Server-gated by isAdmin(). Mirrors /admin/categories — non-admins get
// a 404 so the existence of the admin surface isn't leaked. Admins see
// the status card + batched-sync UI and a small diagnostic that bucket
// brands by first letter (helps confirm a sync pulled the whole A–Z
// range and didn't get stuck inside one letter).

export const dynamic = "force-dynamic";

export default async function AdminBrandsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");
  if (!isAdmin(userId)) notFound();

  const db = createServerClient();
  const { count: total } = await db
    .from("jumia_brands")
    .select("*", { count: "exact", head: true });
  const lastSyncedAt = await getBrandsLastSyncedAt();

  // Diagnostic: distribution by first letter. If a sync stalled mid-walk
  // we'd see big gaps (e.g. 0 entries for letters M–Z). Pages through in
  // 1000-row chunks since Supabase's hard max_rows cap (default 1000)
  // overrides any single-call .range().
  const nameRows = await selectAllPaginated<{ name: string }>((from, to) =>
    db.from("jumia_brands").select("name").range(from, to),
  );

  const firstLetterCounts: Record<string, number> = {};
  for (const r of nameRows) {
    const name = String(r.name ?? "").trim();
    if (!name) continue;
    const ch = name[0].toUpperCase();
    const bucket = /[A-Z]/.test(ch) ? ch : "#"; // digits / symbols pool
    firstLetterCounts[bucket] = (firstLetterCounts[bucket] ?? 0) + 1;
  }
  // Keep A–Z order for the UI (not most-frequent first) so gaps are
  // visually obvious. (String.split gives an array regardless of
  // downlevelIteration / target settings; spreading a string literal
  // requires es2015+, which we can't assume in this tsconfig.)
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("").concat("#");
  const firstLetterDistribution = letters.map((name) => ({
    name,
    count: firstLetterCounts[name] ?? 0,
  }));

  return (
    <AdminBrandsClient
      initialTotal={total ?? 0}
      initialLastSyncedAt={lastSyncedAt}
      firstLetterDistribution={firstLetterDistribution}
    />
  );
}
