"use client";

import Image from "next/image";
import { CategoryDeck } from "@/components/ui/category-deck";

/** The deck, alone on the page: full screen on a phone, a card on a laptop. */
export function CategoryPicker({ initialCode, country }: { initialCode: number | null; country: string | null }) {
  return (
    <main className="flex h-[100dvh] flex-col bg-[#f5f4ed] sm:items-center sm:justify-center sm:p-6">
      <div className="flex h-full w-full flex-col overflow-hidden bg-white sm:h-[min(820px,calc(100dvh-3rem))] sm:max-w-[440px] sm:rounded-2xl sm:border sm:border-zinc-200 sm:shadow-xl">
        <div className="flex shrink-0 items-center gap-2 border-b bg-white px-4 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <Image src="/brand/panda-p-logo-trimmed.png" alt="PandaWorld" width={634} height={562} className="h-5 w-auto" />
          <span className="text-xs font-medium text-zinc-500">Jumia categories · find yours and copy it</span>
        </div>
        <CategoryDeck mode="copy" country={country} initialCode={initialCode} rejectedCode={initialCode} className="min-h-0 flex-1" />
      </div>
    </main>
  );
}
