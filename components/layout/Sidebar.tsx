"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  List,
  Plus,
  Calculator,
  Upload,
  FileText,
  Clock,
  CheckCircle,
  AlertCircle,
  ChevronDown,
  ChevronRight,
  Settings,
  Zap,
  ImageIcon,
  Wand2,
  Link2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// ─── Nav data ───────────────────────────────────────────────────────────────

const primaryNav = [
  { href: "/dashboard",        label: "Dashboard",        icon: LayoutDashboard },
  { href: "/listings",         label: "Listings",          icon: List },
  { href: "/price-calculator", label: "Price calculator",  icon: Calculator },
  { href: "/imports",          label: "Imports",           icon: Upload },
];

const workflowNav = [
  { href: "/listings?status=draft",            label: "Drafts",            icon: FileText,     count: 5  },
  { href: "/listings?status=pending_approval", label: "Pending approval",   icon: Clock,        count: 4  },
  { href: "/listings?status=live",             label: "Published",          icon: CheckCircle,  count: 10 },
  { href: "/listings?status=failed",           label: "Failed",             icon: AlertCircle,  count: 2  },
];

const settingsNav = [
  { href: "/settings/account", label: "Account", icon: Settings },
];

// ─── New Listing modes ────────────────────────────────────────────────────────

const listingModes = [
  {
    mode: "own",
    icon: ImageIcon,
    iconColor: "text-blue-500",
    bg: "bg-blue-50",
    label: "My own product images",
    sub: "Upload up to 8 photos per product",
  },
  {
    mode: "ai",
    icon: Wand2,
    iconColor: "text-violet-500",
    bg: "bg-violet-50",
    label: "AI-generated images",
    sub: "1 reference photo or text description",
  },
  {
    mode: "url",
    icon: Link2,
    iconColor: "text-emerald-500",
    bg: "bg-emerald-50",
    label: "Import from URL",
    sub: "Paste product page links",
  },
];

// ─── Standard nav item ────────────────────────────────────────────────────────

interface NavItemProps {
  href: string;
  label: string;
  icon: React.ElementType;
  count?: number;
}

function NavItem({ href, label, icon: Icon, count }: NavItemProps) {
  const pathname = usePathname();
  const isActive =
    href === "/dashboard"
      ? pathname === "/dashboard"
      : pathname.startsWith(href.split("?")[0]) && href !== "/dashboard";

  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-all duration-150",
        isActive
          ? "bg-zinc-900 text-white font-medium"
          : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
      )}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1">{label}</span>
      {count !== undefined && (
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
            isActive ? "bg-white/20 text-white" : "bg-zinc-100 text-zinc-500"
          )}
        >
          {count}
        </span>
      )}
    </Link>
  );
}

// ─── New Listing dropdown trigger ────────────────────────────────────────────

function NewListingDropdown() {
  const pathname = usePathname();
  const router = useRouter();
  const isActive = pathname.startsWith("/listings/new");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-all duration-150",
            isActive
              ? "bg-zinc-900 text-white font-medium"
              : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
          )}
        >
          <Plus className="h-4 w-4 shrink-0" />
          <span className="flex-1 text-left">New listing</span>
          <ChevronRight
            className={cn(
              "h-3 w-3 shrink-0 opacity-40",
              isActive && "opacity-60"
            )}
          />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={10}
        className="w-64 p-2 space-y-0.5"
      >
        {/* Header */}
        <p className="px-3 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
          Choose listing method
        </p>

        {listingModes.map(({ mode, icon: Icon, iconColor, bg, label, sub }) => (
          <button
            key={mode}
            onClick={() => router.push(`/listings/new?mode=${mode}`)}
            className="flex w-full items-center gap-3 rounded-xl p-2.5 text-left transition-colors hover:bg-zinc-50 active:bg-zinc-100"
          >
            <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", bg)}>
              <Icon className={cn("h-4 w-4", iconColor)} />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-zinc-800 leading-snug">{label}</p>
              <p className="text-[11px] text-zinc-400 leading-snug">{sub}</p>
            </div>
          </button>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

export function Sidebar() {
  return (
    <aside className="flex h-screen w-60 flex-col border-r bg-white">
      {/* Brand + workspace switcher */}
      <div className="flex items-center gap-2.5 border-b px-4 py-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 text-base shadow-sm">
          🐼
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-zinc-900">PandaWorld</p>
          <p className="truncate text-[10px] text-zinc-400">Kelvin&apos;s workspace</p>
        </div>
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
      </div>

      {/* Scrollable nav */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-3">
        {primaryNav.map((item) => (
          <NavItem key={item.href} {...item} />
        ))}

        {/* New listing with dropdown */}
        <NewListingDropdown />

        <div className="pb-1 pt-3">
          <Separator className="mb-3" />
          <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
            Workflows
          </p>
        </div>

        {workflowNav.map((item) => (
          <NavItem key={item.href} {...item} />
        ))}

        <div className="pb-1 pt-3">
          <Separator className="mb-3" />
        </div>

        {settingsNav.map((item) => (
          <NavItem key={item.href} {...item} />
        ))}
      </nav>

      {/* Upsell card */}
      <div className="px-3 pb-4">
        <div className="relative overflow-hidden rounded-xl bg-gradient-to-br from-blue-500 to-purple-600 p-4 text-white">
          <div className="absolute -right-3 -top-3 h-16 w-16 rounded-full bg-white/10" />
          <Zap className="mb-2 h-4 w-4 text-yellow-300" />
          <p className="text-xs font-semibold leading-snug">Connect more channels</p>
          <p className="mt-0.5 text-[10px] text-blue-100">Sell on Shopify, Amazon & more</p>
          <Link
            href="/onboarding/channel"
            className="mt-3 inline-block rounded-lg bg-white px-3 py-1.5 text-[11px] font-semibold text-blue-600 transition-opacity hover:opacity-90"
          >
            Set up
          </Link>
        </div>

        {/* User chip */}
        <div className="mt-3 flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-zinc-50">
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-orange-400 to-pink-500 text-xs font-bold text-white">
            K
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-zinc-800">Kelvin</p>
            <p className="truncate text-[10px] text-zinc-400">kelvinblewu@gmail.com</p>
          </div>
        </div>
      </div>
    </aside>
  );
}
