import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { PublicLanding } from "@/components/marketing/public-landing";

// ─── Root route ──────────────────────────────────────────────────────────────
//
// Logged-out visitors see the marketing landing (PublicLanding —
// shared with /landing). Authenticated users are auto-redirected
// straight to the extension dashboard — the extension is the default
// product experience now (see docs/chrome-extension-plan.md); the
// classic Jumia-OAuth flow is reached only via the explicit "Push
// Listings from here" button on that dashboard (→ /dashboard, whose
// own (main)/layout.tsx gate handles onboarding for a new seller or
// takes an already-connected one straight to their listings).
//
// This used to check jumia_connections and route into /onboarding/channel
// for anyone without a connection — that made the classic OAuth flow the
// accidental default for EVERY sign-up/sign-in, including ones that never
// intended to touch Jumia's OAuth at all. Removed; that check now only
// happens on the explicit opt-in path.
//
// If a logged-in user actually WANTS to see the landing — e.g. to
// share the URL, or read the new pricing — they can navigate to
// /landing directly. The sidebar has a "Landing page" link that
// takes them there, bypassing this redirect.
//
// Kept as a Server Component so the auth check + redirect run on the
// edge and visitors hit the landing with no client-side JS until they
// interact.

export default async function Home() {
  const { userId } = await auth();

  if (userId) {
    redirect("/extension/dashboard");
  }

  return <PublicLanding />;
}
