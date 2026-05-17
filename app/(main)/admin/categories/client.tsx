"use client";

import { useEffect, useState } from "react";
import { Loader2, RefreshCw, AlertCircle, CheckCircle2, Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Estimate used for the progress bar — Jumia's catalogue is ~10 pages.
// We re-estimate from the actual progress mid-sync so the bar stays
// honest if Jumia returns more or fewer pages than expected.
const PAGE_ESTIMATE = 12;

// localStorage key for resume state. Cleared on completion / cancel.
const RESUME_KEY = "pandaworld:admin-categories-sync";

interface SyncProgress {
  page:           number;       // last completed page (0 = nothing done yet)
  totalSoFar:     number;       // total rows in DB after last batch
  listableSoFar:  number;       // rows with attribute_set_sid after last batch
}

interface PageResponse {
  page:          number;
  fetched:       number;
  hasMore:       boolean;
  totalSoFar:    number;
  listableSoFar: number;
}

interface FinalizeResponse {
  done:         boolean;
  total:        number;
  listable:     number;
  updated:      number;
  lastSyncedAt: string | null;
}

interface AdminCategoriesClientProps {
  initialTotal:        number;
  initialListable:     number;
  initialLastSyncedAt: string | null;
}

export function AdminCategoriesClient({
  initialTotal,
  initialListable,
  initialLastSyncedAt,
}: AdminCategoriesClientProps) {
  // Steady-state stats
  const [stats, setStats] = useState({
    total:        initialTotal,
    listable:     initialListable,
    lastSyncedAt: initialLastSyncedAt,
  });

  // Sync state — populated only while a sync is in flight
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [error,    setError]    = useState<string | null>(null);
  const [status,   setStatus]   = useState<string | null>(null);
  const [resumeOffered, setResumeOffered] = useState<SyncProgress | null>(null);

  // Check for a stalled resume on mount
  useEffect(() => {
    const raw = typeof window !== "undefined" ? localStorage.getItem(RESUME_KEY) : null;
    if (!raw) return;
    try {
      const stored = JSON.parse(raw) as SyncProgress;
      if (stored.page >= 1) setResumeOffered(stored);
    } catch {
      localStorage.removeItem(RESUME_KEY);
    }
  }, []);

  const persistProgress = (p: SyncProgress) => {
    localStorage.setItem(RESUME_KEY, JSON.stringify(p));
  };
  const clearProgress = () => {
    localStorage.removeItem(RESUME_KEY);
  };

  // Run the batched sync loop. `startFromPage` defaults to 1; can be
  // bumped to resume from a previous interrupted session.
  async function runSync(startFromPage: number) {
    setError(null);
    setStatus(null);
    setResumeOffered(null);

    const t0 = Date.now();
    let page = startFromPage;
    let last: PageResponse | null = null;

    try {
      while (true) {
        const res = await fetch(`/api/admin/jumia/sync-categories/page?page=${page}`, {
          method: "POST",
        });
        const text = await res.text();
        let data: PageResponse | { error?: string };
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          throw new Error(`Got non-JSON response on page ${page} (HTTP ${res.status})`);
        }
        if (!res.ok) {
          throw new Error(
            ("error" in data && data.error)
              ? `Page ${page}: ${data.error}`
              : `Page ${page} returned HTTP ${res.status}`,
          );
        }

        last = data as PageResponse;
        const next: SyncProgress = {
          page:          last.page,
          totalSoFar:    last.totalSoFar,
          listableSoFar: last.listableSoFar,
        };
        setProgress(next);
        persistProgress(next);

        if (!last.hasMore) break;
        page += 1;
      }

      // Finalize step — recompute is_leaf for all rows
      setStatus("Finalising…");
      const finRes = await fetch("/api/admin/jumia/sync-categories/finalize", { method: "POST" });
      const finText = await finRes.text();
      let fin: FinalizeResponse | { error?: string };
      try {
        fin = finText ? JSON.parse(finText) : {};
      } catch {
        throw new Error(`Finalize returned non-JSON (HTTP ${finRes.status})`);
      }
      if (!finRes.ok) {
        throw new Error(
          ("error" in fin && fin.error) ? `Finalize: ${fin.error}` : `Finalize returned HTTP ${finRes.status}`,
        );
      }

      const finalized = fin as FinalizeResponse;
      setStats({
        total:        finalized.total,
        listable:     finalized.listable,
        lastSyncedAt: finalized.lastSyncedAt,
      });
      setStatus(`Synced ${finalized.total} categories (${finalized.listable} listable) in ${((Date.now() - t0) / 1000).toFixed(1)}s.`);
      clearProgress();
    } catch (e) {
      const err = e as Error;
      console.error("[Admin Sync] ✕", err);
      setError(err.message);
      // Don't clear progress on error — let the seller resume.
    } finally {
      setProgress(null);
    }
  }

  const syncing = progress !== null || status === "Finalising…";
  const progressPercent = progress
    ? Math.min(100, Math.round((progress.page / PAGE_ESTIMATE) * 100))
    : 0;

  return (
    <div className="space-y-6 max-w-2xl mx-auto py-6">
      <header className="space-y-1">
        <h1 className="text-xl font-bold text-zinc-900">Jumia Category Catalog</h1>
        <p className="text-sm text-zinc-500">
          Refresh the catalog from Jumia&apos;s live API. Sellers read from this same
          data — no per-seller syncing.
        </p>
      </header>

      {/* Status card */}
      <div className="rounded-xl border bg-white p-5 shadow-sm space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <Stat label="Total categories"  value={stats.total.toLocaleString()} />
          <Stat label="Listable"          value={stats.listable.toLocaleString()} />
          <Stat
            label="Last refreshed"
            value={stats.lastSyncedAt
              ? new Date(stats.lastSyncedAt).toLocaleString("en-GB", {
                  day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
                })
              : "Never"}
          />
        </div>

        {/* Action area */}
        {!syncing && !resumeOffered && (
          <Button
            onClick={() => runSync(1)}
            className="w-full gap-2 bg-orange-500 hover:bg-orange-600 text-white"
          >
            <RefreshCw className="h-4 w-4" /> Refresh from Jumia
          </Button>
        )}

        {!syncing && resumeOffered && (
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-2">
            <p className="text-xs text-amber-900">
              An interrupted sync was found — last completed page <strong>{resumeOffered.page}</strong>.
              Resume from page {resumeOffered.page + 1}?
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => runSync(resumeOffered.page + 1)}
                className="bg-amber-600 hover:bg-amber-700 text-white"
              >
                Resume
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  clearProgress();
                  setResumeOffered(null);
                }}
              >
                Start fresh
              </Button>
            </div>
          </div>
        )}

        {syncing && progress && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-zinc-600">
              <span>Syncing… page {progress.page} of ~{PAGE_ESTIMATE}</span>
              <span>{progress.totalSoFar} categories so far</span>
            </div>
            <div className="h-2 rounded-full bg-zinc-100 overflow-hidden">
              <div
                className="h-full bg-orange-500 transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        )}

        {status === "Finalising…" && (
          <p className="text-xs text-zinc-500 flex items-center gap-1.5">
            <Loader2 className="h-3 w-3 animate-spin shrink-0" />
            Finalising — recomputing is_leaf for {stats.total} rows…
          </p>
        )}

        {status && status !== "Finalising…" && !error && (
          <p className="text-xs text-emerald-700 flex items-center gap-1.5">
            <CheckCircle2 className="h-3 w-3 shrink-0" />
            {status}
          </p>
        )}

        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-3 text-xs text-red-700 flex items-start gap-2">
            <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium">Sync failed</p>
              <p className="mt-0.5 break-words">{error}</p>
            </div>
          </div>
        )}
      </div>

      {/* Help card */}
      <div className="rounded-xl border bg-zinc-50 p-4 text-xs text-zinc-600 space-y-2">
        <div className="flex items-start gap-2">
          <Database className="h-4 w-4 text-zinc-400 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium text-zinc-700">How this works</p>
            <p>
              Each click fetches one Jumia API page (~1–2s) and upserts the rows.
              The loop continues until Jumia returns an empty page. A finalize
              step recomputes <code className="rounded bg-zinc-100 px-1">is_leaf</code> for every row.
            </p>
            <p>
              If a sync gets interrupted (network drop, browser refresh), reopen
              this page — you&apos;ll be offered a Resume option that picks up
              from the last completed page.
            </p>
            <p>
              When you have data you want to ship in future deploys as a
              fresh-deploy seed, run <code className="rounded bg-zinc-100 px-1">npm run snapshot-categories</code> locally
              and commit the resulting <code className="rounded bg-zinc-100 px-1">supabase/seed/jumia-categories.json</code>.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-wider text-zinc-400">{label}</p>
      <p className={cn("font-bold text-zinc-900", value.length > 12 ? "text-sm" : "text-xl")}>{value}</p>
    </div>
  );
}
