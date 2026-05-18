import { auth } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import { isAdmin } from "@/lib/auth/is-admin";
import { createServerClient } from "@/lib/supabase/server";
import { selectAllPaginated } from "@/lib/supabase/paginate";
import { getCategoriesLastSyncedAt } from "@/lib/jumia/categories";
import { AdminCategoriesClient } from "./client";

// ─── Admin Categories Page ───────────────────────────────────────────────────
//
// Server-gated by isAdmin(). Non-admins get a 404 (rather than 403) so
// the existence of the admin surface isn't leaked. Admins see the
// status card + batched-sync UI.

export const dynamic = "force-dynamic";

export default async function AdminCategoriesPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");
  if (!isAdmin(userId)) notFound();

  // Initial stats — the client component refreshes these after each
  // sync round, so we just need the first paint.
  const db = createServerClient();
  const { count: total }    = await db
    .from("jumia_categories")
    .select("*", { count: "exact", head: true });
  const { count: listable } = await db
    .from("jumia_categories")
    .select("*", { count: "exact", head: true })
    .not("attribute_set_sid", "is", null);
  const lastSyncedAt = await getCategoriesLastSyncedAt();

  // Diagnostic: distribution of top-level paths. Helps confirm whether
  // the synced data is genuinely diverse or accidentally one-rooted
  // (e.g. only "Automobile" if pagination went wrong). Pages through
  // 1000-row chunks because Supabase's hard server-side max_rows cap
  // (default 1000) overrides any single-call .range() request.
  const pathRows = await selectAllPaginated<{ path: string }>((from, to) =>
    db.from("jumia_categories").select("path").range(from, to),
  );

  const topLevelCounts: Record<string, number> = {};
  for (const r of pathRows) {
    const raw = String(r.path ?? "");
    // Same normalisation as the drawer: collapse " / " or " > " to " > "
    const normalised = raw.replace(/\s*[>/]\s*/g, " > ").trim();
    const top = normalised.split(" > ")[0] || "(empty)";
    topLevelCounts[top] = (topLevelCounts[top] ?? 0) + 1;
  }
  const topLevelDistribution = Object.entries(topLevelCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({ name, count }));

  return (
    <AdminCategoriesClient
      initialTotal={total ?? 0}
      initialListable={listable ?? 0}
      initialLastSyncedAt={lastSyncedAt}
      topLevelDistribution={topLevelDistribution}
    />
  );
}
