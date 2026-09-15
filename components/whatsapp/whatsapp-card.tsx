"use client";

/**
 * Account linking for the WhatsApp chatbot (create + push a Jumia listing
 * from a chat) — see lib/whatsapp/link.ts. The seller taps a wa.me deep
 * link pre-filled with a one-time code; the webhook matches it back to
 * their account. No OAuth here (WhatsApp has no such flow for this) — just
 * a short-lived linking code, same idea as the extension's own API keys
 * but disposable rather than a standing credential.
 *
 * Shared between Settings -> Integrations (app/(main)/settings/integrations)
 * and the extension flow's List from WhatsApp empty state
 * (app/extension/(app)/whatsapp-listings) — the latter deliberately lives
 * outside the (main) route group's Jumia-connection gate (see
 * components/extension/sidebar.tsx's own doc comment on why), so it's the
 * only place a brand-new seller with no Jumia connection yet can actually
 * reach a "Connect WhatsApp" button at all. Its own /api/whatsapp/* routes
 * only require a Clerk session, never a Jumia connection, so it works
 * identically in both places.
 */

import { WhatsAppIcon } from "@/components/whatsapp/whatsapp-icon";
import { useState, useEffect } from "react";
import {CheckCircle2, Loader2, Unlink, Copy, AlertTriangle} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { JumiaConnectionPublic } from "@/lib/types/jumia";

interface WhatsAppStatus {
  connected: boolean;
  phoneNumber?: string;
  linkedAt?: string;
}

export function WhatsAppCard() {
  const [status, setStatus] = useState<WhatsAppStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [link, setLink] = useState<{ code: string; waLink: string; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  // Flags the Jumia connection right alongside the WhatsApp one — a seller
  // could otherwise have a linked WhatsApp number with no Jumia connection
  // (or a broken one) and no way to tell short of the chatbot mentioning
  // it reactively mid-flow.
  const [jumiaStatus, setJumiaStatus] = useState<JumiaConnectionPublic | null>(null);

  const loadStatus = () => {
    fetch("/api/whatsapp/status")
      .then((r) => r.json())
      .then((d) => setStatus(d))
      .catch(() => setStatus({ connected: false }))
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadStatus(); }, []);

  useEffect(() => {
    if (!status?.connected) return;
    fetch("/api/jumia/status")
      .then((r) => r.json())
      .then((d) => setJumiaStatus(d))
      .catch(() => setJumiaStatus(null));
  }, [status?.connected]);

  async function handleGenerateLink() {
    setGenerating(true);
    setLink(null);
    setLinkError(null);
    try {
      const res = await fetch("/api/whatsapp/generate-link", { method: "POST" });
      if (res.ok) {
        setLink(await res.json());
      } else {
        const data = await res.json().catch(() => null);
        setLinkError(data?.error ?? `Couldn't generate a link (HTTP ${res.status}). Try again.`);
      }
    } catch {
      setLinkError("Network error — check your connection and try again.");
    } finally {
      setGenerating(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      await fetch("/api/whatsapp/disconnect", { method: "POST" });
      setLink(null);
      loadStatus();
    } finally {
      setDisconnecting(false);
      setConfirmingDisconnect(false);
    }
  }

  function copyCode() {
    if (!link) return;
    navigator.clipboard.writeText(link.message).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const linkedDate = status?.linkedAt
    ? new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(
        new Date(status.linkedAt),
      )
    : null;

  return (
    <section className="rounded-2xl border bg-white p-6 shadow-sm space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
            <WhatsAppIcon className="h-5 w-5" />
          </div>
          <div>
            <p className="font-semibold text-zinc-900">WhatsApp</p>
            <p className="text-xs text-zinc-400">Create and push listings from a chat</p>
          </div>
        </div>
        {!loading && (
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-xs font-semibold",
              status?.connected ? "bg-emerald-50 text-emerald-700" : "bg-zinc-100 text-zinc-500",
            )}
          >
            {status?.connected ? "Connected" : "Not connected"}
          </span>
        )}
      </div>

      <Separator />

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          Checking connection…
        </div>
      ) : status?.connected ? (
        <div className="space-y-4">
          <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-4 space-y-2">
            <div className="flex items-center gap-2 text-emerald-700 font-semibold text-sm">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              {status.phoneNumber} is linked
            </div>
            {linkedDate && <p className="text-xs text-zinc-500">Linked {linkedDate}</p>}
          </div>

          {jumiaStatus && (
            <div
              className={cn(
                "flex items-start gap-2 rounded-xl border p-3 text-xs",
                jumiaStatus.connected
                  ? "border-emerald-100 bg-emerald-50 text-emerald-700"
                  : "border-amber-200 bg-amber-50 text-amber-800",
              )}
            >
              {jumiaStatus.connected ? (
                <CheckCircle2 className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              )}
              <span>
                {jumiaStatus.connected
                  ? `Jumia connected${jumiaStatus.store_name ? ` — ${jumiaStatus.store_name}` : ""}.`
                  : jumiaStatus.needs_reconnect
                  ? `Jumia needs reconnecting — message ${status.phoneNumber ?? "the bot"} on WhatsApp to fix it.`
                  : jumiaStatus.oauth_required
                  ? `Jumia setup incomplete — message ${status.phoneNumber ?? "the bot"} on WhatsApp to finish connecting.`
                  : `Jumia isn't connected yet — message ${status.phoneNumber ?? "the bot"} on WhatsApp to connect your store.`}
              </span>
            </div>
          )}

          {confirmingDisconnect ? (
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-100 bg-red-50 p-3">
              <p className="text-xs text-red-700">
                Unlink this number? You&apos;ll need a new code to reconnect.
              </p>
              <div className="ml-auto flex gap-2">
                <Button variant="ghost" size="sm" onClick={() => setConfirmingDisconnect(false)} disabled={disconnecting}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  className="gap-2"
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                >
                  {disconnecting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                  Yes, disconnect
                </Button>
              </div>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="gap-2 text-red-400 hover:text-red-600"
              onClick={() => setConfirmingDisconnect(true)}
            >
              <Unlink className="h-3.5 w-3.5" />
              Disconnect
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          {link ? (
            <div className="rounded-xl bg-blue-50 border border-blue-100 p-4 space-y-3 text-sm">
              {link.waLink ? (
                <>
                  <p className="text-blue-700">Tap below to open WhatsApp with your code pre-filled:</p>
                  <a
                    href={link.waLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-2 rounded-md bg-emerald-500 px-4 py-2 text-white font-semibold hover:bg-emerald-600"
                  >
                    <WhatsAppIcon className="h-4 w-4" />
                    Open WhatsApp to link
                  </a>
                </>
              ) : (
                <p className="text-blue-700">
                  Send this message to the PandaWorld bot number:
                </p>
              )}
              <div className="flex items-center gap-2">
                <code className="rounded bg-blue-100 px-2.5 py-1.5 font-mono text-sm text-blue-900">
                  LINK-{link.code}
                </code>
                <button
                  type="button"
                  onClick={copyCode}
                  className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
                >
                  <Copy className="h-3 w-3" />
                  {copied ? "Copied!" : "Copy message"}
                </button>
              </div>
              <p className="text-xs text-blue-500">This code expires in 15 minutes.</p>
            </div>
          ) : (
            <div className="space-y-2">
              <Button onClick={handleGenerateLink} disabled={generating} className="gap-2 bg-emerald-500 hover:bg-emerald-600">
                {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <WhatsAppIcon className="h-4 w-4" />}
                {generating ? "Generating…" : "Connect WhatsApp"}
              </Button>
              {linkError && <p className="text-sm text-red-600">{linkError}</p>}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
