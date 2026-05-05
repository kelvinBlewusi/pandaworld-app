"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  MoreHorizontal,
  ExternalLink,
  Copy,
  Trash2,
  Loader2,
  SendHorizonal,
  ShoppingBag,
  CheckCircle2,
  AlertCircle,
  X,
} from "lucide-react";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusPill } from "@/components/ui/status-pill";
import { MarketplaceBadge } from "@/components/ui/marketplace-badge";
import { formatGHS, formatDate, cn } from "@/lib/utils";
import type { ListingDisplay } from "@/lib/types";
import {
  deleteListing,
  duplicateListing,
  bulkDeleteListings,
  bulkUpdateStatus,
} from "@/lib/actions/listings";

interface ListingTableProps {
  listings: (ListingDisplay & { jumia_error?: string | null })[];
  compact?: boolean;
}

interface Toast {
  id: string;
  type: "success" | "error";
  msg: string;
}

export function ListingTable({ listings, compact = false }: ListingTableProps) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [selected, setSelected]         = useState<Set<string>>(new Set());
  const [actionId, setActionId]         = useState<string | null>(null);
  const [pushingIds, setPushingIds]     = useState<Set<string>>(new Set());
  const [toasts, setToasts]             = useState<Toast[]>([]);

  // ── Toast helpers ──────────────────────────────────────────────────────────
  function addToast(type: "success" | "error", msg: string) {
    const id = crypto.randomUUID();
    setToasts((t) => [...t, { id, type, msg }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 6000);
  }

  const toggleAll = () => {
    if (selected.size === listings.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(listings.map((l) => l.id)));
    }
  };

  const toggle = (id: string) => {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    setSelected(next);
  };

  const allSelected = selected.size === listings.length && listings.length > 0;

  // ── Per-row delete / duplicate ─────────────────────────────────────────────

  function handleDelete(id: string, title: string) {
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
    setActionId(id);
    startTransition(async () => {
      try {
        await deleteListing(id);
        setSelected((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        router.refresh();
      } finally {
        setActionId(null);
      }
    });
  }

  function handleDuplicate(id: string) {
    setActionId(id);
    startTransition(async () => {
      try {
        await duplicateListing(id);
        router.refresh();
      } finally {
        setActionId(null);
      }
    });
  }

  // ── Push single listing to Jumia ───────────────────────────────────────────

  async function handlePushToJumia(id: string, title: string) {
    setPushingIds((s) => new Set(s).add(id));
    try {
      const res  = await fetch("/api/jumia/push", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ listingId: id }),
      });
      const data = await res.json();

      if (res.ok && data.success) {
        addToast("success", `"${title}" submitted to Jumia — now Pending Approval.`);
        router.refresh();
      } else {
        addToast("error", data.error ?? "Push to Jumia failed. Try again.");
        router.refresh(); // refresh so status badge updates (might show "failed")
      }
    } catch {
      addToast("error", "Network error. Please try again.");
    } finally {
      setPushingIds((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  // ── Bulk actions ───────────────────────────────────────────────────────────

  function handleBulkDelete() {
    const ids = Array.from(selected);
    if (!window.confirm(`Delete ${ids.length} listing(s)? This cannot be undone.`)) return;
    startTransition(async () => {
      await bulkDeleteListings(ids);
      setSelected(new Set());
      router.refresh();
    });
  }

  function handleBulkPublish() {
    const ids = Array.from(selected);
    startTransition(async () => {
      await bulkUpdateStatus(ids, "pending_approval");
      setSelected(new Set());
      router.refresh();
    });
  }

  async function handleBulkPushToJumia() {
    const ids = Array.from(selected);
    // Push sequentially to avoid hammering the API
    for (const id of ids) {
      const listing = listings.find((l) => l.id === id);
      if (listing) {
        await handlePushToJumia(id, listing.title);
      }
    }
    setSelected(new Set());
  }

  return (
    <div className="overflow-hidden rounded-2xl border bg-white">

      {/* Toast stack */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 max-w-sm">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              "flex items-start gap-3 rounded-xl border px-4 py-3 shadow-lg text-sm font-medium",
              t.type === "success"
                ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                : "bg-red-50 border-red-200 text-red-800"
            )}
          >
            {t.type === "success"
              ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" />
              : <AlertCircle  className="h-4 w-4 shrink-0 mt-0.5" />}
            <span className="flex-1">{t.msg}</span>
            <button
              onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
              className="opacity-50 hover:opacity-100"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 border-b bg-blue-50 px-4 py-2.5">
          <span className="text-sm font-medium text-blue-700">
            {selected.size} selected
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs"
            disabled={isPending}
            onClick={handleBulkPublish}
          >
            {isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <SendHorizonal className="h-3 w-3" />
            )}
            Submit for approval
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs text-orange-600 hover:text-orange-700 border-orange-200 hover:border-orange-300"
            disabled={isPending || pushingIds.size > 0}
            onClick={handleBulkPushToJumia}
          >
            {pushingIds.size > 0 ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <ShoppingBag className="h-3 w-3" />
            )}
            Push to Jumia
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-xs text-red-600 hover:text-red-700"
            disabled={isPending}
            onClick={handleBulkDelete}
          >
            {isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
            Delete
          </Button>
          <button
            className="ml-auto text-xs text-blue-500 hover:text-blue-700"
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </button>
        </div>
      )}

      <Table>
        <TableHeader>
          <TableRow className="bg-zinc-50/80 hover:bg-zinc-50/80">
            {!compact && (
              <TableHead className="w-10">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={toggleAll}
                  aria-label="Select all"
                />
              </TableHead>
            )}
            <TableHead>Product</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Status</TableHead>
            {!compact && <TableHead>Marketplace</TableHead>}
            <TableHead className="text-right">Price</TableHead>
            {!compact && <TableHead>Last updated</TableHead>}
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {listings.map((listing) => {
            const isActing  = actionId === listing.id;
            const isPushing = pushingIds.has(listing.id);
            const isLive    = listing.status === "live";

            return (
              <TableRow
                key={listing.id}
                className={
                  selected.has(listing.id)
                    ? "bg-blue-50/30"
                    : isActing || isPushing
                    ? "opacity-50"
                    : ""
                }
              >
                {!compact && (
                  <TableCell>
                    <Checkbox
                      checked={selected.has(listing.id)}
                      onCheckedChange={() => toggle(listing.id)}
                      aria-label={`Select ${listing.title}`}
                    />
                  </TableCell>
                )}
                <TableCell>
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-zinc-50">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={listing.thumbnail}
                        alt={listing.title}
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <div className="min-w-0">
                      <Link
                        href={`/listings/${listing.id}/review`}
                        className="block truncate text-sm font-medium text-zinc-900 hover:text-blue-600 max-w-[220px]"
                      >
                        {listing.title}
                      </Link>
                      <p className="text-xs text-zinc-400">{listing.sku}</p>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <span className="text-sm text-zinc-600">{listing.category}</span>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <StatusPill status={listing.status} />
                    {listing.status === "failed" && listing.jumia_error && (
                      <p
                        className="max-w-[180px] truncate text-[10px] text-red-500 cursor-default"
                        title={listing.jumia_error}
                      >
                        {listing.jumia_error}
                      </p>
                    )}
                  </div>
                </TableCell>
                {!compact && (
                  <TableCell>
                    <MarketplaceBadge marketplace={listing.marketplace} />
                  </TableCell>
                )}
                <TableCell className="text-right">
                  <span className="text-sm font-semibold text-zinc-800">
                    {listing.price != null ? formatGHS(listing.price) : "—"}
                  </span>
                </TableCell>
                {!compact && (
                  <TableCell>
                    <span className="text-xs text-zinc-400">
                      {formatDate(listing.lastUpdated)}
                    </span>
                  </TableCell>
                )}
                <TableCell>
                  {isActing || isPushing ? (
                    <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />
                  ) : (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-zinc-400"
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        <DropdownMenuItem asChild>
                          <Link href={`/listings/${listing.id}/review`}>
                            <ExternalLink className="h-4 w-4 mr-2" />
                            View / Edit
                          </Link>
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => handleDuplicate(listing.id)}
                        >
                          <Copy className="h-4 w-4 mr-2" />
                          Duplicate
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        {/* Push / Retry to Jumia */}
                        {!isLive && (
                          <DropdownMenuItem
                            className="text-orange-600 focus:text-orange-600 focus:bg-orange-50"
                            onClick={() => handlePushToJumia(listing.id, listing.title)}
                          >
                            <ShoppingBag className="h-4 w-4 mr-2" />
                            {listing.status === "failed" ? "Retry push to Jumia" : "Push to Jumia"}
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-red-600 focus:text-red-600"
                          onClick={() =>
                            handleDelete(listing.id, listing.title)
                          }
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {listings.length === 0 && (
        <div className="py-16 text-center">
          <p className="text-sm text-zinc-400">No listings found</p>
        </div>
      )}
    </div>
  );
}
