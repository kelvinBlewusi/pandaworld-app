import { cn } from "@/lib/utils";
import type { ListingStatus } from "@/lib/mock/listings";

const statusConfig: Record<
  ListingStatus,
  { label: string; className: string }
> = {
  draft: {
    label: "Draft",
    className: "bg-zinc-100 text-zinc-600 border-zinc-200",
  },
  processing: {
    label: "Processing",
    className: "bg-blue-50 text-blue-600 border-blue-200",
  },
  pending_approval: {
    label: "Pending",
    className: "bg-amber-50 text-amber-600 border-amber-200",
  },
  live: {
    label: "Live",
    className: "bg-emerald-50 text-emerald-600 border-emerald-200",
  },
  failed: {
    label: "Failed",
    className: "bg-red-50 text-red-600 border-red-200",
  },
};

interface StatusPillProps {
  status: ListingStatus;
  className?: string;
}

export function StatusPill({ status, className }: StatusPillProps) {
  const config = statusConfig[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        config.className,
        className
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          status === "live" && "bg-emerald-500",
          status === "draft" && "bg-zinc-400",
          status === "processing" && "bg-blue-500 animate-pulse",
          status === "pending_approval" && "bg-amber-500",
          status === "failed" && "bg-red-500"
        )}
      />
      {config.label}
    </span>
  );
}
