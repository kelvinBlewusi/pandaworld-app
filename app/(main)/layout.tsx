import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { Sidebar } from "@/components/layout/Sidebar";
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

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-50/50">
      <Sidebar workflowCounts={stats} />
      <main className="flex-1 overflow-y-auto">
        <div className="min-h-full p-8">{children}</div>
      </main>
    </div>
  );
}
