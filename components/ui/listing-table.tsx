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
  Stethoscope,
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

  // ── Diagnose a pending/failed listing — pulls live Jumia feed details ──
  const [diagnoseId, setDiagnoseId] = useState<string | null>(null);
  const [diagnoseResult, setDiagnoseResult] = useState<Record<string, unknown> | null>(null);

  async function handleDiagnose(id: string) {
    setDiagnoseId(id);
    setDiagnoseResult(null);
    try {
      const res  = await fetch(`/api/jumia/diagnose/${id}`);
      const data = await res.json();
      setDiagnoseResult(data);
      // Trigger refresh so any auto-applied status change shows up in the list
      router.refresh();
    } catch (e) {
      setDiagnoseResult({ error: (e as Error).message });
    }
  }

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
                        {/* Diagnose — only meaningful when a feed has been pushed */}
                        {(listing.status === "pending_approval" || listing.status === "failed" || listing.status === "live") && (
                          <DropdownMenuItem
                            className="text-blue-600 focus:text-blue-600 focus:bg-blue-50"
                            onClick={() => handleDiagnose(listing.id)}
                          >
                            <Stethoscope className="h-4 w-4 mr-2" />
                            Check Jumia status
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

      {/* Diagnose modal */}
      {diagnoseId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => { setDiagnoseId(null); setDiagnoseResult(null); }}
        >
          <div
            className="w-full max-w-2xl max-h-[85vh] overflow-hidden rounded-2xl bg-white shadow-xl flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b px-5 py-4">
              <div className="flex items-center gap-2">
                <Stethoscope className="h-5 w-5 text-blue-600" />
                <h2 className="font-semibold text-zinc-900">Jumia status check</h2>
              </div>
              <button
                onClick={() => { setDiagnoseId(null); setDiagnoseResult(null); }}
                className="text-zinc-400 hover:text-zinc-700"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-y-auto p-5 space-y-4">
              {!diagnoseResult ? (
                <div className="flex items-center gap-2 text-sm text-zinc-500 py-8 justify-center">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Asking Jumia what happened to this listing…
                </div>
              ) : (
                <DiagnoseResult result={diagnoseResult} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function DiagnoseResult({ result }: { result: Record<string, unknown> }) {
  const diagnosis    = String(result.diagnosis ?? "UNKNOWN");
  const humanMessage = String(result.humanMessage ?? result.detail ?? result.error ?? "");
  const suggestions  = (result.suggestion ?? []) as string[];
  const feedStatus   = result.feedStatus as { status?: string; success?: number; failed?: number; errors?: unknown[] } | null;
  const productDetails = result.productDetails as Array<{ sellerSku: string; productSid: string | null; qcStatus: string | null; errors: string[] }> | null;

  const headerColor =
    diagnosis === "ACCEPTED"          ? "bg-emerald-50 border-emerald-200 text-emerald-700" :
    diagnosis === "STILL_PROCESSING"  ? "bg-blue-50 border-blue-200 text-blue-700" :
    diagnosis === "PRODUCTS_REJECTED" ? "bg-red-50 border-red-200 text-red-700" :
    diagnosis === "FEED_ERROR"        ? "bg-red-50 border-red-200 text-red-700" :
                                        "bg-zinc-50 border-zinc-200 text-zinc-700";

  return (
    <>
      {/* Verdict */}
      <div className={`rounded-xl border p-4 ${headerColor}`}>
        <p className="text-xs font-bold uppercase tracking-wider mb-1">{diagnosis.replace(/_/g, " ")}</p>
        <p className="text-sm">{humanMessage}</p>
      </div>

      {/* Suggestions */}
      {suggestions.length > 0 && (
        <div className="rounded-xl border border-amber-100 bg-amber-50 p-4">
          <p className="text-xs font-semibold text-amber-700 mb-2">Next steps</p>
          <ul className="space-y-1 text-xs text-amber-900">
            {suggestions.map((s, i) => (
              <li key={i} className="flex items-start gap-1.5">
                <span className="text-amber-600 mt-0.5">→</span>
                <span>{s}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Feed summary */}
      {feedStatus && (
        <div className="rounded-xl border bg-white p-4 space-y-2">
          <p className="text-xs font-semibold text-zinc-600">Jumia feed summary</p>
          <div className="grid grid-cols-3 gap-2 text-xs">
            <Stat label="Status"  value={feedStatus.status ?? "—"} />
            <Stat label="Success" value={String(feedStatus.success ?? 0)} />
            <Stat label="Failed"  value={String(feedStatus.failed ?? 0)} highlight={Number(feedStatus.failed ?? 0) > 0} />
          </div>
          {Array.isArray(feedStatus.errors) && feedStatus.errors.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer font-medium text-red-600">
                {feedStatus.errors.length} feed error{feedStatus.errors.length === 1 ? "" : "s"} — click to view
              </summary>
              <pre className="mt-2 max-h-48 overflow-auto rounded bg-zinc-900 text-zinc-100 p-3 font-mono text-[11px]">
                {JSON.stringify(feedStatus.errors, null, 2)}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Per-product details */}
      {productDetails && productDetails.length > 0 && (
        <div className="rounded-xl border bg-white p-4 space-y-2">
          <p className="text-xs font-semibold text-zinc-600">Per-product status ({productDetails.length})</p>
          <div className="space-y-2">
            {productDetails.map((p, i) => (
              <div key={i} className="border rounded p-2 text-xs space-y-1">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-zinc-700">{p.sellerSku || "(no sku)"}</span>
                  <span className={
                    p.qcStatus === "approved" ? "text-emerald-600" :
                    p.qcStatus === "rejected" ? "text-red-600" :
                                                "text-amber-600"
                  }>
                    QC: {p.qcStatus ?? "pending"}
                  </span>
                </div>
                {p.productSid && (
                  <p className="text-[10px] text-zinc-400 font-mono">sid: {p.productSid}</p>
                )}
                {p.errors.length > 0 && (
                  <ul className="space-y-0.5 text-red-600 text-[11px]">
                    {p.errors.map((e, j) => <li key={j}>• {e}</li>)}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Raw response (for debugging) */}
      <details className="text-xs">
        <summary className="cursor-pointer font-medium text-zinc-500">Raw response (for debugging)</summary>
        <pre className="mt-2 max-h-64 overflow-auto rounded bg-zinc-900 text-zinc-100 p-3 font-mono text-[10px]">
          {JSON.stringify(result, null, 2)}
        </pre>
      </details>
    </>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={`rounded border px-2 py-1.5 text-center ${highlight ? "border-red-200 bg-red-50" : "border-zinc-200 bg-zinc-50"}`}>
      <p className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={`text-sm font-bold ${highlight ? "text-red-700" : "text-zinc-900"}`}>{value}</p>
    </div>
  );
}
