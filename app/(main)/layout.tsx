import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { MainShell } from "@/components/layout/MainShell";
import { getDashboardStats } from "@/lib/actions/listings";
import { createServerClient } from "@/lib/supabase/server";

export default async function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId } = await auth();

  if (userId) {
    const db = createServerClient();
    const { count } = await db
      .from("jumia_connections")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("status", "active");

    if (!count || count === 0) {
      redirect("/onboarding/channel");
    }
  }

  const stats = await getDashboardStats();

  return <MainShell workflowCounts={stats}>{children}</MainShell>;
}
