import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { isAdmin } from "@/lib/auth/is-admin";
import { getQuotaSummary } from "@/lib/billing/quota";
import { isPaidPlan } from "@/lib/billing/plans";
import {
  getOrCreateCreditBalance,
  getRecentTransactions,
  getMostRecentCreditPack,
  getNotificationsSeenAt,
} from "@/lib/billing/extension-credits";
import { ExtensionShell } from "@/components/extension/shell";

// ─── Shared shell for the extension's own app pages ──────────────────────────
//
// Route group — (app) doesn't appear in the URL, so /extension/dashboard,
// /extension/calculator, /extension/listings and /extension/settings all
// keep their existing paths while sharing this sidebar + utility-bar shell.
//
// Deliberately OUTSIDE (main): (main)/layout.tsx redirects anyone without an
// ACTIVE Jumia OAuth connection to /onboarding/connect — but reaching
// sellers who don't want to do that OAuth dance is the whole point of the
// extension flow (docs/chrome-extension-plan.md). So auth here is just
// Clerk's session check, no Jumia-connection gate.

export default async function ExtensionAppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/extension/dashboard");

  const [quota, balance, notifications, recentPack, notificationsSeenAt] = await Promise.all([
    getQuotaSummary(userId),
    getOrCreateCreditBalance(userId),
    getRecentTransactions(userId),
    getMostRecentCreditPack(userId),
    getNotificationsSeenAt(userId),
  ]);

  // A real (paid) subscription tier always wins — it's the more meaningful
  // "current plan" than a one-time credit-pack purchase. Only extension-only
  // sellers who never subscribed (still on "free") get their most recent
  // credit pack shown instead, so buying credits actually moves this pill
  // off "Free" rather than leaving it stuck there forever.
  const planId = !isPaidPlan(quota.plan) && recentPack ? recentPack.id : quota.plan;
  const planLabel = planId.charAt(0).toUpperCase() + planId.slice(1);
  const creditsLabel = Number.isFinite(balance) ? String(balance) : "∞";

  return (
    <ExtensionShell
      planLabel={planLabel}
      creditsLabel={creditsLabel}
      notifications={notifications}
      notificationsSeenAt={notificationsSeenAt}
      isAdmin={isAdmin(userId)}
    >
      {children}
    </ExtensionShell>
  );
}
