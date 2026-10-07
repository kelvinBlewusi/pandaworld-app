"use client";

/**
 * "Install PandaWorld" on a phone (owner, 2026-10-07: install buttons in
 * Settings and the footer; "when the apple one is tapped it pushes the page
 * up and shows instructions to adding to home ... the playstore too does
 * same for android users").
 *
 * There's no App Store or Play Store app: PandaWorld installs from the
 * browser (app/manifest.ts). So the buttons look like store badges but
 * don't use Apple's or Google's names or logos, which their rules keep
 * for real store listings, and a seller tapping "App Store" would expect
 * one. Each slides up a sheet with that phone's steps. On Android, where
 * Chrome offers its own install prompt, the sheet has an Install now
 * button that opens it; the steps are there either way.
 */

import { useEffect, useState } from "react";
import { Download, EllipsisVertical, Plus, Share, Smartphone, SquarePlus, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Phone = "ios" | "android";

/** Chrome's install prompt, kept from its beforeinstallprompt event. */
interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const STEPS: Record<Phone, { title: string; intro: string; steps: { icon: React.ReactNode; text: React.ReactNode }[]; note: string }> = {
  ios: {
    title: "Add PandaWorld to your iPhone",
    intro: "It goes on your home screen like an app, and opens full screen.",
    steps: [
      { icon: <Smartphone className="h-4 w-4" />, text: <>Open <b>pandaworldai.site</b> in <b>Safari</b>.</> },
      { icon: <Share className="h-4 w-4" />, text: <>Tap the <b>Share</b> button (the square with an arrow) at the bottom of the screen. On an iPad it&apos;s at the top.</> },
      { icon: <SquarePlus className="h-4 w-4" />, text: <>Scroll down and tap <b>Add to Home Screen</b>.</> },
      { icon: <Plus className="h-4 w-4" />, text: <>Tap <b>Add</b>. PandaWorld is now on your home screen.</> },
    ],
    note: "In Chrome on an iPhone, tap the Share button beside the address bar, then Add to Home Screen.",
  },
  android: {
    title: "Install PandaWorld on Android",
    intro: "It goes on your home screen like an app, and opens full screen.",
    steps: [
      { icon: <Smartphone className="h-4 w-4" />, text: <>Open <b>pandaworldai.site</b> in <b>Chrome</b>.</> },
      { icon: <EllipsisVertical className="h-4 w-4" />, text: <>Tap the <b>⋮</b> menu at the top right.</> },
      { icon: <Download className="h-4 w-4" />, text: <>Tap <b>Install app</b> (on some phones, <b>Add to Home screen</b>).</> },
      { icon: <Plus className="h-4 w-4" />, text: <>Tap <b>Install</b>. PandaWorld is now on your home screen.</> },
    ],
    note: "In Samsung Internet, tap the menu (☰), then Add page to, then Home screen.",
  },
};

/** The Apple shape is Apple's: a plain phone glyph stands in, in the same black badge. */
function Badge({ phone, onClick, dark }: { phone: Phone; onClick: () => void; dark: boolean }) {
  const ios = phone === "ios";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-haspopup="dialog"
      className={cn(
        "inline-flex h-12 min-w-[146px] items-center gap-2 rounded-xl border px-3 text-left transition-colors",
        dark ? "border-zinc-900 bg-zinc-900 text-white hover:bg-zinc-800" : "border-zinc-300 bg-white text-zinc-900 hover:border-zinc-900",
      )}
    >
      {ios ? <SquarePlus className="h-6 w-6 shrink-0" /> : <Download className="h-6 w-6 shrink-0" />}
      <span className="leading-tight">
        <span className={cn("block text-[10px] font-medium uppercase tracking-wide", dark ? "text-zinc-300" : "text-zinc-500")}>
          {ios ? "Add to home screen" : "Install the app"}
        </span>
        <span className="block text-[15px] font-semibold">{ios ? "iPhone & iPad" : "Android"}</span>
      </span>
    </button>
  );
}

export function InstallApp({ className, dark = true }: { className?: string; dark?: boolean }) {
  const [open, setOpen] = useState<Phone | null>(null);
  const [shown, setShown] = useState(false);
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    // Opened from the home screen already: nothing to install.
    const standalone = window.matchMedia?.("(display-mode: standalone)").matches
      || (navigator as Navigator & { standalone?: boolean }).standalone === true;
    setInstalled(Boolean(standalone));
    const onPrompt = (e: Event) => { e.preventDefault(); setPrompt(e as InstallPrompt); };
    const onInstalled = () => { setInstalled(true); setPrompt(null); };
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  // Slides up after it's drawn, and down before it goes.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => setShown(true));
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close() {
    setShown(false);
    setTimeout(() => setOpen(null), 250);
  }

  async function installNow() {
    if (!prompt) return;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice.catch(() => ({ outcome: "dismissed" as const }));
    setPrompt(null);
    if (outcome === "accepted") close();
  }

  if (installed) {
    return (
      <p className={cn("text-sm text-zinc-500", className)}>
        You&apos;re using PandaWorld from your home screen.
      </p>
    );
  }

  const sheet = open ? STEPS[open] : null;
  return (
    <>
      <div className={cn("flex flex-wrap gap-2.5", className)}>
        <Badge phone="ios" onClick={() => setOpen("ios")} dark={dark} />
        <Badge phone="android" onClick={() => setOpen("android")} dark={dark} />
      </div>

      {sheet && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-labelledby="install-title">
          <button
            type="button"
            aria-label="Close"
            onClick={close}
            className={cn("absolute inset-0 bg-black/40 transition-opacity duration-200", shown ? "opacity-100" : "opacity-0")}
          />
          <div
            className={cn(
              "relative w-full max-w-md rounded-t-3xl bg-white px-5 pb-[max(1.5rem,env(safe-area-inset-bottom))] pt-3 shadow-2xl transition-transform duration-300 ease-out sm:rounded-3xl sm:pb-6",
              shown ? "translate-y-0" : "translate-y-full sm:translate-y-8",
            )}
          >
            <div className="mx-auto h-1.5 w-10 rounded-full bg-zinc-200 sm:hidden" />
            <div className="mt-3 flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/icons/icon-192.png" alt="" className="h-11 w-11 rounded-xl border border-zinc-100" />
                <div>
                  <p id="install-title" className="font-semibold text-zinc-900">{sheet.title}</p>
                  <p className="text-sm text-zinc-500">{sheet.intro}</p>
                </div>
              </div>
              <button type="button" onClick={close} aria-label="Close" className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            {open === "android" && prompt && (
              <button
                type="button"
                onClick={() => void installNow()}
                className="mt-5 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-orange-500 text-sm font-semibold text-white transition-colors hover:bg-orange-600"
              >
                <Download className="h-4 w-4" /> Install now
              </button>
            )}

            <ol className="mt-5 space-y-3">
              {sheet.steps.map((s, i) => (
                <li key={i} className="flex items-start gap-3 text-sm text-zinc-700">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-orange-50 text-xs font-semibold text-orange-600">
                    {i + 1}
                  </span>
                  <span className="flex min-w-0 flex-1 items-start gap-2 pt-1">
                    <span className="mt-0.5 shrink-0 text-zinc-400">{s.icon}</span>
                    <span>{s.text}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-4 rounded-xl bg-zinc-50 px-3.5 py-2.5 text-xs leading-relaxed text-zinc-500">{sheet.note}</p>
            <button
              type="button"
              onClick={close}
              className="mt-4 h-11 w-full rounded-xl border border-zinc-200 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-50"
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </>
  );
}
