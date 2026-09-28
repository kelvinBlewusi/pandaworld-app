import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Coins, Sparkles } from "lucide-react";
import { isAdmin } from "@/lib/auth/is-admin";
import { isBillingEnabled } from "@/lib/billing/mode";
import { getOrCreateCreditBalance, getRecentTransactions } from "@/lib/billing/extension-credits";
import {
  CREDIT_PACKS,
  FREE_SIGNUP_CREDITS,
  IMAGE_CREDIT_COST,
  LISTING_CREDIT_COST,
  WHATSAPP_DRAFT_CREDIT_COST,
  packReach,
} from "@/lib/billing/credit-packs";
import { BuyCreditsButton } from "@/components/billing/buy-credits-button";

// ─── /settings/billing — credits ──────────────────────────────────────────────
//
// The seller's credit balance, what things cost and recent activity. The
// monthly plans this page used to sell were removed 2026-09-28; credits
// (lib/billing/credit-packs.ts) are the only billing, and only once an
// admin switches billing on (lib/billing/mode.ts).

export const dynamic = "force-dynamic";

const COSTS = [
  { label: "Chrome extension autofill",      credits: LISTING_CREDIT_COST },
  { label: "WhatsApp or web listing draft",   credits: WHATSAPP_DRAFT_CREDIT_COST },
  { label: "AI photo (polish, rebuild or generate), per photo", credits: IMAGE_CREDIT_COST },
];

export default async function BillingSettingsPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/settings/billing");

  const [billingOn, balance, activity] = await Promise.all([
    isBillingEnabled(),
    getOrCreateCreditBalance(userId),
    getRecentTransactions(userId, 20),
  ]);
  const admin = isAdmin(userId);
  const unlimited = !Number.isFinite(balance);

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-xl font-bold text-zinc-900">Credits &amp; billing</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Pay only for what you list. Credits never expire and work on WhatsApp, the Chrome extension and here.
        </p>
      </div>

      <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-orange-50 text-orange-500">
            {unlimited ? <Sparkles className="h-5 w-5" /> : <Coins className="h-5 w-5" />}
          </div>
          <div>
            <p className="text-sm text-zinc-500">Your balance</p>
            <p className="text-2xl font-bold text-zinc-900">
              {unlimited ? "Unlimited" : `${balance} credit${balance === 1 ? "" : "s"}`}
            </p>
            {unlimited && (
              <p className="text-xs text-zinc-500">
                {admin ? "Admin account: nothing is charged." : "PandaWorld is free for now: nothing is charged."}
              </p>
            )}
          </div>
        </div>
        {billingOn && !admin && <BuyCreditsButton />}
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="font-semibold text-zinc-900">What costs credits</h2>
        <ul className="mt-3 divide-y divide-zinc-100 text-sm">
          {COSTS.map((c) => (
            <li key={c.label} className="flex items-center justify-between gap-4 py-2.5">
              <span className="text-zinc-600">{c.label}</span>
              <span className="shrink-0 font-semibold text-zinc-900">{c.credits} credits</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-zinc-500">
          New accounts start with {FREE_SIGNUP_CREDITS} free credits. A draft is only charged when it succeeds.
        </p>
      </section>

      <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h2 className="font-semibold text-zinc-900">Credit packs</h2>
        <ul className="mt-3 divide-y divide-zinc-100 text-sm">
          {CREDIT_PACKS.map((p) => {
            const { autofills, drafts } = packReach(p.credits);
            return (
              <li key={p.id} className="flex items-center justify-between gap-4 py-2.5">
                <span>
                  <span className="font-semibold text-zinc-900">{p.credits} credits</span>
                  <span className="block text-xs text-zinc-500">
                    About {autofills} autofills or {drafts} WhatsApp listings
                  </span>
                </span>
                <span className="shrink-0 font-semibold text-zinc-900">GHS {p.amountGhs}</span>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-zinc-500">Pay with Mobile Money or card through Paystack.</p>
      </section>

      {activity.length > 0 && (
        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <h2 className="font-semibold text-zinc-900">Recent activity</h2>
          <ul className="mt-3 divide-y divide-zinc-100 text-sm">
            {activity.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-4 py-2.5">
                <span>
                  <span className="text-zinc-700">{t.description ?? t.type}</span>
                  <span className="block text-xs text-zinc-400">
                    {new Date(t.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                  </span>
                </span>
                <span className={t.amount > 0 ? "shrink-0 font-semibold text-emerald-600" : "shrink-0 font-semibold text-zinc-600"}>
                  {t.amount > 0 ? "+" : ""}{t.amount}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
