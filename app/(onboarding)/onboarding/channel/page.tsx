"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Check, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const channels = [
  {
    id: "jumia",
    name: "Jumia",
    emoji: "🛒",
    description: "Africa's leading e-commerce platform",
    color: "from-orange-400 to-orange-500",
    enabled: true,
  },
  {
    id: "shopify",
    name: "Shopify",
    emoji: "🏪",
    description: "Build your own online store",
    color: "from-green-400 to-emerald-500",
    enabled: false,
  },
  {
    id: "ebay",
    name: "eBay",
    emoji: "🔵",
    description: "Global auction & buy-it-now marketplace",
    color: "from-blue-400 to-blue-500",
    enabled: false,
  },
  {
    id: "amazon",
    name: "Amazon",
    emoji: "📦",
    description: "World's largest online retailer",
    color: "from-yellow-400 to-orange-400",
    enabled: false,
  },
  {
    id: "facebook",
    name: "Facebook",
    emoji: "👥",
    description: "Sell in Facebook Marketplace & shops",
    color: "from-blue-500 to-blue-600",
    enabled: false,
  },
  {
    id: "wix",
    name: "Wix",
    emoji: "🌐",
    description: "Wix eCommerce for your website",
    color: "from-indigo-400 to-violet-500",
    enabled: false,
  },
  {
    id: "woocommerce",
    name: "WooCommerce",
    emoji: "🔮",
    description: "WordPress-powered online stores",
    color: "from-purple-400 to-purple-600",
    enabled: false,
  },
  {
    id: "etsy",
    name: "Etsy",
    emoji: "🎨",
    description: "Handmade & vintage marketplace",
    color: "from-orange-300 to-red-400",
    enabled: false,
  },
  {
    id: "tiktok",
    name: "TikTok Shop",
    emoji: "🎵",
    description: "Social commerce on TikTok",
    color: "from-pink-500 to-rose-500",
    enabled: false,
  },
];

const progressSteps = ["Select channel", "Connect", "Done"];

export default function ChannelPage() {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);

  const handleContinue = () => {
    if (selected === "jumia") {
      router.push("/onboarding/connect");
    }
  };

  return (
    <div className="space-y-8">
      {/* Progress steps */}
      <div className="flex items-center justify-center gap-2">
        {progressSteps.map((step, i) => (
          <div key={step} className="flex items-center gap-2">
            <div
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold",
                i === 0
                  ? "bg-fuchsia-500 text-white shadow-lg shadow-fuchsia-500/40"
                  : "bg-white/10 text-white/40"
              )}
            >
              {i + 1}
            </div>
            <span
              className={cn(
                "text-xs",
                i === 0 ? "font-medium text-white" : "text-white/35"
              )}
            >
              {step}
            </span>
            {i < progressSteps.length - 1 && (
              <div className="h-px w-8 bg-white/15" />
            )}
          </div>
        ))}
      </div>

      {/* Header */}
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-fuchsia-500 to-orange-400 text-2xl shadow-lg shadow-fuchsia-500/30">
          🐼
        </div>
        <h1 className="text-2xl font-bold text-white">
          Select your selling channel
        </h1>
        <p className="mt-2 text-sm text-white/50">
          Where do you want to publish your listings?
        </p>
      </div>

      {/* Channel grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {channels.map((channel, i) => (
          <motion.button
            key={channel.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: i * 0.04 }}
            onClick={() => channel.enabled && setSelected(channel.id)}
            className={cn(
              "relative flex flex-col items-center gap-2.5 rounded-2xl border p-5 text-center transition-all duration-150",
              channel.enabled
                ? selected === channel.id
                  ? "border-fuchsia-400/60 bg-fuchsia-500/15 ring-2 ring-fuchsia-400/30"
                  : "border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/10 cursor-pointer"
                : "border-white/5 bg-white/3 opacity-40 cursor-not-allowed"
            )}
          >
            {selected === channel.id && (
              <div className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-fuchsia-500">
                <Check className="h-3 w-3 text-white" />
              </div>
            )}
            {!channel.enabled && (
              <div className="absolute right-2 top-2 rounded-full bg-white/10 px-2 py-0.5 text-[9px] font-semibold text-white/40">
                Soon
              </div>
            )}
            <div
              className={cn(
                "flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br text-xl shadow-sm",
                channel.color
              )}
            >
              {channel.emoji}
            </div>
            <div>
              <p className="text-sm font-semibold text-white">
                {channel.name}
              </p>
              <p className="mt-0.5 text-[11px] text-white/45 leading-tight">
                {channel.description}
              </p>
            </div>
          </motion.button>
        ))}
      </div>

      {/* CTA */}
      <Button
        className="w-full gap-2 h-11 bg-fuchsia-500 hover:bg-fuchsia-600 text-white shadow-lg shadow-fuchsia-500/30 disabled:opacity-30 disabled:shadow-none"
        disabled={!selected}
        onClick={handleContinue}
      >
        Continue with{" "}
        {channels.find((c) => c.id === selected)?.name ?? "selected channel"}
        <ArrowRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
