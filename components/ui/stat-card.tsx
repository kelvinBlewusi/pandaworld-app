"use client";

import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

type GradientVariant = "blue" | "orange" | "lavender" | "green";

const gradients: Record<GradientVariant, string> = {
  blue: "from-blue-500 to-purple-600",
  orange: "from-orange-400 to-pink-500",
  lavender: "from-violet-400 to-purple-500",
  green: "from-emerald-400 to-teal-500",
};

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon?: React.ReactNode;
  gradient?: GradientVariant;
  className?: string;
}

export function StatCard({
  title,
  value,
  subtitle,
  icon,
  gradient = "blue",
  className,
}: StatCardProps) {
  return (
    <motion.div
      whileHover={{ y: -2, scale: 1.01 }}
      transition={{ type: "spring", stiffness: 400, damping: 25 }}
      className={cn(
        "relative overflow-hidden rounded-2xl p-6 text-white shadow-sm",
        `bg-gradient-to-br ${gradients[gradient]}`,
        className
      )}
    >
      <div className="absolute inset-0 bg-white/5 backdrop-blur-[1px]" />
      <div className="relative z-10 flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-white/80">{title}</p>
          <p className="mt-1 text-3xl font-bold tracking-tight">{value}</p>
          {subtitle && (
            <p className="mt-1 text-xs text-white/70">{subtitle}</p>
          )}
        </div>
        {icon && (
          <div className="rounded-xl bg-white/20 p-2.5 text-white">
            {icon}
          </div>
        )}
      </div>
      <div className="absolute -bottom-4 -right-4 h-24 w-24 rounded-full bg-white/10" />
      <div className="absolute -bottom-8 -right-8 h-32 w-32 rounded-full bg-white/5" />
    </motion.div>
  );
}
