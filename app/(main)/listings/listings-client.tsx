"use client";

import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { Plus, Search, ChevronLeft, ChevronRight, Download, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ListingTable } from "@/components/ui/listing-table";
import type { ListingDisplay } from "@/lib/types";

const POLL_INTERVAL_MS = 10_000; // 10 seconds

const PAGE_SIZE = 10;

interface ListingsClientProps {
  listings: ListingDisplay[];
  categories: string[];
}

export function ListingsClient({ listings, categories }: ListingsClientProps) {
  const router   = useRouter();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Feed status auto-polling ──────────────────────────────────────────────
  // When any listing is pending_approval with a feedId, poll every 10s.
  // As soon as Jumia marks it DONE or ERROR the status flips to live/failed.

  const pendingIds = useMemo(() => {
    const createPending = listings
      .filter((l) => l.status === "pending_approval" && l.jumia_ref)
      .map((l) => l.id);
    const updatePending = listings
      .filter((l) => l.update_feed_status === "pending" && l.update_feed_ref)
      .map((l) => l.id);
    const combined = [...createPending, ...updatePending];
    return combined.filter((id, i) => combined.indexOf(id) === i);
  }, [listings]);

  const pollFeeds = useCallback(async () => {
    if (pendingIds.length === 0) return;
    try {
      const res = await fetch("/api/jumia/feeds/poll", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ listingIds: pendingIds }),
      });
      if (!res.ok) return;
      const { results } = await res.json() as { results: { id: string; status: string }[] };
      // Refresh whenever we got results — catches both create-feed transitions
      // and update_feed_status changes (done/error) so banners clear automatically
      if (results.length > 0) router.refresh();
    } catch {
      // Non-fatal — will retry on next interval
    }
  }, [pendingIds, router]);

  useEffect(() => {
    if (pendingIds.length === 0) {
      if (pollingRef.current) clearInterval(pollingRef.current);
      return;
    }
    // Poll immediately on mount/change, then every POLL_INTERVAL_MS
    pollFeeds();
    pollingRef.current = setInterval(pollFeeds, POLL_INTERVAL_MS);
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, [pendingIds.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    return listings.filter((l) => {
      const matchesSearch =
        search === "" ||
        l.title.toLowerCase().includes(search.toLowerCase()) ||
        l.sku.toLowerCase().includes(search.toLowerCase());
      const matchesStatus =
        statusFilter === "all" || l.status === statusFilter;
      const matchesCategory =
        categoryFilter === "all" || l.category === categoryFilter;
      return matchesSearch && matchesStatus && matchesCategory;
    });
  }, [listings, search, statusFilter, categoryFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paginated = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const resetPage = () => setPage(1);

  async function handleExportXLSX() {
    setExporting(true);
    try {
      // Build query: pass status filter if active so server can pre-filter
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);

      const res = await fetch(`/api/export-listings?${params.toString()}`);
      if (!res.ok) throw new Error("Export failed");

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `jumia-listings-${new Date().toISOString().slice(0, 10)}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("Export error:", err);
      alert("Export failed — please try again.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Listings</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {listings.length} total · {filtered.length} shown
          </p>
        </div>
        <div className="flex items-center gap-2">
          {listings.length > 0 && (
            <Button
              variant="outline"
              className="gap-2"
              onClick={handleExportXLSX}
              disabled={exporting}
            >
              {exporting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {exporting ? "Exporting…" : "Export for Jumia"}
            </Button>
          )}
          <Button asChild className="gap-2">
            <Link href="/listings/new">
              <Plus className="h-4 w-4" />
              New listing
            </Link>
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
          <Input
            placeholder="Search by title or SKU…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); resetPage(); }}
            className="pl-9"
          />
        </div>

        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); resetPage(); }}>
          <SelectTrigger className="w-40">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="draft">Draft</SelectItem>
            <SelectItem value="processing">Processing</SelectItem>
            <SelectItem value="pending_approval">Pending</SelectItem>
            <SelectItem value="live">Live</SelectItem>
            <SelectItem value="failed">Failed</SelectItem>
          </SelectContent>
        </Select>

        {categories.length > 0 && (
          <Select value={categoryFilter} onValueChange={(v) => { setCategoryFilter(v); resetPage(); }}>
            <SelectTrigger className="w-44">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categories.map((cat) => (
                <SelectItem key={cat} value={cat}>{cat}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {(statusFilter !== "all" || categoryFilter !== "all" || search) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { setSearch(""); setStatusFilter("all"); setCategoryFilter("all"); resetPage(); }}
            className="text-zinc-400 hover:text-zinc-600"
          >
            Clear filters
          </Button>
        )}
      </div>

      {/* Table */}
      <ListingTable listings={paginated} />

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-zinc-500">
          <span>
            Showing {(page - 1) * PAGE_SIZE + 1}–
            {Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
          </span>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" className="h-8 w-8"
              onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
              <Button key={p} variant={p === page ? "default" : "outline"}
                size="icon" className="h-8 w-8" onClick={() => setPage(p)}>
                {p}
              </Button>
            ))}
            <Button variant="outline" size="icon" className="h-8 w-8"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
