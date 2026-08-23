import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, currentUser } from "@clerk/nextjs/server";
import { UserButton } from "@clerk/nextjs";
import {
  ArrowLeft,
  Chrome,
  Wand2,
  Gauge,
  Clock,
  UploadCloud,
  ScanSearch,
  CheckCircle,
  KeyRound,
  AlertCircle,
  CreditCard,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/ui/stat-card";
import { Wordmark } from "@/components/marketing/wordmark";
import { cn } from "@/lib/utils";
import { listExtensionApiKeys, countRecentFills } from "@/lib/security/extension-keys";
import { getQuotaSummary } from "@/lib/billing/quota";
import { ExtensionKeysPanel } from "./keys-panel";

// ─── /extension/dashboard — the Chrome extension's own control room ─────────
//
// Deliberately OUTSIDE the (main) route group. (main)/layout.tsx redirects
// any user without an ACTIVE Jumia OAuth connection to /onboarding/channel
// — but reaching sellers who don't want to do that OAuth dance is the whole
// point of the extension (see docs/chrome-extension-plan.md). So this page
// gets its own minimal shell: real Clerk auth (redirect to /sign-in if
// logged out), but no Jumia-connection gate.
//
// Visual language deliberately mirrors app/(main)/dashboard/page.tsx (the
// "{greeting}, {firstName}" header, the gradient StatCard component, a
// colored connection-status strip modeled on that page's Jumia-health bar)
// so it reads as the same product family, not a bolted-on side surface —
// with the header button cluster + API-key card shaped by patterns from
// competitor extension dashboards (plan/credit pills, a prominent install
// CTA, an inline "how to use your key" + do-not-share warning).
//
// Not in middleware's public-route list, so the default Clerk
// auth.protect() gate already covers it — the explicit check below is
// just a defensive belt-and-braces (also gives us `userId` for the data
// fetches without re-deriving it).

export const metadata: import("next").Metadata = {
  title: "Extension Dashboard",
  robots: { index: false }, // logged-in tool, not a marketing surface
};

/** Conservative estimate — a manual Jumia listing typically runs 15–30 min;
 *  reviewing an autofilled one runs a couple of minutes. Labelled "Est." in
 *  the UI so it's never presented as a measured number. */
function estimateTimeSaved(autofillCount: number): string {
  const minutes = autofillCount * 13; // ~15min manual - ~2min review, rounded down for safety
  if (minutes <= 0) return "0m";
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export default async function ExtensionDashboardPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/extension/dashboard");

  const [user, keys, quota, recentFills] = await Promise.all([
    currentUser(),
    listExtensionApiKeys(userId),
    getQuotaSummary(userId),
    countRecentFills(userId, 30),
  ]);

  const firstName = user?.firstName ?? user?.username ?? "there";
  const hasActiveKey = keys.some((k) => !k.revokedAt);
  const hasFiniteLimit = Number.isFinite(quota.listings.limit);
  const listingsLeft = hasFiniteLimit
    ? Math.max(0, quota.listings.limit - quota.listings.used)
    : null;
  const planLabel = quota.plan.charAt(0).toUpperCase() + quota.plan.slice(1);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900">
      {/* Its own lightweight header — not the full app Sidebar (see note
          above on why this page sits outside (main)). Distinct enough to
          read as its own space, while staying visually consistent
          (Wordmark, orange accent, same type scale) with the rest of the app. */}
      <header className="border-b border-zinc-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-4">
            <Link href="/dashboard" aria-label="pandaworld home">
              <Wordmark size={24} />
            </Link>
            <span className="hidden h-5 w-px bg-zinc-200 sm:block" />
            <span className="hidden items-center gap-1.5 text-sm font-semibold text-zinc-500 sm:flex">
              <Chrome className="h-4 w-4" /> Extension
            </span>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href="/dashboard"
              className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium text-zinc-600 hover:bg-zinc-100"
            >
              <ArrowLeft className="h-4 w-4" /> Main dashboard
            </Link>
            <UserButton appearance={{ elements: { avatarBox: "h-7 w-7" } }} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        {/* Page header — greeting on the left (matches the main dashboard's
            "{greeting}, {firstName}" pattern); a Plan/Listings-left pill
            pair + Upgrade + Install Extension on the right (the extension-
            specific action cluster). */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-orange-600">
              <Chrome className="h-3.5 w-3.5" /> Chrome Extension
            </div>
            <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
              Welcome, {firstName} — your extension control room
            </h1>
            <p className="mt-2 max-w-xl text-sm text-zinc-600">
              Generate the key that connects the extension, see how it&apos;s
              being used, and get set up on Jumia — separate from the web-app
              dashboard, since this flow skips Jumia&apos;s OAuth entirely.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 sm:justify-end">
            <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs font-semibold text-zinc-700">
              Plan: {planLabel}
            </span>
            <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-semibold text-orange-700">
              {listingsLeft == null ? "Unlimited listings" : `${listingsLeft} listings left`}
            </span>
            <Button asChild variant="outline" size="sm" className="gap-1.5">
              <Link href="/settings/billing">
                <CreditCard className="h-3.5 w-3.5" /> Upgrade
              </Link>
            </Button>
            {/* No public Chrome Web Store listing yet — this jumps straight
                to the install steps below rather than an external link. */}
            <Button asChild size="sm" className="gap-1.5">
              <a href="#setup-guide">
                <Chrome className="h-3.5 w-3.5" /> Install Extension
              </a>
            </Button>
          </div>
        </div>

        {/* Stat cards — reuses the same gradient StatCard as the main
            dashboard so this reads as the same product, not a bolt-on. */}
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard
            title="Listings left"
            value={listingsLeft == null ? "∞" : listingsLeft}
            subtitle={hasFiniteLimit ? `${quota.listings.used} of ${quota.listings.limit} used this period` : "Unlimited on your plan"}
            icon={<Gauge className="h-5 w-5" />}
            gradient="green"
          />
          <StatCard
            title="Autofills"
            value={recentFills}
            subtitle="Last 30 days"
            icon={<Wand2 className="h-5 w-5" />}
            gradient="orange"
          />
          <StatCard
            title="Time saved (est.)"
            value={estimateTimeSaved(recentFills)}
            subtitle="Last 30 days"
            icon={<Clock className="h-5 w-5" />}
            gradient="lavender"
          />
        </div>

        {/* Connection status strip — modeled directly on the main
            dashboard's Jumia-connection health bar (colored border/bg by
            state, icon chip, title + status line, action on the right). */}
        <div
          className={cn(
            "mt-6 flex items-center justify-between rounded-2xl border px-5 py-4",
            hasActiveKey ? "border-emerald-100 bg-emerald-50" : "border-amber-100 bg-amber-50",
          )}
        >
          <div className="flex items-center gap-3">
            <div className={cn("flex h-8 w-8 items-center justify-center rounded-lg", hasActiveKey ? "bg-emerald-100" : "bg-amber-100")}>
              <KeyRound className={cn("h-4 w-4", hasActiveKey ? "text-emerald-600" : "text-amber-600")} />
            </div>
            <div>
              <p className="text-sm font-semibold text-zinc-800">Extension connection</p>
              <p className={cn("text-xs", hasActiveKey ? "text-emerald-600" : "text-amber-600")}>
                {hasActiveKey
                  ? `Connected — ${keys.filter((k) => !k.revokedAt).length} active key${keys.filter((k) => !k.revokedAt).length === 1 ? "" : "s"}`
                  : "Not connected — generate a key below and paste it into the extension"}
              </p>
            </div>
          </div>
          {hasActiveKey ? (
            <CheckCircle className="h-4 w-4 text-emerald-500" />
          ) : (
            <Button asChild size="sm" variant="outline" className="gap-1.5 text-xs">
              <a href="#api-keys">
                <AlertCircle className="h-3 w-3" /> Generate key
              </a>
            </Button>
          )}
        </div>

        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1.3fr_1fr]">
          <div id="api-keys">
            <ExtensionKeysPanel initialKeys={keys} />
          </div>

          {/* Setup guide */}
          <div id="setup-guide" className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-bold text-zinc-900">Get set up</h2>
            <ol className="mt-4 space-y-4">
              <GuideStep
                Icon={Chrome}
                title="Install the extension"
                body="Add PandaWorld to Chrome. It opens as a side panel next to Jumia Vendor Center."
              />
              <GuideStep
                Icon={KeyRound}
                title="Paste your API key"
                body="Generate a key on the left, then paste it into the extension's Settings panel."
              />
              <GuideStep
                Icon={UploadCloud}
                title="Add a photo & pick a category"
                body="Do your listing on Jumia as usual — upload the product photo and choose a category to open the form."
              />
              <GuideStep
                Icon={ScanSearch}
                title="Click Autofill, review, submit"
                body="The AI fills the form. You check it and press Submit — always you."
              />
            </ol>
            <Link
              href="/extension"
              className="mt-5 inline-block text-sm font-semibold text-orange-600 hover:underline"
            >
              Read the full walkthrough →
            </Link>
          </div>
        </div>
      </main>
    </div>
  );
}

// ─── Small presentational helpers ────────────────────────────────────────────

function GuideStep({
  Icon,
  title,
  body,
}: {
  Icon: React.ElementType;
  title: string;
  body: string;
}) {
  return (
    <li className="flex gap-3">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-orange-50 text-orange-600">
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <p className="text-sm font-semibold text-zinc-900">{title}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-zinc-600">{body}</p>
      </div>
    </li>
  );
}
