"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { CheckCircle2, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const progressSteps = ["Connect", "Done"];

export default function OnboardingDonePage() {
  const router = useRouter();
  const [storeName, setStoreName] = useState<string | null>(null);
  // Set only when the connect round trip started from somewhere other than
  // this onboarding flow (e.g. /extension/settings) — see
  // lib/jumia/return-to.ts. Sends the seller back there instead of always
  // funnelling them into the old web dashboard.
  const [returnTo, setReturnTo] = useState<string | null>(null);

  useEffect(() => {
    // Pick up store name + returnTo from URL params set by the connect flow
    const params = new URLSearchParams(window.location.search);
    const name = params.get("store");
    if (name) setStoreName(decodeURIComponent(name));
    const rt = params.get("return_to");
    if (rt && rt.startsWith("/") && !rt.startsWith("//")) setReturnTo(rt);
  }, []);

  return (
    <div className="space-y-8">
      {/* Progress bar */}
      <div className="flex items-center justify-center gap-2">
        {progressSteps.map((step, i) => (
          <div key={step} className="flex items-center gap-2">
            <div
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold",
                "bg-blue-600 text-white"
              )}
            >
              {i < progressSteps.length - 1 ? <span>✓</span> : i + 1}
            </div>
            <span className="text-xs font-medium text-zinc-700">{step}</span>
            {i < progressSteps.length - 1 && (
              <div className="h-px w-8 bg-blue-600" />
            )}
          </div>
        ))}
      </div>

      {/* Success card */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 22 }}
        className="rounded-2xl border bg-white p-10 shadow-sm text-center space-y-5"
      >
        <motion.div
          initial={{ scale: 0 }}
          animate={{ scale: 1 }}
          transition={{ delay: 0.2, type: "spring", stiffness: 300, damping: 18 }}
          className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-emerald-50"
        >
          <CheckCircle2 className="h-10 w-10 text-emerald-500" />
        </motion.div>

        <div className="space-y-2">
          <h1 className="text-2xl font-bold text-zinc-900">You&apos;re all set!</h1>
          {storeName ? (
            <p className="text-sm text-zinc-500">
              <span className="font-medium text-zinc-800">{storeName}</span> is connected.
              You can now publish listings directly to Jumia.
            </p>
          ) : (
            <p className="text-sm text-zinc-500">
              Your Jumia store is connected. You can now publish listings directly.
            </p>
          )}
        </div>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.35 }}
          className="flex flex-col gap-3 pt-2"
        >
          <Button
            className="gap-2 h-11 w-full bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700"
            onClick={() => router.push(returnTo ?? "/dashboard")}
          >
            {returnTo ? "Continue" : "Go to dashboard"}
            <ArrowRight className="h-4 w-4" />
          </Button>
          {returnTo?.startsWith("/extension") ? (
            <Button
              variant="ghost"
              className="text-zinc-400 text-sm"
              onClick={() => router.push("/extension/whatsapp-listings")}
            >
              Start listing from WhatsApp →
            </Button>
          ) : (
            <Button
              variant="ghost"
              className="text-zinc-400 text-sm"
              onClick={() => router.push("/listings/new/batch?count=1&mode=own")}
            >
              Create my first listing →
            </Button>
          )}
        </motion.div>
      </motion.div>
    </div>
  );
}
