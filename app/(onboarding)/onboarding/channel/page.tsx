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
      {/* Progress dots */}
      <div className="flex items-center justify-center gap-2">
        {progressSteps.map((step, i) => (
          <div key={step} className="flex items-center gap-2">
            <div
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold",
                i === 0
                  ? "bg-blue-600 text-white"
                  : "bg-zinc-100 text-zinc-400"
              )}
            >
              {i + 1}
            </div>
            <span
              className={cn(
                "text-xs",
                i === 0 ? "font-medium text-zinc-700" : "text-zinc-400"
              )}
            >
              {step}
            </span>
            {i < progressSteps.length - 1 && (
              <div className="h-px w-8 bg-zinc-200" />
            )}
          </div>
        ))}
      </div>

      {/* Header */}
      <div className="text-center">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-blue-500 to-purple-600 text-2xl shadow-lg">
          🐼
        </div>
        <h1 className="text-2xl font-bold text-zinc-900">
          Select your selling channel
        </h1>
        <p className="mt-2 text-sm text-zinc-500">
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
                  ? "border-blue-500 bg-blue-50 ring-2 ring-blue-500/30"
                  : "border-zinc-200 bg-white hover:border-zinc-300 hover:shadow-sm cursor-pointer"
                : "border-zinc-100 bg-zinc-50 opacity-60 cursor-not-allowed"
            )}
          >
            {selected === channel.id && (
              <div className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-blue-600">
                <Check className="h-3 w-3 text-white" />
              </div>
            )}
            {!channel.enabled && (
              <div className="absolute right-2 top-2 rounded-full bg-zinc-100 px-2 py-0.5 text-[9px] font-semibold text-zinc-400">
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
              <p className="text-sm font-semibold text-zinc-800">
                {channel.name}
              </p>
              <p className="mt-0.5 text-[11px] text-zinc-400 leading-tight">
                {channel.description}
              </p>
            </div>
          </motion.button>
        ))}
      </div>

      {/* CTA */}
      <Button
        className="w-full gap-2 h-11"
        disabled={!selected}
        onClick={handleContinue}
      >
        Continue with {channels.find((c) => c.id === selected)?.name ?? "selected channel"}
        <ArrowRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
