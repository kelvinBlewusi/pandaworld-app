import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { Gauge, Wand2, Clock, Chrome, KeyRound, UploadCloud, ScanSearch } from "lucide-react";
import { getOrCreateExtensionApiKey, countRecentFills } from "@/lib/security/extension-keys";
import { getQuotaSummary } from "@/lib/billing/quota";
import { StatCard } from "@/components/ui/stat-card";
import { ApiKeyCard } from "@/components/extension/api-key-card";

// ─── /extension/dashboard — the Chrome extension's own control room ─────────
//
// Redesigned to sit inside the shared app/extension/(app) shell (sidebar +
// utility bar — see layout.tsx) instead of owning its own header. Content:
// a greeting, three stat cards (listings left, autofills, time saved), the
// fixed API-key card, and the setup guide.

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

  const [user, keyResult, quota, recentFills] = await Promise.all([
    currentUser(),
    getOrCreateExtensionApiKey(userId),
    getQuotaSummary(userId),
    countRecentFills(userId, 30),
  ]);

  const firstName = user?.firstName ?? user?.username ?? "there";
  const hasFiniteLimit = Number.isFinite(quota.listings.limit);
  const listingsLeft = hasFiniteLimit
    ? Math.max(0, quota.listings.limit - quota.listings.used)
    : null;

  return (
    <div className="mx-auto max-w-5xl">
      <div>
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-orange-600">
          <Chrome className="h-3.5 w-3.5" /> Chrome Extension
        </div>
        <h1 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">
          Welcome, {firstName} — your extension control room
        </h1>
        <p className="mt-2 max-w-xl text-sm text-zinc-600">
          Your API key, usage, and setup guide — everything the extension needs,
          separate from the web-app dashboard since this flow skips Jumia&apos;s
          OAuth entirely.
        </p>
      </div>

      {/* Stat cards */}
      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          title="Remaining credit"
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

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-[1.3fr_1fr]">
        <div>
          {"error" in keyResult ? (
            <div className="rounded-2xl border border-red-100 bg-red-50 p-6 text-sm text-red-600">
              {keyResult.error}
            </div>
          ) : (
            <ApiKeyCard initialKey={keyResult.fullKey} />
          )}
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
              body="Copy the key on the left, then paste it into the extension's Settings panel."
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
        </div>
      </div>
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
