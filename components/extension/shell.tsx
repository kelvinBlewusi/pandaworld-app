"use client";

/**
 * App shell for app/extension/(app) — sidebar + a persistent utility bar
 * (Donate / Plan / Credits / notifications / Install Extension),
 * modeled on components/layout/MainShell.tsx's desktop-sidebar +
 * mobile-drawer pattern so the extension flow feels like the same app.
 *
 * Plan/credit data is fetched server-side (in layout.tsx) and passed in as
 * props — this component only owns the interactive chrome (mobile drawer
 * open state), not data fetching.
 */

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useUser } from "@clerk/nextjs";
import { Menu, Heart, Bell, X } from "lucide-react";
import { ExtensionSidebar } from "./sidebar";
import { Wordmark } from "@/components/marketing/wordmark";
import { DonateModal } from "./donate-modal";
import { GoogleIcon } from "./google-icon";
import { CHROME_WEB_STORE_URL } from "@/lib/constants/support";
import type { CreditTransaction } from "@/lib/billing/extension-credits";
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
  notificationsSeenAt,
  isAdmin = false,
}: {
  children: React.ReactNode;
  planLabel: string;
  creditsLabel: string;
  notifications: CreditTransaction[];
  notificationsSeenAt: string | null;
  isAdmin?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [donateOpen, setDonateOpen] = useState(false);
  const [items, setItems] = useState(notifications);
  // seenAt drives the bell's own alert dot — it clears the instant the
  // dropdown opens. displaySeenAt drives each item's "new" highlight and
  // deliberately lags one open behind: it only catches up to seenAt when
  // the dropdown CLOSES, so a first-time viewer still gets to see which
  // items were new during this viewing, and they stop looking new starting
  // the next time the bell is opened.
  const [seenAt, setSeenAt] = useState(notificationsSeenAt);
  const [displaySeenAt, setDisplaySeenAt] = useState(notificationsSeenAt);
  const pathname = usePathname();
  const { user } = useUser();
  const pageTitle = PAGE_TITLES[pathname] ?? "Extension Dashboard";

  useEffect(() => {
    setItems(notifications);
    setSeenAt(notificationsSeenAt);
    setDisplaySeenAt(notificationsSeenAt);
  }, [notifications, notificationsSeenAt]);

  const hasUnseen = items.some((n) => !seenAt || new Date(n.created_at) > new Date(seenAt));
  const isNew = (n: CreditTransaction) => !displaySeenAt || new Date(n.created_at) > new Date(displaySeenAt);

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

  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-50">
      {/* Desktop sidebar */}
      <div className="hidden lg:flex">
        <ExtensionSidebar isAdmin={isAdmin} />
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
      <div
        className={[
          "fixed inset-y-0 left-0 z-50 flex flex-col transition-transform duration-300 ease-in-out lg:hidden",
          open ? "translate-x-0" : "-translate-x-full",
        ].join(" ")}
      >
        <ExtensionSidebar onClose={() => setOpen(false)} isAdmin={isAdmin} />
      </div>

      {/* Main content area */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Mobile top bar */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-white px-4 lg:hidden">
          <button
            onClick={() => setOpen(true)}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 transition-colors"
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <Wordmark size={20} />
        </header>

        {/* Utility bar — page title + greeting on the left (changes per
            page), Buy Credits / Plan / Credits / notifications / Install on
            the right, same order across every page in this shell. */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-4 border-b bg-white px-4 py-4 sm:px-6">
          <div>
            <h1 className="text-xl font-bold text-zinc-900 sm:text-2xl">{pageTitle}</h1>
            <p className="text-sm text-zinc-500">Welcome, {user?.firstName ?? user?.username ?? "there"}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              onClick={() => setDonateOpen(true)}
              className="flex items-center gap-1.5 rounded-full bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
            >
              <Heart className="h-4 w-4" /> Donate
            </button>
            <span className="rounded-full border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-600">
              Plan: {planLabel}
            </span>
            <span className="flex items-center gap-1.5 rounded-full border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-600">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-500" /> Credits: {creditsLabel}
            </span>
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
              <DropdownMenuContent align="end" className="w-80 max-h-96 overflow-y-auto">
                <DropdownMenuLabel>Account activity</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {items.length === 0 ? (
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

      <DonateModal open={donateOpen} onClose={() => setDonateOpen(false)} />
    </div>
  );
}
