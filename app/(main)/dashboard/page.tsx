import {
  FileText,
  CheckCircle,
  Clock,
  TrendingUp,
  Plus,
  ArrowRight,
  ShoppingBag,
  AlertCircle,
  Plug,
} from "lucide-react";
import Link from "next/link";
import { currentUser, auth } from "@clerk/nextjs/server";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/ui/stat-card";
import { ListingTable } from "@/components/ui/listing-table";
import { getDashboardStats, getListings } from "@/lib/actions/listings";
import { createServerClient } from "@/lib/supabase/server";
import { formatGHS, cn } from "@/lib/utils";
import { toListingDisplay } from "@/lib/types";
import type { JumiaConnectionPublic } from "@/lib/types/jumia";

async function getJumiaStatus(): Promise<JumiaConnectionPublic | null> {
  try {
    const { userId } = await auth();
    if (!userId) return null;
    const db = createServerClient();
    const { data } = await db
      .from("jumia_connections")
      .select("status, store_name, seller_email, connected_at, token_expires_at")
      .eq("user_id", userId)
      .maybeSingle();
    if (!data) return null;
    return {
      connected:        data.status === "active",
      status:           data.status as JumiaConnectionPublic["status"],
      store_name:       data.store_name ?? null,
      seller_name:      null,
      seller_email:     data.seller_email ?? null,
      seller_id:        null,
      connected_at:     data.connected_at ?? null,
      token_expires_at: data.token_expires_at ?? null,
    };
  } catch { return null; }
}

export default async function DashboardPage() {
  const [user, stats, allListings, jumia] = await Promise.all([
    currentUser(),
    getDashboardStats(),
    getListings(),
    getJumiaStatus(),
  ]);

  const firstName = user?.firstName ?? user?.username ?? "there";
  const recentListings = allListings.slice(0, 6).map(toListingDisplay);

  const hour = new Date().getHours();
  const greeting =
    hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">
            {greeting}, {firstName} 👋
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Here&apos;s what&apos;s happening with your listings today.
          </p>
        </div>
        <Button asChild className="gap-2">
          <Link href="/listings/new">
            <Plus className="h-4 w-4" />
            New listing
          </Link>
        </Button>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Draft listings"
          value={stats.draft}
          subtitle="Ready to publish"
          icon={<FileText className="h-5 w-5" />}
          gradient="lavender"
        />
        <StatCard
          title="Live listings"
          value={stats.live}
          subtitle="Active on Jumia"
          icon={<CheckCircle className="h-5 w-5" />}
          gradient="green"
        />
        <StatCard
          title="Pending approval"
          value={stats.pending_approval}
          subtitle="Awaiting Jumia review"
          icon={<Clock className="h-5 w-5" />}
          gradient="orange"
        />
        <StatCard
          title="This week's earnings"
          value={formatGHS(0)}
          subtitle="Connect Jumia to track"
          icon={<TrendingUp className="h-5 w-5" />}
          gradient="blue"
        />
      </div>

      {/* Jumia connection health */}
      {jumia !== null && (
        <div className={cn(
          "flex items-center justify-between rounded-2xl border px-5 py-4",
          jumia.connected
            ? "border-emerald-100 bg-emerald-50"
            : jumia.status === "expired"
            ? "border-amber-100 bg-amber-50"
            : "border-zinc-200 bg-zinc-50"
        )}>
          <div className="flex items-center gap-3">
            <div className={cn(
              "flex h-8 w-8 items-center justify-center rounded-lg text-base",
              jumia.connected ? "bg-emerald-100" : "bg-zinc-100"
            )}>
              <ShoppingBag className={cn("h-4 w-4", jumia.connected ? "text-emerald-600" : "text-zinc-400")} />
            </div>
            <div>
              <p className="text-sm font-semibold text-zinc-800">
                Jumia Ghana
                {jumia.store_name ? ` · ${jumia.store_name}` : ""}
              </p>
              <p className={cn(
                "text-xs",
                jumia.connected ? "text-emerald-600"
                  : jumia.status === "expired" ? "text-amber-600"
                  : "text-zinc-400"
              )}>
                {jumia.connected
                  ? `Connected${jumia.seller_email ? ` as ${jumia.seller_email}` : ""}`
                  : jumia.status === "expired"
                  ? "Token expired — re-authorise to push listings"
                  : "Not connected — connect to publish directly from PandaWorld"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!jumia.connected && (
              <AlertCircle className={cn("h-4 w-4", jumia.status === "expired" ? "text-amber-500" : "text-zinc-300")} />
            )}
            {jumia.connected ? (
              <CheckCircle className="h-4 w-4 text-emerald-500" />
            ) : (
              <Button asChild size="sm" variant="outline" className="gap-1.5 text-xs">
                <Link href="/settings/integrations">
                  <Plug className="h-3 w-3" />
                  {jumia.status === "expired" ? "Re-authorise" : "Connect"}
                </Link>
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Recent listings */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-900">
            Recent listings
          </h2>
          <Button variant="ghost" size="sm" asChild className="gap-1 text-zinc-500">
            <Link href="/listings">
              View all
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>

        {recentListings.length > 0 ? (
          <ListingTable listings={recentListings} compact />
        ) : (
          <div className="rounded-2xl border bg-white py-16 text-center">
            <p className="text-sm font-medium text-zinc-500">No listings yet</p>
            <p className="mt-1 text-xs text-zinc-400">
              Create your first listing to get started
            </p>
            <Button asChild className="mt-4 gap-2" size="sm">
              <Link href="/listings/new">
                <Plus className="h-3.5 w-3.5" />
                New listing
              </Link>
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
