"use client";

import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function RegenerateKeyButton() {
  const [pending, startTransition] = useTransition();
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function regenerate() {
    if (!window.confirm("Regenerate your API key? The extension will stop working until you paste the new one in — visit the Dashboard to copy it.")) {
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/extension/keys", { method: "POST" });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data.error || "Could not regenerate the key.");
          return;
        }
        setDone(true);
      } catch {
        setError("Network error — please try again.");
      }
    });
  }

  return (
    <div>
      <Button variant="outline" size="sm" onClick={regenerate} disabled={pending} className="gap-1.5 text-red-600 hover:bg-red-50">
        <RefreshCw className={pending ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"} />
        {pending ? "Regenerating…" : "Regenerate key"}
      </Button>
      {done && (
        <p className="mt-2 text-xs text-emerald-600">
          Done — your new key is ready on the Dashboard.
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
    </div>
  );
}
