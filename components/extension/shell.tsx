"use client";

/**
 * App shell for app/extension/(app) — sidebar + a persistent utility bar
 * (Plan / Credits / notifications / Install Extension), modeled on
 * components/layout/MainShell.tsx's desktop-sidebar + mobile-drawer
 * pattern so the extension flow feels like the same app.
 *
 * Plan/credit data is fetched server-side (in layout.tsx) and passed in as
 * props — this component only owns the interactive chrome (mobile drawer
 * open state), not data fetching.
 */

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { Menu, Bell, X } from "lucide-react";
import { ExtensionSidebar } from "./sidebar";
import { Wordmark } from "@/components/marketing/wordmark";
import { GoogleIcon } from "./google-icon";
import { CHROME_WEB_STORE_URL } from "@/lib/constants/support";
import { WhatsAppBotButton } from "@/components/whatsapp/whatsapp-bot-button";
import { BuyCreditsModal } from "./buy-credits-modal";
import type { CreditTransaction } from "@/lib/billing/extension-credits";
import type { UserNotice } from "@/lib/notices";
import { RichText } from "./rich-text";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const PAGE_TITLES: Record<string, string> = {
  "/extension/dashboard": "Extension Dashboard",
  "/extension/assistant": "Jumia Listing Assistant",
  "/extension/whatsapp-listings": "List from WhatsApp",
  "/extension/calculator": "Calculator",
  "/extension/listings": "Autofill Activity",
  "/extension/settings": "Settings",
};

const TYPE_DOT: Record<CreditTransaction["type"], string> = {
  grant: "bg-emerald-500",
  purchase: "bg-blue-500",
  deduction: "bg-zinc-400",
  refund: "bg-purple-500",
};

const TYPE_LABEL: Record<CreditTransaction["type"], string> = {
  grant: "Credits granted",
  purchase: "Credits purchased",
  deduction: "Credits used",
  refund: "Credits refunded",
};

function formatRelativeTime(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function ExtensionShell({
  children,
  planLabel,
  creditsLabel,
  notifications,
  notices = [],
  notificationsSeenAt,
  isAdmin = false,
  canBuyCredits = false,
  listingCost,
  showAssistant = false,
}: {
  children: React.ReactNode;
  planLabel: string;
  creditsLabel: string;
  notifications: CreditTransaction[];
  /** Messages from PandaWorld (lib/notices.ts), shown above the account activity. */
  notices?: UserNotice[];
  notificationsSeenAt: string | null;
  isAdmin?: boolean;
  /** Show "Buy credits" — only while billing is on (lib/billing/mode.ts). */
  canBuyCredits?: boolean;
  /** What a listing costs this seller, for the pack picker. */
  listingCost?: number;
  /** The Listing Assistant is on for this seller (lib/whatsapp/listing-assistant.ts). */
  showAssistant?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [buyOpen, setBuyOpen] = useState(false);
  const [items, setItems] = useState(notifications);
  const [noticeItems, setNoticeItems] = useState(notices);
  // seenAt drives the bell's own alert dot — it clears the instant the
  // dropdown opens. displaySeenAt drives each item's "new" highlight and
  // deliberately lags one open behind: it only catches up to seenAt when
  // the dropdown CLOSES, so a first-time viewer still gets to see which
  // items were new during this viewing, and they stop looking new starting
  // the next time the bell is opened.
  const [seenAt, setSeenAt] = useState(notificationsSeenAt);
  const [displaySeenAt, setDisplaySeenAt] = useState(notificationsSeenAt);
  const pathname = usePathname();
  const onAssistant = pathname === "/extension/assistant";
  const { user } = useUser();
  const pageTitle = PAGE_TITLES[pathname] ?? "Extension Dashboard";

  useEffect(() => {
    setItems(notifications);
    setNoticeItems(notices);
    setSeenAt(notificationsSeenAt);
    setDisplaySeenAt(notificationsSeenAt);
  }, [notifications, notices, notificationsSeenAt]);

  const hasUnseen = [...items, ...noticeItems].some((n) => !seenAt || new Date(n.created_at) > new Date(seenAt));
  const isNew = (n: { created_at: string }) => !displaySeenAt || new Date(n.created_at) > new Date(displaySeenAt);

  function handleOpenChange(next: boolean) {
    if (next) {
      if (!hasUnseen) return;
      setSeenAt(new Date().toISOString());
      fetch("/api/extension/notifications/seen", { method: "POST" }).catch(() => {});
    } else {
      setDisplaySeenAt(seenAt);
    }
  }

  function dismiss(id: string) {
    setItems((prev) => prev.filter((n) => n.id !== id));
    fetch("/api/extension/notifications/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {});
  }

  function dismissNotice(id: string) {
    setNoticeItems((prev) => prev.filter((n) => n.id !== id));
    fetch("/api/extension/notifications/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, kind: "notice" }),
    }).catch(() => {});
  }

  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  return (
    // h-[100dvh] rather than h-screen — see the note in sidebar.tsx: on iOS
    // Safari 100vh ignores the browser chrome, so the bottom of the app sat
    // underneath it.
    <div className="flex h-[100dvh] overflow-hidden bg-zinc-50">
      {/* Desktop sidebar */}
      <div className="hidden lg:flex">
        <ExtensionSidebar isAdmin={isAdmin} showAssistant={showAssistant} />
      </div>

      {/* Mobile drawer */}
      <div
        className={[
          "fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity duration-300 lg:hidden",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        ].join(" ")}
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />
      {/* Mobile drawer — anchored RIGHT.
          Requested by the user, and it suits the device: on a phone held in
          one hand the right edge is where the thumb already is, while the
          left edge is where iOS Safari's back-swipe lives, so a
          left-anchored drawer competes with a system gesture. The menu
          button below moves to the same side, so the control and the panel
          it opens are not at opposite ends of the screen. */}
      <div
        className={[
          "fixed inset-y-0 right-0 z-50 flex flex-col transition-transform duration-300 ease-in-out lg:hidden",
          open ? "translate-x-0" : "translate-x-full",
        ].join(" ")}
      >
        <ExtensionSidebar onClose={() => setOpen(false)} isAdmin={isAdmin} showAssistant={showAssistant} />
      </div>

      {/* On a phone the sidebar is behind ☰: the same note, bottom right. */}
      {showAssistant && !onAssistant && (
        <Link
          href="/extension/assistant"
          className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-4 z-30 flex items-center gap-2 rounded-full bg-orange-500 px-4 py-3 text-sm font-semibold text-white shadow-lg transition-colors hover:bg-orange-600 lg:hidden"
        >
          💬 Talk to your Listing Assistant
        </Link>
      )}

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile top bar */}
        <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b bg-white px-4 lg:hidden">
          {/* Home, like the sidebar's logo: it was the only logo that went nowhere. */}
          <Link href="/extension" aria-label="pandaworld home">
            <Wordmark size={20} />
          </Link>
          {/* On the right, matching the drawer it opens. 44px square — the
              minimum tap target, where this was 36. */}
          <button
            onClick={() => setOpen(true)}
            className="flex h-11 w-11 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
        </header>

        {/* Utility bar — page title + greeting on the left (changes per
            page), Plan (a link to /pricing) / Credits / notifications /
            Install on the right, same order across every page in this shell. */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b bg-white px-4 py-4 sm:px-6">
          <div>
            <h1 className="text-xl font-bold text-zinc-900 sm:text-2xl">{pageTitle}</h1>
            <p className="text-sm text-zinc-500">Welcome, {user?.firstName ?? user?.username ?? "there"}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {/* Looks like the Credits pill beside it; tapping it opens the pricing page. */}
            <Link
              href="/pricing"
              className="rounded-full border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900 active:bg-zinc-100"
            >
              Plan: {planLabel}
            </Link>
            <span className="flex items-center gap-1.5 rounded-full border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-600">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-500" /> Credits: {creditsLabel}
            </span>
            {canBuyCredits && (
              <button
                type="button"
                onClick={() => setBuyOpen(true)}
                className="rounded-full bg-orange-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-orange-600"
              >
                Buy credits
              </button>
            )}
            <DropdownMenu onOpenChange={handleOpenChange}>
              <DropdownMenuTrigger asChild>
                <button
                  className="relative flex h-10 w-10 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
                  aria-label="Notifications"
                >
                  <Bell className="h-4.5 w-4.5" />
                  {hasUnseen && (
                    <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-orange-500" />
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-80 max-h-[28rem] overflow-y-auto">
                <DropdownMenuLabel>Account activity</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {noticeItems.map((n) => (
                  <DropdownMenuItem
                    key={n.id}
                    onSelect={(e) => e.preventDefault()}
                    className="flex-col items-start gap-1.5 whitespace-normal border-b border-zinc-100 pb-3 last:border-b-0"
                  >
                    <div className="flex w-full items-start gap-2">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-orange-500" />
                      <span className={["flex-1 text-sm", isNew(n) ? "font-semibold text-zinc-900" : "font-medium text-zinc-600"].join(" ")}>
                        {n.title}
                      </span>
                      <button
                        onClick={() => dismissNotice(n.id)}
                        className="shrink-0 rounded p-0.5 text-zinc-300 hover:bg-zinc-100 hover:text-zinc-600"
                        aria-label="Dismiss notification"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="space-y-2 pl-3.5 text-xs leading-relaxed text-zinc-600">
                      {n.body.split(/\n{2,}/).map((paragraph, i) => (
                        <p key={i}><RichText text={paragraph} /></p>
                      ))}
                    </div>
                    <div className="pl-3.5 text-xs text-zinc-400">{formatRelativeTime(n.created_at)}</div>
                  </DropdownMenuItem>
                ))}
                {items.length === 0 && noticeItems.length === 0 ? (
                  <div className="px-2 py-6 text-center text-sm text-zinc-500">
                    No activity yet
                  </div>
                ) : (
                  items.map((n) => (
                    <DropdownMenuItem
                      key={n.id}
                      onSelect={(e) => e.preventDefault()}
                      className="flex-col items-start gap-1"
                    >
                      <div className="flex w-full items-center gap-2">
                        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TYPE_DOT[n.type]}`} />
                        <span
                          className={[
                            "flex-1 truncate text-sm",
                            isNew(n) ? "font-semibold text-zinc-900" : "font-medium text-zinc-500",
                          ].join(" ")}
                        >
                          {n.description ?? TYPE_LABEL[n.type]}
                        </span>
                        <button
                          onClick={() => dismiss(n.id)}
                          className="shrink-0 rounded p-0.5 text-zinc-300 hover:bg-zinc-100 hover:text-zinc-600"
                          aria-label="Dismiss notification"
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                      <div className="pl-3.5 text-xs text-zinc-500">
                        {n.amount > 0 ? "+" : "-"}
                        {Math.abs(n.amount)} credits · {formatRelativeTime(n.created_at)}
                      </div>
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <WhatsAppBotButton />
            <a
              href={CHROME_WEB_STORE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-full bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-zinc-800"
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-white">
                <GoogleIcon className="h-3.5 w-3.5" />
              </span>
              Install Extension
            </a>
          </div>
        </div>

        <main className="flex-1 overflow-y-auto">
          <div className="min-h-full p-4 sm:p-6 lg:p-8">{children}</div>
        </main>
      </div>
      {canBuyCredits && <BuyCreditsModal open={buyOpen} onClose={() => setBuyOpen(false)} listingCost={listingCost} />}
    </div>
  );
}
