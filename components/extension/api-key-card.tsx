"use client";

/**
 * "Your API Key" card for /extension/dashboard — every seller gets exactly
 * one fixed key (lib/security/extension-keys.ts's getOrCreateExtensionApiKey),
 * shown masked with a reveal/copy control, mirroring the single-key-card
 * pattern from competitor extension dashboards rather than our old
 * generate/revoke multi-key list.
 */

import { useState, useTransition } from "react";
import { Copy, Check, KeyRound, Eye, EyeOff, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ApiKeyCard({ initialKey }: { initialKey: string }) {
  const [fullKey, setFullKey] = useState(initialKey);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  async function copyKey() {
    try {
      await navigator.clipboard.writeText(fullKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can fail in insecure contexts — the key is still
      // selectable text once revealed, so this is a soft failure.
    }
  }

  function regenerate() {
    if (!window.confirm("Regenerate your API key? The extension will stop working until you paste the new one in.")) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/extension/keys", { method: "POST" });
        const data = await res.json();
        if (!res.ok) {
          setError(data.error || "Could not regenerate the key.");
          return;
        }
        setFullKey(data.fullKey);
        setRevealed(true);
      } catch {
        setError("Network error — please try again.");
      }
    });
  }

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-orange-50 text-orange-600">
          <KeyRound className="h-5 w-5" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-zinc-900">Your API Key</h2>
          <p className="mt-0.5 text-sm text-zinc-600">
            Use this key to connect the PandaWorld extension to your account.
          </p>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <div className="flex-1 truncate rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2.5 font-mono text-sm text-zinc-800">
          {revealed ? fullKey : "•".repeat(38)}
        </div>
        <Button size="icon" variant="outline" onClick={() => setRevealed((r) => !r)} aria-label={revealed ? "Hide key" : "Show key"}>
          {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </Button>
        <Button variant="outline" onClick={copyKey} className="gap-1.5">
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>

      <div className="mt-4">
        <p className="text-xs font-semibold text-zinc-700">How to use your API key</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-zinc-600">
          <li>Copy your API key from the field above (click the Copy button).</li>
          <li>Download the PandaWorld extension from the Chrome Web Store and add it to your browser.</li>
          <li>Open the extension panel, paste this key into the API Key field, and connect.</li>
        </ul>
      </div>

      <p className="mt-3 text-xs font-semibold text-red-600">
        Important: Do not share your API key with anyone. Anyone with access to this key can use your credits.
      </p>

      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

      <button
        onClick={regenerate}
        disabled={pending}
        className="mt-4 flex items-center gap-1.5 text-xs font-medium text-zinc-400 hover:text-zinc-600 disabled:opacity-50"
      >
        <RefreshCw className={pending ? "h-3 w-3 animate-spin" : "h-3 w-3"} />
        {pending ? "Regenerating…" : "Regenerate key"}
      </button>
    </div>
  );
}
