import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { UserButton } from "@clerk/nextjs";
import {
  ArrowLeft,
  Chrome,
  Wand2,
  Gauge,
  UploadCloud,
  ScanSearch,
  CheckCircle2,
  XCircle,
  KeyRound,
} from "lucide-react";
import { Wordmark } from "@/components/marketing/wordmark";
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
// Not in middleware's public-route list, so the default Clerk
// auth.protect() gate already covers it — the explicit check below is
// just a defensive belt-and-braces (also gives us `userId` for the data
// fetches without re-deriving it).

export const metadata: import("next").Metadata = {
  title: "Extension Dashboard",
  robots: { index: false }, // logged-in tool, not a marketing surface
};

export default async function ExtensionDashboardPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/extension/dashboard");

  const [keys, quota, recentFills] = await Promise.all([
    listExtensionApiKeys(userId),
    getQuotaSummary(userId),
    countRecentFills(userId, 30),
  ]);

  const hasActiveKey = keys.some((k) => !k.revokedAt);
  const listingsLeft = Number.isFinite(quota.listings.limit)
    ? Math.max(0, quota.listings.limit - quota.listings.used)
    : null;

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
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-orange-600">
          <Chrome className="h-3.5 w-3.5" /> Chrome Extension
        </div>
        <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
          Your extension control room
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-zinc-600">
          Generate the key that connects the extension to your account, see how
          it&apos;s being used, and get set up on Jumia — all separate from the
          web-app dashboard, since this flow works without connecting Jumia&apos;s
          OAuth at all.
        </p>

        {/* Status strip */}
        <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard
            label="Connection"
            value={hasActiveKey ? "Connected" : "Not connected"}
            tone={hasActiveKey ? "good" : "warn"}
            Icon={hasActiveKey ? CheckCircle2 : XCircle}
          />
          <StatCard
            label="Autofills (30 days)"
            value={String(recentFills)}
            tone="neutral"
            Icon={Wand2}
          />
          <StatCard
            label="Listings left this period"
            value={listingsLeft == null ? "Unlimited" : String(listingsLeft)}
            sub={`${quota.plan.charAt(0).toUpperCase()}${quota.plan.slice(1)} plan — shared with the web app`}
            tone="neutral"
            Icon={Gauge}
          />
        </div>

        <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-[1.3fr_1fr]">
          <ExtensionKeysPanel initialKeys={keys} />

          {/* Setup guide */}
          <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
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

function StatCard({
  label,
  value,
  sub,
  tone,
  Icon,
}: {
  label: string;
  value: string;
  sub?: string;
  tone: "good" | "warn" | "neutral";
  Icon: React.ElementType;
}) {
  const toneClasses = {
    good:    "bg-emerald-50 text-emerald-600",
    warn:    "bg-amber-50 text-amber-600",
    neutral: "bg-orange-50 text-orange-600",
  }[tone];
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
      <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${toneClasses}`}>
        <Icon className="h-4.5 w-4.5" />
      </div>
      <p className="mt-3 text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-0.5 text-xl font-bold text-zinc-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-zinc-400">{sub}</p>}
    </div>
  );
}

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

