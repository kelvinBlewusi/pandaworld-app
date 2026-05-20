import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { MainShell } from "@/components/layout/MainShell";
import { getDashboardStats } from "@/lib/actions/listings";
import { createServerClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/is-admin";
import { verifyJumiaConnection } from "@/lib/jumia/api";

export default async function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId } = await auth();

  if (userId) {
    const db = createServerClient();

    // First gate: do we have a connection row at all?
    const { count } = await db
      .from("jumia_connections")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "active");

    if (!count || count === 0) {
      redirect("/onboarding/channel");
    }

    // Second gate: is that connection ACTUALLY still valid on Jumia's
    // side? If the seller deleted their OAuth app from Vendor Center
    // (Manage Applications → trash), the DB status stays "active"
    // until something tries to use the token — which used to mean the
    // seller saw a "successful" dashboard right up until they clicked
    // Push and got a stale-token error. verifyJumiaConnection probes
    // /shops with a 60s cache so we detect within a minute (or less),
    // without making a Jumia call on every navigation.
    const health = await verifyJumiaConnection(userId);
    if (!health.ok && health.reason === "needs_reconnect") {
      redirect("/onboarding/connect?reason=disconnected");
    }
  }

  const stats = await getDashboardStats();
  const admin = isAdmin(userId);

  return <MainShell workflowCounts={stats} isAdmin={admin}>{children}</MainShell>;
}
