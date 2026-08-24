"use client";

/**
 * Client-side API key manager for /extension/dashboard.
 *
 * Talks to /api/extension/keys (GET/POST/DELETE) — that route is Clerk-
 * protected by the normal middleware gate, so no key/token handling is
 * needed here beyond the fetch calls themselves.
 */

import { useState, useTransition } from "react";
import { Copy, Check, KeyRound, Trash2, Plus, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ExtensionApiKeyRow } from "@/lib/security/extension-keys";

function formatDate(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function ExtensionKeysPanel({ initialKeys }: { initialKeys: ExtensionApiKeyRow[] }) {
  const [keys, setKeys] = useState(initialKeys);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const activeKeys = keys.filter((k) => !k.revokedAt);

  function generate() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/extension/keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "Chrome Extension" }),
        });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Could not create the key.");
          return;
        }
        setRevealedKey(data.fullKey);
        setKeys((prev) => [data.key, ...prev]);
      } catch {
        setError("Network error — please try again.");
      }
    });
  }

  function revoke(keyId: string) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(`/api/extension/keys?keyId=${encodeURIComponent(keyId)}`, {
          method: "DELETE",
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.error || "Could not revoke the key.");
          return;
        }
        setKeys((prev) =>
          prev.map((k) => (k.keyId === keyId ? { ...k, revokedAt: new Date().toISOString() } : k)),
        );
      } catch {
        setError("Network error — please try again.");
      }
    });
  }

  async function copyKey() {
    if (!revealedKey) return;
    try {
      await navigator.clipboard.writeText(revealedKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can fail in insecure contexts — the key is still
      // selectable text, so this is a soft failure.
    }
  }

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5 text-orange-600" />
          <h2 className="text-lg font-bold text-zinc-900">API keys</h2>
        </div>
        <Button size="sm" onClick={generate} disabled={pending || activeKeys.length >= 5}>
          <Plus className="h-4 w-4" /> New key
        </Button>
      </div>
      <p className="mt-1 text-sm text-zinc-600">
        Paste a key into the extension&apos;s Settings panel to authenticate it. Keys
        only authorize autofill requests — they can&apos;t touch billing or your account.
      </p>

      {revealedKey && (
        <div className="mt-4 rounded-xl border border-orange-200 bg-orange-50 p-4">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-orange-700">
            <ShieldAlert className="h-3.5 w-3.5" /> Copy this now — it won&apos;t be shown again.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="flex-1 truncate rounded-lg bg-white px-3 py-2 text-xs text-zinc-800">
              {revealedKey}
            </code>
            <Button size="sm" variant="outline" onClick={copyKey}>
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>

          <p className="mt-3 text-xs font-semibold text-zinc-700">How to use it</p>
          <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs text-zinc-600">
            <li>Copy the key above.</li>
            <li>Install the PandaWorld extension in Chrome (see the guide on the right).</li>
            <li>Open the extension, paste the key into Settings, and it connects.</li>
          </ol>
          <p className="mt-3 text-xs font-semibold text-red-600">
            Important: don&apos;t share this key with anyone — anyone who has it can run
            autofills against your quota.
          </p>
        </div>
      )}

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <div className="mt-5 divide-y divide-zinc-100">
        {keys.length === 0 && (
          <p className="py-6 text-center text-sm text-zinc-400">
            No keys yet — generate one to connect the extension.
          </p>
        )}
        {keys.map((k) => (
          <div key={k.id} className="flex items-center justify-between py-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-zinc-900">
                {k.name}{" "}
                <span className="font-mono text-xs text-zinc-400">
                  pw_live_&hellip;{k.suffix}
                </span>
              </p>
              <p className="text-xs text-zinc-500">
                Created {formatDate(k.createdAt)} · Last used {formatDate(k.lastUsedAt)}
                {k.revokedAt && <span className="ml-2 text-red-500">· Revoked</span>}
              </p>
            </div>
            {!k.revokedAt && (
              <Button
                size="sm"
                variant="ghost"
                className="text-red-500 hover:bg-red-50 hover:text-red-600"
                onClick={() => revoke(k.keyId)}
                disabled={pending}
              >
                <Trash2 className="h-4 w-4" /> Revoke
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
