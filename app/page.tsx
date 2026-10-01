import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { ExtensionPage, metadata as extensionMetadata } from "@/app/extension/page";

// ─── Root route ──────────────────────────────────────────────────────────────
//
// Logged-out visitors see the SAME page as /extension (the extension is the
// default product experience now — see docs/chrome-extension-plan.md), not
// the older PublicLanding marketing page. Renders the /extension route's
// own component directly (named export from app/extension/page.tsx) so the
// two stay identical by construction rather than as two copies of the same
// markup that could drift. PublicLanding is still used by /landing and
// /push-listings — this only changes the root path.
//
// Authenticated users are auto-redirected straight to the extension
// dashboard. The classic Jumia-OAuth flow is reached only via the explicit
// "Push Listings from here" button on that dashboard (→ /dashboard, whose
// own (main)/layout.tsx gate handles onboarding for a new seller or takes
// an already-connected one straight to their listings).
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
//
// Metadata: app/extension/page.tsx's own, since the two render the same
// content and its canonical already points here. Taken from it rather than
// copied: the copy drifted (the homepage kept pitching only the Chrome
// extension after /extension added WhatsApp). The title is absolute
// because the layout's "%s · PandaWorld" template doesn't apply to a page
// in the layout's own segment, so the homepage title carried no brand.
export const metadata: Metadata = {
  ...extensionMetadata,
  title: { absolute: "PandaWorld: AI Jumia Listings for Chrome and WhatsApp" },
};

export default async function Home() {
  const { userId } = await auth();

  if (userId) {
    redirect("/extension/dashboard");
  }

  return <ExtensionPage />;
}
