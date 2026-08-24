"use client";

/**
 * App shell for app/extension/(app) — sidebar + a persistent utility bar
 * (Buy Credits / Plan / Credits / notifications / Install Extension),
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
import { Menu, Plus, Bell, Chrome } from "lucide-react";
import { ExtensionSidebar } from "./sidebar";
import { Wordmark } from "@/components/marketing/wordmark";
import { BuyCreditsModal } from "./buy-credits-modal";

const PAGE_TITLES: Record<string, string> = {
  "/extension/dashboard": "Dashboard",
  "/extension/calculator": "Calculator",
  "/extension/listings": "My listings",
  "/extension/settings": "Settings",
};

export function ExtensionShell({
  children,
  planLabel,
  creditsLabel,
}: {
  children: React.ReactNode;
  planLabel: string;
  creditsLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [buyOpen, setBuyOpen] = useState(false);
  const pathname = usePathname();
  const { user } = useUser();
  const pageTitle = PAGE_TITLES[pathname] ?? "Dashboard";

  useEffect(() => { setOpen(false); }, [pathname]);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-50">
      {/* Desktop sidebar */}
      <div className="hidden lg:flex">
        <ExtensionSidebar />
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
        <ExtensionSidebar onClose={() => setOpen(false)} />
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
              onClick={() => setBuyOpen(true)}
              className="flex items-center gap-1.5 rounded-full bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
            >
              <Plus className="h-4 w-4" /> Buy Credits
            </button>
            <span className="rounded-full border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-600">
              Plan: {planLabel}
            </span>
            <span className="flex items-center gap-1.5 rounded-full border border-zinc-200 px-4 py-2.5 text-sm font-medium text-zinc-600">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-500" /> Credits: {creditsLabel}
            </span>
            <button
              className="flex h-10 w-10 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
              aria-label="Notifications (coming soon)"
              title="Coming soon"
            >
              <Bell className="h-4.5 w-4.5" />
            </button>
            <a
              href="/extension/dashboard#setup-guide"
              className="flex items-center gap-1.5 rounded-full bg-zinc-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-zinc-800"
            >
              <Chrome className="h-4 w-4" /> Install Extension
            </a>
          </div>
        </div>

        <main className="flex-1 overflow-y-auto">
          <div className="min-h-full p-4 sm:p-6 lg:p-8">{children}</div>
        </main>
      </div>

      <BuyCreditsModal open={buyOpen} onClose={() => setBuyOpen(false)} />
    </div>
  );
}
