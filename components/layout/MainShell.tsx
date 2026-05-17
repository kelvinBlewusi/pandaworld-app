"use client";

import { useState, useEffect } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { ReconnectBanner } from "./ReconnectBanner";
import { WhatsAppButton } from "./WhatsAppButton";

interface WorkflowCounts {
  draft: number;
  live: number;
  pending_approval: number;
  failed: number;
}

export function MainShell({
  children,
  workflowCounts,
  isAdmin = false,
}: {
  children: React.ReactNode;
  workflowCounts?: WorkflowCounts;
  isAdmin?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close sidebar whenever route changes (user tapped a nav link)
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Lock body scroll while sidebar is open on mobile
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  return (
    <div className="flex h-screen overflow-hidden bg-zinc-50/50">

      {/* ── Desktop sidebar (always visible ≥ lg) ── */}
      <div className="hidden lg:flex">
        <Sidebar workflowCounts={workflowCounts} isAdmin={isAdmin} />
      </div>

      {/* ── Mobile drawer ── */}
      {/* Backdrop */}
      <div
        className={[
          "fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity duration-300 lg:hidden",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none",
        ].join(" ")}
        onClick={() => setOpen(false)}
        aria-hidden="true"
      />

      {/* Drawer panel */}
      <div
        className={[
          "fixed inset-y-0 left-0 z-50 flex flex-col transition-transform duration-300 ease-in-out lg:hidden",
          open ? "translate-x-0" : "-translate-x-full",
        ].join(" ")}
      >
        <Sidebar workflowCounts={workflowCounts} isAdmin={isAdmin} onClose={() => setOpen(false)} />
      </div>

      {/* ── Main content area ── */}
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
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 text-sm shadow-sm">
              🐼
            </div>
            <span className="text-sm font-bold text-zinc-900">PandaWorld</span>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          <ReconnectBanner />
          <div className="min-h-full p-4 sm:p-6 lg:p-8">{children}</div>
        </main>
      </div>

      {/* Floating WhatsApp support button (draggable, position saved per browser) */}
      <WhatsAppButton />
    </div>
  );
}
