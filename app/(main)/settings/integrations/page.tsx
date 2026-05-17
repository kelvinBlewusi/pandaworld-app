"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Loader2,
  Unlink,
  RefreshCw,
  ShoppingBag,
  X,
  Info,
  Plug,
  Download,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { JumiaConnectionPublic } from "@/lib/types/jumia";

// ─── Inner page (needs useSearchParams — must be inside Suspense) ─────────────

function IntegrationsPageInner() {
  const router       = useRouter();
  const searchParams = useSearchParams();

  const [conn,         setConn]         = useState<JumiaConnectionPublic | null>(null);
  const [loading,      setLoading]      = useState(true);
  const [connecting,   setConnecting]   = useState(false);
  const [disconnecting,setDisconnecting]= useState(false);
  const [showConfirm,  setShowConfirm]  = useState(false);
  const [toast,        setToast]        = useState<{ type: "success"|"error"; msg: string } | null>(null);
  const [syncing,         setSyncing]         = useState(false);
  const [syncResult,      setSyncResult]      = useState<{ categories: number; attributes: number } | null>(null);
  const [syncingBrands,   setSyncingBrands]   = useState(false);
  const [brandSyncResult, setBrandSyncResult] = useState<{ brands: number } | null>(null);

  // Persistent stats — count + last-synced timestamp for the cached
  // Jumia category tree. Fetched on page load so the seller always sees
  // current sync health without having to click "Sync now".
  const [categoryStats, setCategoryStats] = useState<{ count: number; lastSynced: string | null } | null>(null);

  const loadCategoryStats = () => {
    fetch("/api/jumia/sync-categories")
      .then((r) => r.json())
      .then((d) => setCategoryStats({ count: d.count ?? 0, lastSynced: d.lastSynced ?? null }))
      .catch(() => setCategoryStats(null));
  };

  // ── Load connection status ─────────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/jumia/status")
      .then((r) => r.json())
      .then((d) => setConn(d))
      .catch(() => setConn(null))
      .finally(() => setLoading(false));
    loadCategoryStats();
  }, []);

  // ── Handle Jumia OAuth redirect back ──────────────────────────────────────
  useEffect(() => {
    const connected   = searchParams.get("connected");
    const jumiaError  = searchParams.get("jumia_error");

    if (connected === "1") {
      showToast("success", "🎉 Jumia store connected! Our AI can now publish your products to vendor center for you.");
      // Refresh status
      fetch("/api/jumia/status")
        .then((r) => r.json())
        .then((d) => setConn(d));
      router.replace("/settings/integrations");
    } else if (jumiaError) {
      showToast("error", `Connection failed: ${decodeURIComponent(jumiaError)}`);
      router.replace("/settings/integrations");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function showToast(type: "success" | "error", msg: string) {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 6000);
  }

  // ── Sync Jumia categories ─────────────────────────────────────────────────
  // FAST path: just the category list (no attributes). Attribute schemas load
  // lazily when a seller actually opens a listing in that category. Full attr
  // sync took 50+ seconds for ~200 categories due to Jumia's rate limit; this
  // version completes in 2-3 seconds.
  async function handleSyncCategories() {
    setSyncing(true);
    setSyncResult(null);

    // 90-second client-side timeout — bails out fast if the server is
    // hung instead of waiting for the browser's default ~5min.
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 90_000);

    try {
      const res = await fetch("/api/admin/jumia/sync-categories", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ syncAttributes: false }),
        signal:  ctrl.signal,
      });
      clearTimeout(timeoutId);

      // Robust response parsing — Vercel function timeouts return HTML
      // error pages, not JSON. We read as text first, then try to parse
      // so we can surface a useful error when parsing fails.
      const rawText = await res.text();
      let data: { success?: boolean; error?: string; categories?: number } = {};
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch (parseErr) {
        console.error("[Sync Categories] Non-JSON response:", res.status, rawText.slice(0, 300), parseErr);
        showToast(
          "error",
          `Sync got an invalid response (HTTP ${res.status}). Check Vercel function logs for /api/admin/jumia/sync-categories.`,
        );
        return;
      }

      if (res.ok && data.success) {
        setSyncResult({ categories: data.categories ?? 0, attributes: 0 });
        showToast("success", `✅ Synced ${data.categories} categories. Attribute fields load automatically when you pick a category in a listing.`);
        loadCategoryStats();
      } else {
        console.error("[Sync Categories] Server error:", res.status, data);
        showToast("error", data.error ?? `Sync failed (HTTP ${res.status}).`);
      }
    } catch (e) {
      clearTimeout(timeoutId);
      const err = e as Error;
      console.error("[Sync Categories] Client-side error:", err);
      if (err.name === "AbortError") {
        showToast("error", "Sync timed out after 90s. Try Settings → Integrations again, or check Vercel logs.");
      } else {
        showToast("error", `Sync failed: ${err.message}`);
      }
    } finally {
      setSyncing(false);
    }
  }

  // ── Sync Jumia brand catalog ──────────────────────────────────────────────
  async function handleSyncBrands() {
    setSyncingBrands(true);
    setBrandSyncResult(null);
    const ctrl = new AbortController();
    const timeoutId = setTimeout(() => ctrl.abort(), 90_000);
    try {
      const res  = await fetch("/api/admin/jumia/sync-brands", { method: "POST", signal: ctrl.signal });
      clearTimeout(timeoutId);
      const rawText = await res.text();
      let data: { success?: boolean; error?: string; brands?: number } = {};
      try {
        data = rawText ? JSON.parse(rawText) : {};
      } catch (parseErr) {
        console.error("[Sync Brands] Non-JSON response:", res.status, rawText.slice(0, 300), parseErr);
        showToast("error", `Brand sync got an invalid response (HTTP ${res.status}). Check Vercel logs.`);
        return;
      }
      if (res.ok && data.success) {
        setBrandSyncResult({ brands: data.brands ?? 0 });
        showToast("success", `✅ Synced ${data.brands} brands from Jumia.`);
      } else {
        console.error("[Sync Brands] Server error:", res.status, data);
        showToast("error", data.error ?? `Brand sync failed (HTTP ${res.status}).`);
      }
    } catch (e) {
      clearTimeout(timeoutId);
      const err = e as Error;
      console.error("[Sync Brands] Client-side error:", err);
      if (err.name === "AbortError") {
        showToast("error", "Brand sync timed out after 90s.");
      } else {
        showToast("error", `Brand sync failed: ${err.message}`);
      }
    } finally {
      setSyncingBrands(false);
    }
  }

  // ── Kick off OAuth flow ───────────────────────────────────────────────────
  function handleConnect() {
    setConnecting(true);
    // Redirect to our connect route which builds the Jumia auth URL
    window.location.href = "/api/jumia/connect";
  }

  // ── Disconnect ────────────────────────────────────────────────────────────
  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      const res = await fetch("/api/jumia/disconnect", { method: "POST" });
      if (res.ok) {
        // Row deleted — redirect to onboarding so user can reconnect a store
        window.location.href = "/onboarding/channel";
      } else {
        showToast("error", "Failed to disconnect. Please try again.");
      }
    } finally {
      setDisconnecting(false);
    }
  }

  const isConnected    = conn?.connected && conn?.status === "active";
  const isExpired      = conn?.status === "expired";
  const oauthRequired  = !!conn?.oauth_required;
  const connectedDate = conn?.connected_at
    ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(
        new Date(conn.connected_at)
      )
    : null;
  const expiryDate = conn?.token_expires_at
    ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(
        new Date(conn.token_expires_at)
      )
    : null;

  return (
    <div className="space-y-8 max-w-2xl">
      {/* Toast */}
      {toast && (
        <div
          className={cn(
            "fixed top-4 right-4 z-50 flex items-center gap-3 rounded-xl border px-4 py-3 shadow-lg text-sm font-medium max-w-sm",
            toast.type === "success"
              ? "bg-emerald-50 border-emerald-200 text-emerald-800"
              : "bg-red-50 border-red-200 text-red-800"
          )}
        >
          {toast.type === "success" ? (
            <CheckCircle2 className="h-4 w-4 shrink-0" />
          ) : (
            <AlertCircle className="h-4 w-4 shrink-0" />
          )}
          <span className="flex-1">{toast.msg}</span>
          <button onClick={() => setToast(null)} className="opacity-60 hover:opacity-100">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-zinc-900">Integrations</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Connect your marketplace accounts. PandaWorld will use these to push listings directly.
        </p>
      </div>

      {/* Jumia GH card */}
      <section className="rounded-2xl border bg-white p-6 shadow-sm space-y-5">
        {/* Card header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-50 text-xl">
              🛒
            </div>
            <div>
              <p className="font-semibold text-zinc-900">Jumia Ghana</p>
              <p className="text-xs text-zinc-400">
                Vendor Center ·{" "}
                <a
                  href="https://vendorcenter.jumia.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline text-zinc-500"
                >
                  vendorcenter.jumia.com
                  <ExternalLink className="inline ml-0.5 h-2.5 w-2.5" />
                </a>
              </p>
            </div>
          </div>

          {/* Status badge */}
          {!loading && (
            <span
              className={cn(
                "rounded-full px-2.5 py-1 text-xs font-semibold",
                isConnected
                  ? "bg-emerald-50 text-emerald-700"
                  : isExpired
                  ? "bg-amber-50 text-amber-700"
                  : oauthRequired
                  ? "bg-blue-50 text-blue-700"
                  : "bg-zinc-100 text-zinc-500"
              )}
            >
              {isConnected
                ? "Connected"
                : isExpired
                ? "Token expired"
                : oauthRequired
                ? "Authorisation required"
                : "Not connected"}
            </span>
          )}
        </div>

        <Separator />

        {loading ? (
          <div className="flex items-center gap-2 text-sm text-zinc-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking connection…
          </div>
        ) : isConnected ? (
          /* ── Connected state ────────────────────────────────────────────── */
          <div className="space-y-5">
            {/* Store details */}
            <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-4 space-y-3">
              <div className="flex items-center gap-2 text-emerald-700 font-semibold text-sm">
                <CheckCircle2 className="h-4 w-4 shrink-0" />
                {conn?.store_name
                  ? `${conn.store_name} is connected`
                  : "Store connected"}
              </div>
              <div className="grid gap-2 sm:grid-cols-2 text-sm">
                {conn?.store_name && (
                  <div>
                    <p className="text-xs text-zinc-400">Store name</p>
                    <p className="font-medium text-zinc-800">{conn.store_name}</p>
                  </div>
                )}
                {conn?.seller_email && (
                  <div>
                    <p className="text-xs text-zinc-400">Seller email</p>
                    <p className="font-medium text-zinc-800">{conn.seller_email}</p>
                  </div>
                )}
                {conn?.seller_id && (
                  <div>
                    <p className="text-xs text-zinc-400">Seller ID</p>
                    <p className="font-medium text-zinc-800 font-mono text-xs">{conn.seller_id}</p>
                  </div>
                )}
                {connectedDate && (
                  <div>
                    <p className="text-xs text-zinc-400">Connected</p>
                    <p className="font-medium text-zinc-800">{connectedDate}</p>
                  </div>
                )}
              </div>
            </div>

            {/* Category sync */}
            <div className="rounded-xl border bg-zinc-50 p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-zinc-800">Jumia category database</p>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    The AI picks from these categories when analysing a listing. Keep them fresh.
                  </p>
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-2"
                    onClick={handleSyncCategories}
                    disabled={syncing}
                  >
                    <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} />
                    {syncing ? "Syncing…" : "Sync now"}
                  </Button>
                  <a
                    href="/api/admin/jumia/export-categories"
                    className="inline-flex items-center gap-1.5 rounded-md border bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 shadow-sm hover:bg-zinc-50"
                    title="Downloads a CSV of every cached category. Open in Google Sheets via File → Import → Upload."
                  >
                    <Download className="h-3 w-3" /> Export CSV
                  </a>
                  <a
                    href="/api/admin/jumia/export-categories?live=1"
                    className="text-[10px] text-zinc-500 hover:text-zinc-700 hover:underline"
                    title="Re-syncs from Jumia first, then downloads. Slower (30-60s)."
                  >
                    Export fresh from Jumia →
                  </a>
                </div>
              </div>

              {/* Always-visible status bar */}
              {categoryStats != null && (
                <div className="rounded-lg border bg-white px-3 py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs text-zinc-500">Categories the AI knows about</p>
                    <p className="text-lg font-bold text-zinc-900">
                      {categoryStats.count.toLocaleString()}
                      <span className="ml-2 text-xs font-normal text-zinc-400">
                        {categoryStats.count === 0
                          ? "— nothing synced yet"
                          : categoryStats.count < 50
                          ? "— looks low, click Sync now"
                          : "leaf categories"}
                      </span>
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-[10px] uppercase tracking-wider text-zinc-400">Last sync</p>
                    <p className="text-xs text-zinc-700">
                      {categoryStats.lastSynced
                        ? new Date(categoryStats.lastSynced).toLocaleString("en-GB", {
                            day:   "numeric",
                            month: "short",
                            hour:  "2-digit",
                            minute:"2-digit",
                          })
                        : "Never"}
                    </p>
                  </div>
                </div>
              )}

              {syncing && (
                <p className="text-xs text-zinc-400 flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                  Walking every page of /catalog/categories from Jumia…
                </p>
              )}
              {syncResult && !syncing && (
                <p className="text-xs text-emerald-700 flex items-center gap-1.5">
                  <CheckCircle2 className="h-3 w-3 shrink-0" />
                  {syncResult.categories} categories synced from Jumia.
                  Attribute schemas load on demand when you pick a category in a listing.
                </p>
              )}
            </div>

            {/* Brand sync */}
            <div className="rounded-xl border bg-zinc-50 p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-zinc-800">Jumia brand database</p>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Syncs the full Jumia brand catalog so brand names resolve instantly
                    when pushing products — no live API call needed at submission time.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-2 shrink-0"
                  onClick={handleSyncBrands}
                  disabled={syncingBrands}
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", syncingBrands && "animate-spin")} />
                  {syncingBrands ? "Syncing…" : "Sync now"}
                </Button>
              </div>
              {syncingBrands && (
                <p className="text-xs text-zinc-400 flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                  Fetching all brand pages from Jumia — this may take a minute or two…
                </p>
              )}
              {brandSyncResult && (
                <p className="text-xs text-emerald-700 flex items-center gap-1.5">
                  <CheckCircle2 className="h-3 w-3 shrink-0" />
                  {brandSyncResult.brands.toLocaleString()} brands synced
                </p>
              )}
            </div>

            {/* Token expiry info */}
            {expiryDate && (
              <p className="text-xs text-zinc-400 flex items-center gap-1.5">
                <Info className="h-3 w-3 shrink-0" />
                Access token expires {expiryDate}. PandaWorld will refresh it automatically.
              </p>
            )}

            {/* Actions */}
            <div className="flex gap-3">
              <Button
                variant="outline"
                size="sm"
                className="gap-2"
                onClick={handleConnect}
                disabled={connecting}
              >
                <RefreshCw className={cn("h-3.5 w-3.5", connecting && "animate-spin")} />
                Re-authorise
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-2 text-red-400 hover:text-red-600"
                onClick={() => setShowConfirm(true)}
              >
                <Unlink className="h-3.5 w-3.5" />
                Disconnect
              </Button>
            </div>
          </div>
        ) : oauthRequired ? (
          /* ── Credentials saved, OAuth not yet completed ─────────────────── */
          <div className="space-y-4">
            <div className="rounded-xl bg-blue-50 border border-blue-100 p-4 text-sm text-blue-700 flex items-start gap-2">
              <Info className="h-4 w-4 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold">One more step</p>
                <p className="mt-0.5">
                  Your Jumia credentials are saved. Click <strong>Authorise with Jumia</strong> to complete the connection — you&apos;ll be redirected to Vendor Center to grant access.
                </p>
                {conn?.store_name && (
                  <p className="mt-1 text-blue-600 text-xs">Store: {conn.store_name}</p>
                )}
              </div>
            </div>
            <Button onClick={handleConnect} disabled={connecting} className="gap-2 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700">
              {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingBag className="h-4 w-4" />}
              {connecting ? "Redirecting to Jumia…" : "Authorise with Jumia"}
            </Button>
          </div>
        ) : isExpired ? (
          /* ── Expired state ──────────────────────────────────────────────── */
          <div className="space-y-4">
            <div className="rounded-xl bg-amber-50 border border-amber-100 p-4 text-sm text-amber-700 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
              <span>
                Your Jumia access token has expired. Re-authorise PandaWorld to restore the connection.
              </span>
            </div>
            <Button onClick={handleConnect} disabled={connecting} className="gap-2">
              {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Re-authorise with Jumia
            </Button>
          </div>
        ) : (
          /* ── Not connected state ────────────────────────────────────────── */
          <div className="space-y-5">
            <p className="text-sm text-zinc-600 leading-relaxed">
              Connect your Jumia seller account to push listings directly from PandaWorld
              — no more manual uploads or .xlsx downloads. Click the button below and authorise PandaWorld
              in the Jumia Vendor Center.
            </p>

            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mb-2">
                What you get
              </p>
              <ul className="space-y-1.5 text-sm text-zinc-600">
                {[
                  "One-click product submission to Jumia",
                  "Real-time listing status & approval feedback",
                  "Automated order syncing (Phase 4C)",
                  "Live inventory & pricing updates (Phase 4D)",
                ].map((feat, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <CheckCircle2 className={cn("h-3.5 w-3.5 shrink-0", i < 2 ? "text-emerald-500" : "text-zinc-300")} />
                    <span className={i >= 2 ? "text-zinc-400" : ""}>{feat}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Redirect URI notice */}
            <div className="rounded-xl bg-blue-50 border border-blue-100 p-4 text-xs text-blue-700 space-y-1.5">
              <p className="font-semibold flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5 shrink-0" />
                Before connecting — verify your redirect URI
              </p>
              <p>
                In{" "}
                <a
                  href="https://vendorcenter.jumia.com/settings/applications"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  Jumia Vendor Center → Settings → Applications
                </a>
                , make sure your PandaWorld app&apos;s Redirect URI is set to:
              </p>
              <code className="block rounded bg-blue-100 px-2 py-1 text-[11px] font-mono break-all">
                {process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3002"}/api/jumia/callback
              </code>
              <p className="text-blue-600">
                The current setting was <code className="font-mono">http://localhost:3002/</code> — update it to the path above.
              </p>
            </div>

            <Button
              onClick={handleConnect}
              disabled={connecting}
              className="gap-2 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700"
            >
              {connecting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShoppingBag className="h-4 w-4" />
              )}
              {connecting ? "Redirecting to Jumia…" : "Connect Jumia Ghana"}
            </Button>
          </div>
        )}
      </section>

      {/* Coming soon — other platforms */}
      <section className="rounded-2xl border border-dashed bg-zinc-50/50 p-6 space-y-3">
        <div className="flex items-center gap-3 text-zinc-400">
          <Plug className="h-4 w-4" />
          <p className="text-sm font-medium">More integrations coming soon</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {["Shopify", "WooCommerce", "Konga", "Kilimall", "Amazon"].map((name) => (
            <span
              key={name}
              className="rounded-full border bg-white px-3 py-1 text-xs text-zinc-400 font-medium"
            >
              {name}
            </span>
          ))}
        </div>
      </section>

      {/* Disconnect confirmation modal */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-md rounded-2xl border bg-white p-6 shadow-xl space-y-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-50">
                <Unlink className="h-5 w-5 text-red-500" />
              </div>
              <div>
                <p className="font-semibold text-zinc-900">Disconnect Jumia?</p>
                <p className="text-xs text-zinc-500">PandaWorld will lose access to your store.</p>
              </div>
            </div>
            <p className="text-sm text-zinc-600">
              Your existing listings and data will remain in PandaWorld, but you won't be able
              to push new listings to Jumia until you reconnect.
            </p>
            <div className="flex gap-3">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => setShowConfirm(false)}
                disabled={disconnecting}
              >
                Keep connected
              </Button>
              <Button
                variant="destructive"
                className="flex-1 gap-2"
                onClick={handleDisconnect}
                disabled={disconnecting}
              >
                {disconnecting && <Loader2 className="h-4 w-4 animate-spin" />}
                Yes, disconnect
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Wrap in Suspense (required for useSearchParams) ─────────────────────────

export default function IntegrationsPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
        </div>
      }
    >
      <IntegrationsPageInner />
    </Suspense>
  );
}
