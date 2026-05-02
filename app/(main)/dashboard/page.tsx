import {
  FileText,
  CheckCircle,
  Clock,
  TrendingUp,
  Plus,
  ArrowRight,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/ui/stat-card";
import { ListingTable } from "@/components/ui/listing-table";
import { mockListings, statusCounts, weeklyEarnings } from "@/lib/mock/listings";
import { formatGHS } from "@/lib/utils";

export default function DashboardPage() {
  const recentListings = mockListings.slice(0, 6);

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">
            Good morning, Kelvin 👋
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            Here's what's happening with your listings today.
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
          value={statusCounts.draft}
          subtitle="Ready to publish"
          icon={<FileText className="h-5 w-5" />}
          gradient="lavender"
        />
        <StatCard
          title="Live listings"
          value={statusCounts.live}
          subtitle="Active on Jumia"
          icon={<CheckCircle className="h-5 w-5" />}
          gradient="green"
        />
        <StatCard
          title="Pending approval"
          value={statusCounts.pending_approval}
          subtitle="Awaiting Jumia review"
          icon={<Clock className="h-5 w-5" />}
          gradient="orange"
        />
        <StatCard
          title="This week's earnings"
          value={formatGHS(weeklyEarnings)}
          subtitle="+12% vs last week"
          icon={<TrendingUp className="h-5 w-5" />}
          gradient="blue"
        />
      </div>

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
        <ListingTable listings={recentListings} compact />
      </div>
    </div>
  );
}
