"use client";

/**
 * Sidebar for the extension's own app shell (app/extension/(app)/layout.tsx)
 * — visually modeled on components/layout/Sidebar.tsx (the main app's
 * sidebar) so the extension flow reads as the same product, but built as
 * its own component rather than reused directly: the main Sidebar's nav
 * items (Listings, Price calculator, Settings…) all point at routes inside
 * the (main) route group, which gates on an ACTIVE Jumia OAuth connection
 * (see (main)/layout.tsx) — exactly what the extension flow exists to let
 * sellers skip. Every link here has to stay outside that group.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton, useUser } from "@clerk/nextjs";
import {
  LayoutDashboard,
  Calculator,
  ListChecks,
  MessageCircle,
  HelpCircle,
  BookOpen,
  LifeBuoy,
  Settings,
  ArrowRight,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Wordmark } from "@/components/marketing/wordmark";

const primaryNav = [
  { href: "/extension/dashboard",  label: "Extension Dashboard", icon: LayoutDashboard },
  { href: "/extension/whatsapp-listings", label: "List from WhatsApp", icon: MessageCircle },
  { href: "/extension/calculator", label: "Calculator",  icon: Calculator },
  { href: "/extension/listings",   label: "Autofill Activity", icon: ListChecks },
];

// Content for these doesn't exist yet — shown so the shell reads complete,
// but deliberately inert (no href, no click) rather than a broken link.
const comingSoonNav = [
  { label: "FAQ",     icon: HelpCircle },
  { label: "How to",  icon: BookOpen },
  { label: "Support", icon: LifeBuoy },
];

const settingsItem = { href: "/extension/settings", label: "Settings", icon: Settings };

function NavItem({ href, label, icon: Icon }: { href: string; label: string; icon: React.ElementType }) {
  const pathname = usePathname();
  const isActive = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-all duration-150",
        isActive
          ? "bg-zinc-900 text-white font-medium"
          : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900",
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1">{label}</span>
    </Link>
  );
}

function ComingSoonItem({ label, icon: Icon }: { label: string; icon: React.ElementType }) {
  return (
    <div
      className="flex cursor-not-allowed items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-zinc-300"
      aria-disabled="true"
      title="Coming soon"
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1">{label}</span>
      <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-zinc-400">
        Soon
      </span>
    </div>
  );
}

export function ExtensionSidebar({ onClose }: { onClose?: () => void }) {
  const { user } = useUser();

  return (
    <aside className="flex h-screen w-64 flex-col border-r bg-white">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-4">
        <Link href="/extension" aria-label="pandaworld home">
          <Wordmark size={22} />
        </Link>
        {onClose && (
          <button
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 transition-colors"
            aria-label="Close menu"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-3">
        {primaryNav.map((item) => (
          <NavItem key={item.href} {...item} />
        ))}

        <div className="pb-1 pt-3">
          <div className="mb-3 h-px bg-zinc-100" />
        </div>

        {comingSoonNav.map((item) => (
          <ComingSoonItem key={item.label} {...item} />
        ))}

        <div className="pb-1 pt-3">
          <div className="mb-3 h-px bg-zinc-100" />
        </div>

        <NavItem {...settingsItem} />
      </nav>

      <div className="px-3 pb-4">
        {/* Explicit, opt-in bridge into the classic Jumia-OAuth flow — kept
            as a distinct bordered pill (not a regular nav item) so it reads
            as "leave the extension flow", same intent as before this
            redesign. Lands on /push-listings, not the OAuth gate itself. */}
        <Link
          href="/push-listings"
          title="Push listings the classic way — connects Jumia via OAuth in PandaWorld's main app"
          className="flex items-center justify-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-600 hover:border-zinc-300 hover:bg-zinc-50"
        >
          Push Listings from here <ArrowRight className="h-3 w-3" />
        </Link>

        <div className="mt-3 flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-zinc-50">
          <UserButton appearance={{ elements: { avatarBox: "h-7 w-7" } }} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-zinc-800">
              {user?.firstName ?? user?.username ?? "You"}
            </p>
            <p className="truncate text-[10px] text-zinc-400">
              {user?.primaryEmailAddress?.emailAddress ?? ""}
            </p>
          </div>
        </div>
      </div>
    </aside>
  );
}
