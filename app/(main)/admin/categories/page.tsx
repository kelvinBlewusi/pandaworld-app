import { auth } from "@clerk/nextjs/server";
import { redirect, notFound } from "next/navigation";
import { isAdmin } from "@/lib/auth/is-admin";
import { createServerClient } from "@/lib/supabase/server";
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

  return (
    <AdminCategoriesClient
      initialTotal={total ?? 0}
      initialListable={listable ?? 0}
      initialLastSyncedAt={lastSyncedAt}
    />
  );
}
