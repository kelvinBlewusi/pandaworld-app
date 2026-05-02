"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { motion } from "framer-motion";
import { ExternalLink, FileSpreadsheet, ShieldCheck, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const progressSteps = ["Select channel", "Connect", "Done"];

export default function ConnectPage() {
  const router = useRouter();
  const [isConnecting, setIsConnecting] = useState(false);

  const handleOAuth = () => {
    setIsConnecting(true);
    // Simulate OAuth flow
    setTimeout(() => {
      router.push("/dashboard");
    }, 2000);
  };

  return (
    <div className="space-y-8">
      {/* Progress dots */}
      <div className="flex items-center justify-center gap-2">
        {progressSteps.map((step, i) => (
          <div key={step} className="flex items-center gap-2">
            <div
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold",
                i <= 1
                  ? "bg-blue-600 text-white"
                  : "bg-zinc-100 text-zinc-400"
              )}
            >
              {i + 1}
            </div>
            <span
              className={cn(
                "text-xs",
                i <= 1 ? "font-medium text-zinc-700" : "text-zinc-400"
              )}
            >
              {step}
            </span>
            {i < progressSteps.length - 1 && (
              <div
                className={cn(
                  "h-px w-8",
                  i === 0 ? "bg-blue-600" : "bg-zinc-200"
                )}
              />
            )}
          </div>
        ))}
      </div>

      {/* Header */}
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-orange-400 to-orange-500 text-3xl shadow-lg">
          🛒
        </div>
        <h1 className="text-2xl font-bold text-zinc-900">
          Connect your Jumia Vendor Center
        </h1>
        <p className="mt-2 text-sm text-zinc-500">
          Authorise PandaWorld to publish listings on your behalf.
        </p>
      </div>

      {/* OAuth option */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="rounded-2xl border bg-white p-6 shadow-sm space-y-4"
      >
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-50 shrink-0">
            <ExternalLink className="h-5 w-5 text-orange-500" />
          </div>
          <div>
            <p className="font-semibold text-zinc-800">
              Connect via Jumia OAuth
            </p>
            <p className="mt-1 text-sm text-zinc-500">
              You'll be redirected to Jumia to authorise access. PandaWorld
              never stores your Jumia password.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-xl bg-zinc-50 px-4 py-3">
          <ShieldCheck className="h-4 w-4 text-emerald-500 shrink-0" />
          <p className="text-xs text-zinc-500">
            PandaWorld only requests <strong>write access to listings</strong>. We do not
            access orders, payments, or personal data beyond what's needed.
          </p>
        </div>

        <Button
          className="w-full h-11 gap-2 bg-gradient-to-r from-orange-400 to-orange-500 hover:from-orange-500 hover:to-orange-600 text-white"
          onClick={handleOAuth}
          disabled={isConnecting}
        >
          {isConnecting ? (
            <>
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Connecting…
            </>
          ) : (
            <>
              <ExternalLink className="h-4 w-4" />
              Connect with Jumia
            </>
          )}
        </Button>
      </motion.div>

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px bg-zinc-200" />
        <span className="text-xs text-zinc-400">or</span>
        <div className="flex-1 h-px bg-zinc-200" />
      </div>

      {/* Spreadsheet fallback */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="rounded-2xl border border-dashed bg-white p-6 shadow-sm space-y-3"
      >
        <div className="flex items-start gap-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-zinc-50 shrink-0">
            <FileSpreadsheet className="h-5 w-5 text-zinc-400" />
          </div>
          <div>
            <p className="font-semibold text-zinc-800">
              I'll upload via spreadsheet
            </p>
            <p className="mt-1 text-sm text-zinc-500">
              Skip the OAuth step and manually export listings as a CSV for upload
              to Jumia. You can always connect later.
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          className="w-full h-11"
          onClick={() => router.push("/dashboard")}
        >
          Skip for now — go to dashboard
        </Button>
      </motion.div>

      <Button variant="ghost" size="sm" asChild className="w-full text-zinc-400">
        <Link href="/onboarding/channel">
          <ArrowLeft className="mr-1 h-3.5 w-3.5" />
          Back to channel selection
        </Link>
      </Button>
    </div>
  );
}
