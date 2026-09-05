import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { getQuotaSummary } from "@/lib/billing/quota";
import { getOrCreateCreditBalance, getRecentTransactions } from "@/lib/billing/extension-credits";
import { ExtensionShell } from "@/components/extension/shell";

// ─── Shared shell for the extension's own app pages ──────────────────────────
//
// Route group — (app) doesn't appear in the URL, so /extension/dashboard,
// /extension/calculator, /extension/listings and /extension/settings all
// keep their existing paths while sharing this sidebar + utility-bar shell.
//
// Deliberately OUTSIDE (main): (main)/layout.tsx redirects anyone without an
// ACTIVE Jumia OAuth connection to /onboarding/channel — but reaching
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

  const [quota, balance, notifications] = await Promise.all([
    getQuotaSummary(userId),
    getOrCreateCreditBalance(userId),
    getRecentTransactions(userId),
  ]);
  const planLabel = quota.plan.charAt(0).toUpperCase() + quota.plan.slice(1);
  const creditsLabel = Number.isFinite(balance) ? String(balance) : "∞";

  return (
    <ExtensionShell planLabel={planLabel} creditsLabel={creditsLabel} notifications={notifications}>
      {children}
    </ExtensionShell>
  );
}
