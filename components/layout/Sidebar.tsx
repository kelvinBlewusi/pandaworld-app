"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { UserButton, useUser, useClerk } from "@clerk/nextjs";
import {
  LayoutDashboard,
  List,
  Plus,
  Calculator,
  FileText,
  Clock,
  CheckCircle,
  AlertCircle,
  ChevronDown,
  Settings,
  CreditCard,
  Plug,
  Zap,
  LogOut,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// ─── Nav data ───────────────────────────────────────────────────────────────

const primaryNav = [
  { href: "/dashboard",        label: "Dashboard",        icon: LayoutDashboard },
  { href: "/listings",         label: "Listings",          icon: List },
  { href: "/price-calculator", label: "Price calculator",  icon: Calculator },
];

const workflowNavBase = [
  { href: "/listings?status=draft",            label: "Drafts",            icon: FileText,    statusKey: "draft"             },
  { href: "/listings?status=pending_approval", label: "Pending approval",   icon: Clock,       statusKey: "pending_approval"  },
  { href: "/listings?status=live",             label: "Published",          icon: CheckCircle, statusKey: "live"              },
  { href: "/listings?status=failed",           label: "Failed",             icon: AlertCircle, statusKey: "failed"            },
];

const settingsNav = [
  { href: "/settings/account",      label: "Account",          icon: Settings  },
  { href: "/settings/billing",      label: "Plans & billing",  icon: CreditCard },
  { href: "/settings/integrations", label: "Integrations",     icon: Plug      },
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

// ─── New Listing link (single-flow batch upload) ────────────────────────────

function NewListingLink() {
  const pathname = usePathname();
  const isActive = pathname.startsWith("/listings/new");

  return (
    <Link
      href="/listings/new/batch?count=1"
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-all duration-150",
        isActive
          ? "bg-zinc-900 text-white font-medium"
          : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
      )}
    >
      <Plus className="h-4 w-4 shrink-0" />
      <span className="flex-1 text-left">Add Products</span>
    </Link>
  );
}

// ─── User chip (real Clerk identity) ─────────────────────────────────────────

function UserChip() {
  const { user } = useUser();
  return (
    <div className="mt-3 flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-zinc-50">
      <UserButton
        appearance={{
          elements: {
            avatarBox: "h-7 w-7",
          },
        }}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-zinc-800">
          {user?.firstName ?? user?.username ?? "You"}
        </p>
        <p className="truncate text-[10px] text-zinc-400">
          {user?.primaryEmailAddress?.emailAddress ?? ""}
        </p>
      </div>
    </div>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

interface WorkflowCounts {
  draft: number;
  live: number;
  pending_approval: number;
  failed: number;
}

export function Sidebar({
  workflowCounts,
  onClose,
}: {
  workflowCounts?: WorkflowCounts;
  onClose?: () => void;
}) {
  const counts = workflowCounts ?? { draft: 0, live: 0, pending_approval: 0, failed: 0 };
  const workflowNav = workflowNavBase.map(({ statusKey, ...item }) => ({
    ...item,
    count: counts[statusKey as keyof WorkflowCounts] ?? 0,
  }));
  const { user } = useUser();
  const { signOut } = useClerk();
  const router = useRouter();

  return (
    <aside className="flex h-screen w-64 flex-col border-r bg-white">
      {/* Brand + workspace dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex w-full items-center gap-2.5 border-b px-4 py-4 hover:bg-zinc-50 transition-colors focus:outline-none">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 text-base shadow-sm">
              🐼
            </div>
            <div className="min-w-0 flex-1 text-left">
              <p className="truncate text-sm font-bold text-zinc-900">PandaWorld</p>
              <p className="truncate text-[10px] text-zinc-400">
                {user?.primaryEmailAddress?.emailAddress ?? "Workspace"}
              </p>
            </div>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
          {onClose && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              onKeyDown={(e) => e.key === "Enter" && onClose()}
              className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700 transition-colors"
              aria-label="Close menu"
            >
              <X className="h-4 w-4" />
            </span>
          )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="w-56">
          <div className="px-3 py-2">
            <p className="text-sm font-semibold text-zinc-800 truncate">
              {user?.firstName
                ? `${user.firstName}${user.lastName ? " " + user.lastName : ""}`
                : user?.username ?? "PandaWorld"}
            </p>
            <p className="text-xs text-zinc-400 truncate">
              {user?.primaryEmailAddress?.emailAddress ?? ""}
            </p>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link href="/settings/account" className="flex items-center gap-2 cursor-pointer">
              <Settings className="h-4 w-4" />
              Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            className="flex items-center gap-2 text-red-500 focus:text-red-600 cursor-pointer"
            onClick={() => signOut(() => router.push("/sign-in"))}
          >
            <LogOut className="h-4 w-4" />
            Log out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Scrollable nav */}
      <nav className="flex-1 space-y-0.5 overflow-y-auto px-3 py-3">
        {primaryNav.map((item) => (
          <NavItem key={item.href} {...item} />
        ))}

        {/* New listing with dropdown */}
        <NewListingLink />

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
        <UserChip />
      </div>
    </aside>
  );
}
