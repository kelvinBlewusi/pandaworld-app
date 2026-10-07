import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * The PandaWorld "P" at icon size, in place of a generic icon (owner,
 * 2026-10-07: our logo, not the sparkle). On a small white tile, so it
 * stays visible on the sidebar's dark active row.
 */
export function PandaLogoIcon({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center justify-center rounded-[4px] bg-white", className)} aria-hidden="true">
      <Image src="/brand/panda-p-logo-trimmed.png" alt="" width={634} height={562} className="h-[80%] w-auto" />
    </span>
  );
}
