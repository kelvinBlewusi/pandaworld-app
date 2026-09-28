import { createServerClient } from "@/lib/supabase/server";
import { billingSwitchInfo } from "@/lib/billing/mode";
import { billingReadiness, readyToBill, type CheckStatus } from "@/lib/billing/readiness";
import {
  FREE_SEARCH_QUERIES_PER_MONTH,
  liveListingsSince,
  searchOverageUsd,
  summarizeCosts,
  unitCosts,
  usageSince,
  type FeatureCost,
} from "@/lib/billing/costs";
import {
  CREDIT_PACKS,
  FREE_SIGNUP_CREDITS,
  LISTING_CREDIT_COST,
  LIVE_LISTING_CREDIT_COST,
} from "@/lib/billing/credit-packs";
import { setBillingAction, topUpAction } from "./actions";

export const dynamic = "force-dynamic";

// ─── /admin/billing — the billing switch ──────────────────────────────────────
//
// One button between "free for everyone" and "charge credits"
// (lib/billing/mode.ts), the checks that must pass before it can be turned
// on (lib/billing/readiness.ts), and what the AI work has actually cost
// against what it earns in credits (lib/billing/costs.ts).

/** Used only to compare USD costs with GHS prices on this page. */
const GHS_PER_USD = Number(process.env.GHS_PER_USD) || 12;

const FEATURE_LABEL: Record<string, string> = {
  extension_fill:  "Extension autofill",
  listing_draft:   "WhatsApp / web draft",
  category_refill: "Category change refill",
  other:           "Other AI calls (fixes, notes)",
};

const STATUS_STYLE: Record<CheckStatus, string> = {
  ok:   "bg-emerald-50 text-emerald-700",
  warn: "bg-amber-50 text-amber-700",
  fail: "bg-red-50 text-red-700",
};

const NOTICES: Record<string, string> = {
  on:        "Billing is on. Sellers now spend credits.",
  off:       "Billing is off. Everything is free again; balances are untouched.",
  topup:     "Top-up done.",
  confirm:   "Tick the confirmation box to switch billing on.",
  not_ready: "Billing can't be switched on until the failing checks below pass.",
};

async function balances(): Promise<{ sellers: number; outstanding: number; belowFree: number; purchases: number; purchasedCredits: number }> {
  const db = createServerClient();
  const [{ data: rows }, { data: purchases }] = await Promise.all([
    db.from("extension_credits").select("balance"),
    db.from("extension_credit_transactions").select("amount").eq("type", "purchase"),
  ]);
  const list = (rows ?? []) as { balance: number | string }[];
  return {
    sellers:          list.length,
    outstanding:      list.reduce((sum, r) => sum + Number(r.balance), 0),
    belowFree:        list.filter((r) => Number(r.balance) < FREE_SIGNUP_CREDITS).length,
    purchases:        (purchases ?? []).length,
    purchasedCredits: ((purchases ?? []) as { amount: number | string }[]).reduce((sum, r) => sum + Number(r.amount), 0),
  };
}

function usd(n: number): string {
  return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

/** What `credits` earn in USD, from the cheapest to the dearest pack per credit. */
function earnRange(credits: number): string {
  const perCredit = CREDIT_PACKS.map((p) => p.amountGhs / p.credits);
  const low = (credits * Math.min(...perCredit)) / GHS_PER_USD;
  const high = (credits * Math.max(...perCredit)) / GHS_PER_USD;
  return low === high ? usd(low) : `${usd(low)}–${usd(high)}`;
}

export default async function AdminBillingPage({ searchParams }: { searchParams: { done?: string; error?: string; count?: string } }) {
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [info, checks, usage, ledger, liveCount] = await Promise.all([
    billingSwitchInfo(),
    billingReadiness(),
    usageSince(since30).catch(() => null),
    balances(),
    liveListingsSince(since30).catch(() => 0),
  ]);
  const ready = readyToBill(checks);

  const costs: FeatureCost[] = usage ? summarizeCosts(usage) : [];
  const units = unitCosts(costs, liveCount);

  const notice = searchParams.done
    ? searchParams.done === "topup"
      ? `Topped up ${searchParams.count ?? 0} seller${searchParams.count === "1" ? "" : "s"} to ${FREE_SIGNUP_CREDITS} credits.`
      : NOTICES[searchParams.done]
    : searchParams.error
      ? NOTICES[searchParams.error]
      : null;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-lg font-bold">Billing</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          Off: everyone lists for free and no credits move. On: WhatsApp and web listings cost credits when they go
          live on Jumia, extension autofills cost credits each, sellers can buy packs, and the site shows pricing.
          Flipping it takes effect within 30 seconds.
        </p>
      </div>

      {notice && (
        <p className={`rounded-lg px-4 py-3 text-sm ${searchParams.error ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"}`}>
          {notice}
        </p>
      )}

      {/* The switch */}
      <section className="rounded-lg border border-zinc-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm text-zinc-500">Billing is</p>
            <p className={`text-2xl font-bold ${info.on ? "text-emerald-600" : "text-zinc-900"}`}>{info.on ? "ON" : "OFF — free for everyone"}</p>
            {info.updatedAt && (
              <p className="mt-1 text-xs text-zinc-400">
                Last changed {new Date(info.updatedAt).toLocaleString("en-GB")}{info.updatedBy ? ` by ${info.updatedBy}` : ""}
              </p>
            )}
          </div>
          <form action={setBillingAction} className="flex flex-col items-end gap-2">
            <input type="hidden" name="billing" value={info.on ? "off" : "on"} />
            {!info.on && (
              <label className="flex items-center gap-2 text-sm text-zinc-600">
                <input type="checkbox" name="confirm" value="yes" required />
                Start charging sellers credits
              </label>
            )}
            <button
              type="submit"
              disabled={!info.on && !ready}
              className={`rounded-lg px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40 ${info.on ? "bg-zinc-800 hover:bg-zinc-900" : "bg-emerald-600 hover:bg-emerald-700"}`}
            >
              {info.on ? "Switch billing off" : "Switch billing on"}
            </button>
          </form>
        </div>
      </section>

      {/* Readiness */}
      <section className="rounded-lg border border-zinc-200 bg-white p-6">
        <h2 className="font-semibold">Before switching on</h2>
        <ul className="mt-4 space-y-3">
          {checks.map((c) => (
            <li key={c.id} className="flex items-start gap-3 text-sm">
              <span className={`mt-0.5 shrink-0 rounded px-2 py-0.5 text-xs font-semibold uppercase ${STATUS_STYLE[c.status]}`}>{c.status}</span>
              <span>
                <span className="font-medium">{c.label}.</span> <span className="text-zinc-600">{c.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      {/* Prices */}
      <section className="rounded-lg border border-zinc-200 bg-white p-6">
        <h2 className="font-semibold">Prices</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Set in lib/billing/credit-packs.ts. {FREE_SIGNUP_CREDITS} free credits on sign-up. A WhatsApp / web listing
          costs {LIVE_LISTING_CREDIT_COST} when it goes live; an extension autofill {LISTING_CREDIT_COST}.
        </p>
        <table className="mt-4 w-full text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-zinc-500">
            <tr>
              <th className="py-2 font-medium">Pack</th>
              <th className="py-2 font-medium">Price</th>
              <th className="py-2 font-medium">Per credit</th>
              <th className="py-2 font-medium">Per live listing</th>
              <th className="py-2 font-medium">Per autofill</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100">
            {CREDIT_PACKS.map((p) => {
              const perCredit = p.amountGhs / p.credits;
              return (
                <tr key={p.id}>
                  <td className="py-2">{p.id} · {p.credits} credits</td>
                  <td className="py-2">GHS {p.amountGhs}</td>
                  <td className="py-2">GHS {perCredit.toFixed(3)}</td>
                  <td className="py-2">GHS {(perCredit * LIVE_LISTING_CREDIT_COST).toFixed(2)}</td>
                  <td className="py-2">GHS {(perCredit * LISTING_CREDIT_COST).toFixed(2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {/* Measured cost */}
      <section className="rounded-lg border border-zinc-200 bg-white p-6">
        <h2 className="font-semibold">What the AI actually costs (last 30 days)</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Token costs from every logged Gemini call (ai_usage). Only live listings earn, so every draft, redraft and
          fix is paid for by the listings that went live. Earnings use the packs above, at GHS {GHS_PER_USD} = $1
          (set GHS_PER_USD to change).
        </p>
        {usage === null ? (
          <p className="mt-4 text-sm text-red-600">Couldn&apos;t read ai_usage.</p>
        ) : (
          <>
            <table className="mt-4 w-full text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-zinc-500">
                <tr>
                  <th className="py-2 font-medium">Seller pays for</th>
                  <th className="py-2 font-medium">How many</th>
                  <th className="py-2 font-medium">AI cost each</th>
                  <th className="py-2 font-medium">Earns each</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100">
                <tr>
                  <td className="py-2">Live WhatsApp / web listing</td>
                  <td className="py-2">{units.listings.live} live from {units.listings.drafts} drafts</td>
                  <td className="py-2">{units.listings.usdPerLive !== null ? usd(units.listings.usdPerLive) : "—"}</td>
                  <td className="py-2">{earnRange(LIVE_LISTING_CREDIT_COST)}</td>
                </tr>
                <tr>
                  <td className="py-2">Extension autofill</td>
                  <td className="py-2">{units.autofills.count}</td>
                  <td className="py-2">{units.autofills.usdEach !== null ? usd(units.autofills.usdEach) : "—"}</td>
                  <td className="py-2">{earnRange(LISTING_CREDIT_COST)}</td>
                </tr>
              </tbody>
            </table>

            {costs.length > 0 && (
              <table className="mt-6 w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-zinc-500">
                  <tr>
                    <th className="py-2 font-medium">AI work</th>
                    <th className="py-2 font-medium">Runs</th>
                    <th className="py-2 font-medium">Calls</th>
                    <th className="py-2 font-medium">Cost per run</th>
                    <th className="py-2 font-medium">Total cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {costs.map((c) => (
                    <tr key={c.feature}>
                      <td className="py-2">{FEATURE_LABEL[c.feature] ?? c.feature}</td>
                      <td className="py-2">{c.runs}</td>
                      <td className="py-2">{c.calls}</td>
                      <td className="py-2">{c.usdPerRun !== null ? usd(c.usdPerRun) : "—"}</td>
                      <td className="py-2">{usd(c.tokenUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
        {usage && <SearchLine costs={costs} />}
      </section>

      {/* Balances */}
      <section className="rounded-lg border border-zinc-200 bg-white p-6">
        <h2 className="font-semibold">Credit balances</h2>
        <p className="mt-2 text-sm text-zinc-600">
          {ledger.sellers} seller{ledger.sellers === 1 ? "" : "s"} with a balance, {ledger.outstanding} credits outstanding.{" "}
          {ledger.purchases} purchase{ledger.purchases === 1 ? "" : "s"} so far ({ledger.purchasedCredits} credits). Sellers
          without a balance yet get {FREE_SIGNUP_CREDITS} free credits the first time they use one.
        </p>
        {ledger.belowFree > 0 && (
          <form action={topUpAction} className="mt-4 flex flex-wrap items-center gap-3">
            <p className="text-sm text-zinc-600">
              {ledger.belowFree} seller{ledger.belowFree === 1 ? " has" : "s have"} fewer than {FREE_SIGNUP_CREDITS} credits
              (from the old 10-credit welcome).
            </p>
            <button type="submit" className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-50">
              Top them up to {FREE_SIGNUP_CREDITS}
            </button>
          </form>
        )}
      </section>
    </div>
  );
}

/** Search grounding: free up to the monthly allowance, then billed per query. */
function SearchLine({ costs }: { costs: FeatureCost[] }) {
  const queries = costs.reduce((sum, c) => sum + c.searchQueries, 0);
  const overage = searchOverageUsd(queries);
  return (
    <p className="mt-4 text-sm text-zinc-500">
      Google Search grounding: {queries} quer{queries === 1 ? "y" : "ies"} in the last 30 days, against{" "}
      {FREE_SEARCH_QUERIES_PER_MONTH.toLocaleString()} free a month.
      {overage > 0 ? ` Past the allowance, that's about ${usd(overage)} on top.` : " Within the free allowance."}
    </p>
  );
}
