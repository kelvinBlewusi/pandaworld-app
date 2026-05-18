"use client";

import { useEffect, useState } from "react";
import { Loader2, RefreshCw, AlertCircle, CheckCircle2, Tags } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Brand catalog is typically smaller than the category tree but Jumia's
// brand pagination is 0-indexed and the API is happy to return empty
// pages mid-walk. We stop once we see TWO empty pages in a row (one is
// just sparseness; two is "we're past the end").
const PAGE_ESTIMATE = 25;

// localStorage key for resume state. Cleared on completion / cancel.
const RESUME_KEY = "pandaworld:admin-brands-sync";

interface SyncProgress {
  page:        number;   // last completed page (-1 = nothing yet)
  totalSoFar:  number;   // total rows in DB after last page
}

interface PageResponse {
  page:       number;
  fetched:    number;
  hasMore:    boolean;
  totalSoFar: number;
}

interface FinalizeResponse {
  done:         boolean;
  total:        number;
  lastSyncedAt: string | null;
}

interface AdminBrandsClientProps {
  initialTotal:           number;
  initialLastSyncedAt:    string | null;
  firstLetterDistribution: Array<{ name: string; count: number }>;
}

export function AdminBrandsClient({
  initialTotal,
  initialLastSyncedAt,
  firstLetterDistribution,
}: AdminBrandsClientProps) {
  const [stats, setStats] = useState({
    total:        initialTotal,
    lastSyncedAt: initialLastSyncedAt,
  });

  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [error,    setError]    = useState<string | null>(null);
  const [status,   setStatus]   = useState<string | null>(null);
  const [resumeOffered, setResumeOffered] = useState<SyncProgress | null>(null);

  useEffect(() => {
    const raw = typeof window !== "undefined" ? localStorage.getItem(RESUME_KEY) : null;
    if (!raw) return;
    try {
      const stored = JSON.parse(raw) as SyncProgress;
      if (stored.page >= 0) setResumeOffered(stored);
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

  // Run the batched sync. Jumia brand pages are 0-indexed. We continue
  // until we've seen TWO consecutive empty pages — a single sparse page
  // in the middle of the catalogue would otherwise end the walk early.
  async function runSync(startFromPage: number) {
    setError(null);
    setStatus(null);
    setResumeOffered(null);

    const t0 = Date.now();
    let page = startFromPage;
    let emptyStreak = 0;
    let last: PageResponse | null = null;

    try {
      while (true) {
        const res = await fetch(`/api/admin/jumia/sync-brands/page?page=${page}`, {
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
          page:       last.page,
          totalSoFar: last.totalSoFar,
        };
        setProgress(next);
        persistProgress(next);

        if (last.hasMore) {
          emptyStreak = 0;
        } else {
          emptyStreak += 1;
          // Two empty pages in a row = end of walk.
          if (emptyStreak >= 2) break;
        }
        page += 1;
      }

      setStatus("Finalising…");
      const finRes = await fetch("/api/admin/jumia/sync-brands/finalize", { method: "POST" });
      const finText = await finRes.text();
      let fin: FinalizeResponse | { error?: string };
      try {
        fin = finText ? JSON.parse(finText) : {};
      } catch {
        throw new Error(`Finalize returned non-JSON (HTTP ${finRes.status})`);
      }
      if (!finRes.ok) {
        throw new Error(
          ("error" in fin && fin.error)
            ? `Finalize: ${fin.error}`
            : `Finalize returned HTTP ${finRes.status}`,
        );
      }

      const finalized = fin as FinalizeResponse;
      setStats({
        total:        finalized.total,
        lastSyncedAt: finalized.lastSyncedAt,
      });
      setStatus(
        `Synced ${finalized.total.toLocaleString()} brands in ${((Date.now() - t0) / 1000).toFixed(1)}s.`,
      );
      clearProgress();
    } catch (e) {
      const err = e as Error;
      console.error("[Admin Brand Sync] ✕", err);
      setError(err.message);
      // Don't clear progress on error — let the admin resume.
    } finally {
      setProgress(null);
    }
  }

  const syncing = progress !== null || status === "Finalising…";
  const progressPercent = progress
    ? Math.min(100, Math.round((Math.max(progress.page, 0) / PAGE_ESTIMATE) * 100))
    : 0;

  return (
    <div className="space-y-6 max-w-2xl mx-auto py-6">
      <header className="space-y-1">
        <h1 className="text-xl font-bold text-zinc-900">Jumia Brand Catalog</h1>
        <p className="text-sm text-zinc-500">
          Refresh the brand list from Jumia&apos;s live API. Sellers read from this
          same data — no per-seller syncing.
        </p>
      </header>

      <div className="rounded-xl border bg-white p-5 shadow-sm space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Stat label="Total brands" value={stats.total.toLocaleString()} />
          <Stat
            label="Last refreshed"
            value={stats.lastSyncedAt
              ? new Date(stats.lastSyncedAt).toLocaleString("en-GB", {
                  day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
                })
              : "Never"}
          />
        </div>

        {!syncing && !resumeOffered && (
          <Button
            onClick={() => runSync(0)}
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
              <span>{progress.totalSoFar.toLocaleString()} brands so far</span>
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
            Finalising…
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

      {/* First-letter distribution — gaps reveal a stalled mid-walk sync. */}
      {firstLetterDistribution.some((d) => d.count > 0) && (
        <div className="rounded-xl border bg-white p-5 shadow-sm space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-900">A–Z distribution</h2>
            <span className="text-[10px] uppercase tracking-wider text-zinc-400">
              {firstLetterDistribution.filter((d) => d.count > 0).length} buckets
            </span>
          </div>
          <p className="text-xs text-zinc-500">
            Brands grouped by first letter. Large gaps suggest the sync stopped
            partway through Jumia&apos;s catalogue.
          </p>
          <div className="grid grid-cols-9 sm:grid-cols-14 gap-1 text-[10px]">
            {firstLetterDistribution.map((d) => (
              <div
                key={d.name}
                className={cn(
                  "rounded border bg-zinc-50 px-1 py-1 text-center",
                  d.count === 0 && "opacity-40",
                )}
                title={`${d.name}: ${d.count}`}
              >
                <div className="font-bold text-zinc-700">{d.name}</div>
                <div className="font-mono text-zinc-500">{d.count}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="rounded-xl border bg-zinc-50 p-4 text-xs text-zinc-600 space-y-2">
        <div className="flex items-start gap-2">
          <Tags className="h-4 w-4 text-zinc-400 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <p className="font-medium text-zinc-700">How this works</p>
            <p>
              Each click fetches one Jumia API page (~1–2s) and upserts the rows.
              The loop continues until two empty pages in a row signal end-of-list.
              No finalize compute is required — brands have no leaf hierarchy.
            </p>
            <p>
              If a sync gets interrupted (network drop, browser refresh), reopen
              this page — you&apos;ll be offered a Resume option that picks up
              from the last completed page.
            </p>
            <p>
              To ship a fresh-deploy seed, run{" "}
              <code className="rounded bg-zinc-100 px-1">npm run snapshot-brands</code>
              {" "}locally and commit the resulting{" "}
              <code className="rounded bg-zinc-100 px-1">supabase/seed/jumia-brands.json</code>.
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
