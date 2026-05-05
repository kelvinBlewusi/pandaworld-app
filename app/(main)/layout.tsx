import { Sidebar } from "@/components/layout/Sidebar";
import { getDashboardStats } from "@/lib/actions/listings";

export default async function MainLayout({
  children,
}: {
  children: React.ReactNode;
}) {
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
