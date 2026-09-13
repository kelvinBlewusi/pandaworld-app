"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { CheckCircle2, AlertCircle, X, Plug, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { WhatsAppCard } from "@/components/whatsapp/whatsapp-card";
import { JumiaConnectionCard } from "@/components/jumia/jumia-connection-card";

// ─── Inner page (needs useSearchParams — must be inside Suspense) ─────────────

function IntegrationsPageInner() {
  const router       = useRouter();
  const searchParams = useSearchParams();

  const [toast, setToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  // ── Handle Jumia OAuth redirect back ──────────────────────────────────────
  useEffect(() => {
    const connected   = searchParams.get("connected");
    const jumiaError  = searchParams.get("jumia_error");

    if (connected === "1") {
      showToast("success", "🎉 Jumia store connected! Our AI can now publish your products to vendor center for you.");
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

      <JumiaConnectionCard />

      <WhatsAppCard />

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
