"use client";

/**
 * The Jumia connection status card — shared by the old web dashboard's
 * Settings → Integrations (app/(main)/settings/integrations) and the
 * extension's own Settings page (app/extension/(app)/settings), so both
 * surfaces show the exact same connected/expired/authorising/not-connected
 * states and actions instead of two copies drifting apart.
 *
 * `returnTo` (see lib/jumia/return-to.ts) is threaded through every
 * navigation that leaves this page for the OAuth round trip or the full
 * credentials form, so a connect started from /extension/settings lands
 * back there when it finishes instead of always dropping the seller onto
 * the old web dashboard.
 */

import { useState, useEffect } from "react";
import {
  CheckCircle2,
  AlertCircle,
  ExternalLink,
  Loader2,
  Unlink,
  RefreshCw,
  ShoppingBag,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { JumiaConnectionPublic } from "@/lib/types/jumia";

function withReturnTo(path: string, returnTo?: string): string {
  return returnTo ? `${path}?return_to=${encodeURIComponent(returnTo)}` : path;
}

export function JumiaConnectionCard({ returnTo }: { returnTo?: string }) {
  const [conn,          setConn]          = useState<JumiaConnectionPublic | null>(null);
  const [loading,       setLoading]       = useState(true);
  const [connecting,    setConnecting]    = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [showConfirm,   setShowConfirm]   = useState(false);

  useEffect(() => {
    fetch("/api/jumia/status")
      .then((r) => r.json())
      .then((d) => setConn(d))
      .catch(() => setConn(null))
      .finally(() => setLoading(false));
  }, []);

  // Only valid once credentials already exist on file (needs_reconnect /
  // oauth_required) — /api/jumia/connect 400s with "No Jumia credentials
  // found" for a seller who's never connected at all; that case gets the
  // full form at /onboarding/connect instead (see the "not connected"
  // branch below).
  function handleConnect() {
    setConnecting(true);
    window.location.href = withReturnTo("/api/jumia/connect", returnTo);
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      const res = await fetch("/api/jumia/disconnect", { method: "POST" });
      if (res.ok) {
        // Row deleted — send them to the full connect form to reconnect.
        window.location.href = withReturnTo("/onboarding/connect", returnTo);
      } else {
        setDisconnecting(false);
      }
    } catch {
      setDisconnecting(false);
    }
  }

  const isConnected   = conn?.connected && conn?.status === "active";
  const isExpired     = !!conn?.needs_reconnect;
  // Self Authorization renews itself; a Web Application needs a new login
  // about once a day (lib/jumia/self-auth.ts).
  const autoRenews    = conn?.auth_type === "self";
  const switchHref    = withReturnTo("/onboarding/connect", returnTo);
  const oauthRequired = !!conn?.oauth_required;
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
    <section className="rounded-2xl border bg-white p-6 shadow-sm space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-50 text-xl">
            🛒
          </div>
          <div>
            <p className="font-semibold text-zinc-900">Jumia</p>
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
        <div className="space-y-5">
          <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-4 space-y-3">
            <div className="flex items-center gap-2 text-emerald-700 font-semibold text-sm">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              {conn?.store_name ? `${conn.store_name} is connected` : "Store connected"}
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

          {!autoRenews && (
            <div className="rounded-xl border border-amber-100 bg-amber-50 p-4 text-sm text-amber-800">
              <p>
                This connection uses a Web Application, which Jumia expires about a day after each login
                {expiryDate ? ` (next: ${expiryDate})` : ""}. Switch once to a Self Authorization application and
                PandaWorld keeps you connected automatically.
              </p>
              <Button asChild size="sm" className="mt-3 gap-2">
                <a href={switchHref}>Stay connected automatically</a>
              </Button>
            </div>
          )}

          <div className="flex gap-3">
            {!autoRenews && (
              <Button variant="outline" size="sm" className="gap-2" onClick={handleConnect} disabled={connecting}>
                <RefreshCw className={cn("h-3.5 w-3.5", connecting && "animate-spin")} />
                Re-authorise
              </Button>
            )}
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
        <div className="space-y-4">
          <div className="rounded-xl bg-blue-50 border border-blue-100 p-4 text-sm text-blue-700 flex items-start gap-2">
            <Info className="h-4 w-4 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">One more step</p>
              <p className="mt-0.5">
                Your Jumia credentials are saved. Click <strong>Authorise with Jumia</strong> to complete the
                connection — you&apos;ll be redirected to Vendor Center to grant access.
              </p>
              {conn?.store_name && <p className="mt-1 text-blue-600 text-xs">Store: {conn.store_name}</p>}
            </div>
          </div>
          <Button
            onClick={handleConnect}
            disabled={connecting}
            className="gap-2 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700"
          >
            {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingBag className="h-4 w-4" />}
            {connecting ? "Redirecting to Jumia…" : "Authorise with Jumia"}
          </Button>
        </div>
      ) : isExpired ? (
        <div className="space-y-4">
          <div className="rounded-xl bg-amber-50 border border-amber-100 p-4 text-sm text-amber-700 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            {autoRenews ? (
              <span>
                Jumia stopped accepting PandaWorld&apos;s saved token (it may have been regenerated or the application
                deleted in Vendor Center). Generate a new token and paste it to reconnect.
              </span>
            ) : (
              <span>
                Your Jumia access expired. Web Application connections need a new login about once a day. Switch once
                to a Self Authorization application and PandaWorld keeps you connected automatically.
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Button asChild className="gap-2">
              <a href={switchHref}>{autoRenews ? "Reconnect with a new token" : "Stay connected automatically"}</a>
            </Button>
            {!autoRenews && (
              <Button variant="outline" onClick={handleConnect} disabled={connecting} className="gap-2">
                {connecting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Log in again (lasts a day)
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-red-400 hover:text-red-600"
              onClick={() => setShowConfirm(true)}
            >
              <Unlink className="h-3.5 w-3.5" />
              Disconnect &amp; use new credentials
            </Button>
          </div>
        </div>
      ) : (
        // Never connected at all — no app_id on file for /api/jumia/connect
        // to use, so this goes to the full credentials form instead of
        // straight into an OAuth redirect that would just 400.
        <div className="space-y-4">
          <p className="text-sm text-zinc-600 leading-relaxed">
            Connect your Jumia seller account to push listings directly from PandaWorld.
          </p>
          <Button
            asChild
            className="gap-2 bg-gradient-to-r from-orange-500 to-orange-600 hover:from-orange-600 hover:to-orange-700"
          >
            <a href={withReturnTo("/onboarding/connect", returnTo)}>
              <ShoppingBag className="h-4 w-4" />
              Connect Jumia
            </a>
          </Button>
        </div>
      )}

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
              Your existing listings and data will remain in PandaWorld, but you won&apos;t be able to push
              new listings to Jumia until you reconnect.
            </p>
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setShowConfirm(false)} disabled={disconnecting}>
                Keep connected
              </Button>
              <Button variant="destructive" className="flex-1 gap-2" onClick={handleDisconnect} disabled={disconnecting}>
                {disconnecting && <Loader2 className="h-4 w-4 animate-spin" />}
                Yes, disconnect
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
