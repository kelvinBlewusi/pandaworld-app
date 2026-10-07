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

import { WhatsAppIcon } from "@/components/whatsapp/whatsapp-icon";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { UserButton, useUser } from "@clerk/nextjs";
import {LayoutDashboard, Calculator, ListChecks, HelpCircle, BookOpen, Settings, ArrowRight, X, MessageSquare, AlertTriangle, Ban, Sparkles} from "lucide-react";
import { cn } from "@/lib/utils";
import { Wordmark } from "@/components/marketing/wordmark";
import { COMMUNITY_WHATSAPP_URL } from "@/lib/constants/support";

const primaryNav = [
  { href: "/extension/dashboard",  label: "Extension Dashboard", icon: LayoutDashboard },
  { href: "/extension/whatsapp-listings", label: "List from WhatsApp", icon: WhatsAppIcon },
  { href: "/extension/calculator", label: "Calculator",  icon: Calculator },
  { href: "/extension/listings",   label: "Autofill Activity", icon: ListChecks },
  // Points at the public /how-to page (not an /extension/... route) so the
  // same guides are reachable — and indexable by Google — whether a seller
  // is signed in or not. See app/how-to/page.tsx.
  { href: "/how-to",               label: "Guides",       icon: BookOpen },
];

// The Listing Assistant (app/extension/(app)/assistant): shown to the sellers
// it's on for (lib/whatsapp/listing-assistant.ts), right under the dashboard.
const assistantItem = { href: "/extension/assistant", label: "Jumia Listing Assistant", icon: Sparkles };

// Public, like Guides, so the same answers reach sellers before they sign up.
const faqItem = { href: "/faq", label: "FAQ", icon: HelpCircle };

const settingsItem = { href: "/extension/settings", label: "Settings", icon: Settings };

// Only rendered when isAdmin — same ADMIN_USER_IDS allow-list
// (lib/auth/is-admin.ts) components/layout/Sidebar.tsx already gates its
// own admin section with. Not linked anywhere else in this app shell, so
// a regular seller never sees "Admin" in their own nav.
const adminNav = [
  { href: "/admin/messages", label: "WhatsApp log", icon: MessageSquare },
  { href: "/admin/errors",   label: "Errors",        icon: AlertTriangle },
  { href: "/admin/blocked-categories", label: "Blocked categories", icon: Ban },
];

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

/** Support — opens the community WhatsApp group in a new tab. Styled with
 *  the WhatsApp brand green so it reads as "this leaves to WhatsApp",
 *  same visual language as the floating WhatsAppButton used elsewhere. */
function SupportNavItem() {
  return (
    <a
      href={COMMUNITY_WHATSAPP_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-zinc-500 transition-all duration-150 hover:bg-emerald-50 hover:text-emerald-700"
    >
      <svg viewBox="0 0 32 32" className="h-4 w-4 shrink-0 fill-current" xmlns="http://www.w3.org/2000/svg">
        <path d="M16.003 2C8.28 2 2 8.28 2 16.003c0 2.47.65 4.87 1.88 6.99L2 30l7.22-1.85A13.94 13.94 0 0 0 16.003 30C23.72 30 30 23.72 30 16.003 30 8.28 23.72 2 16.003 2zm0 25.47a11.52 11.52 0 0 1-5.88-1.61l-.42-.25-4.28 1.1 1.13-4.14-.27-.43A11.47 11.47 0 0 1 4.53 16c0-6.33 5.15-11.47 11.47-11.47S27.47 9.67 27.47 16 22.33 27.47 16.003 27.47zm6.3-8.6c-.35-.17-2.05-1.01-2.37-1.13-.31-.11-.54-.17-.77.17-.23.35-.88 1.13-1.08 1.36-.2.23-.4.25-.75.08-.35-.17-1.48-.55-2.82-1.74-1.04-.93-1.74-2.08-1.95-2.43-.2-.35-.02-.54.15-.71.16-.16.35-.4.52-.6.17-.2.23-.35.35-.58.11-.23.06-.44-.03-.61-.08-.17-.77-1.86-1.06-2.54-.28-.67-.56-.58-.77-.59h-.66c-.23 0-.6.08-.91.4-.31.31-1.19 1.16-1.19 2.83s1.22 3.28 1.39 3.51c.17.23 2.4 3.67 5.82 5.14.81.35 1.44.56 1.94.72.81.26 1.55.22 2.13.13.65-.1 2.01-.82 2.29-1.61.28-.8.28-1.48.2-1.62-.08-.14-.3-.22-.66-.39z"/>
      </svg>
      <span className="flex-1">Support</span>
    </a>
  );
}

export function ExtensionSidebar({ onClose, isAdmin = false, showAssistant = false }: { onClose?: () => void; isAdmin?: boolean; showAssistant?: boolean }) {
  const { user } = useUser();

  return (
    // h-[100dvh], not h-screen. On iOS Safari 100vh is the height of the
    // viewport WITHOUT the browser chrome, so the last ~90px of this panel
    // sat underneath the address bar and the tab strip — which is exactly
    // where the account row lives. The seller reported never seeing it, and
    // "Push Listings from here" was visibly sliced in half above it. dvh
    // tracks the real, currently-visible viewport.
    //
    // The safe-area padding is the second half: on a notched iPhone the
    // home indicator overlays the bottom edge, so even a correctly-sized
    // panel needs to keep its last row clear of it.
    <aside
      // Border follows the side the panel is on: the mobile drawer now
      // slides in from the RIGHT, so its edge faces left; the desktop
      // sidebar is still on the left and keeps its right edge.
      className="flex h-[100dvh] w-64 flex-col border-l border-zinc-200 bg-white lg:border-l-0 lg:border-r"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
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
        {primaryNav.map((item, i) => (
          <span key={item.href} className="contents">
            <NavItem {...item} />
            {i === 0 && showAssistant && <NavItem {...assistantItem} />}
          </span>
        ))}

        <div className="pb-1 pt-3">
          <div className="mb-3 h-px bg-zinc-100" />
        </div>

        <NavItem {...faqItem} />
        <SupportNavItem />

        {isAdmin && (
          <>
            <div className="pb-1 pt-3">
              <div className="mb-3 h-px bg-zinc-100" />
              <p className="px-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                Admin
              </p>
            </div>
            {adminNav.map((item) => (
              <NavItem key={item.href} {...item} />
            ))}
          </>
        )}

        <div className="pb-1 pt-3">
          <div className="mb-3 h-px bg-zinc-100" />
        </div>

        <NavItem {...settingsItem} />
      </nav>

      <div className="shrink-0 px-3 pb-4">
        {/* Explicit bridge into the classic Jumia-OAuth flow, for admins
            only (lib/auth/is-admin.ts), who still use it for testing and
            support. Sellers used to see it greyed out; since 2026-09-29 they
            don't see it at all: WhatsApp and the extension are how they list. */}
        {isAdmin && (
          <Link
            href="/push-listings"
            className="mb-3 flex items-center justify-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-2 text-xs font-medium text-zinc-500 transition-colors hover:border-zinc-300 hover:text-zinc-900"
          >
            Push Listings from here <ArrowRight className="h-3 w-3" />
          </Link>
        )}

        {/* Sized for a thumb: 44px is Apple's minimum tap target, and the
            avatar was 28px in a row that measured about 34. The text steps
            up with it — 10px email on a phone is decorative, not legible. */}
        <div className="flex min-h-[44px] items-center gap-2.5 rounded-lg border border-zinc-100 px-2 py-2 hover:bg-zinc-50">
          <UserButton appearance={{ elements: { avatarBox: "h-8 w-8 md:h-7 md:w-7" } }} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-zinc-800 md:text-xs">
              {user?.firstName ?? user?.username ?? "You"}
            </p>
            <p className="truncate text-xs text-zinc-500 md:text-[10px]">
              {user?.primaryEmailAddress?.emailAddress ?? ""}
            </p>
          </div>
        </div>
      </div>
    </aside>
  );
}
