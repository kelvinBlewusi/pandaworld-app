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
  const [syncing,      setSyncing]      = useState(false);
  const [syncResult,   setSyncResult]   = useState<{ categories: number; attributes: number } | null>(null);

  // ── Load connection status ─────────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/jumia/status")
      .then((r) => r.json())
      .then((d) => setConn(d))
      .catch(() => setConn(null))
      .finally(() => setLoading(false));
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
  async function handleSyncCategories() {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await fetch("/api/admin/jumia/sync-categories", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ syncAttributes: true }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setSyncResult({ categories: data.categories, attributes: data.attributes });
        showToast("success", `✅ Synced ${data.categories} categories and ${data.attributes} attribute fields from Jumia.`);
      } else {
        showToast("error", data.error ?? "Sync failed — please try again.");
      }
    } catch {
      showToast("error", "Network error during sync.");
    } finally {
      setSyncing(false);
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
        setShowConfirm(false);
        setConn((prev) => prev ? { ...prev, connected: false, status: "revoked" } : prev);
        showToast("success", "Jumia store disconnected.");
      } else {
        showToast("error", "Failed to disconnect. Please try again.");
      }
    } finally {
      setDisconnecting(false);
    }
  }

  const isConnected = conn?.connected && conn?.status === "active";
  const isExpired   = conn?.status === "expired";
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
                  href="https://vendorcenter.jumia.com.gh"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline text-zinc-500"
                >
                  vendorcenter.jumia.com.gh
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
                  : "bg-zinc-100 text-zinc-500"
              )}
            >
              {isConnected ? "Connected" : isExpired ? "Token expired" : "Not connected"}
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

            {/* What's enabled */}
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mb-2">
                What PandaWorld can do
              </p>
              <ul className="space-y-1.5 text-sm text-zinc-600">
                {[
                  "Push product listings directly to Jumia",
                  "Read product status and approval feedback",
                  "Sync order data (coming in Phase 4C)",
                  "Update inventory & pricing (coming in Phase 4D)",
                ].map((feat, i) => (
                  <li key={i} className="flex items-center gap-2">
                    <CheckCircle2 className={cn("h-3.5 w-3.5 shrink-0", i < 2 ? "text-emerald-500" : "text-zinc-300")} />
                    <span className={i >= 2 ? "text-zinc-400" : ""}>{feat}</span>
                  </li>
                ))}
              </ul>
            </div>

            {/* Category sync */}
            <div className="rounded-xl border bg-zinc-50 p-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-zinc-800">Jumia category database</p>
                  <p className="text-xs text-zinc-500 mt-0.5">
                    Syncs the real Jumia category tree so AI can detect the exact category and fill the correct fields for every product.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-2 shrink-0"
                  onClick={handleSyncCategories}
                  disabled={syncing}
                >
                  <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin")} />
                  {syncing ? "Syncing…" : "Sync now"}
                </Button>
              </div>
              {syncing && (
                <p className="text-xs text-zinc-400 flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                  Fetching category tree and attribute schemas from Jumia — this takes 2–5 minutes…
                </p>
              )}
              {syncResult && (
                <p className="text-xs text-emerald-700 flex items-center gap-1.5">
                  <CheckCircle2 className="h-3 w-3 shrink-0" />
                  {syncResult.categories} categories · {syncResult.attributes} attribute fields synced
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
