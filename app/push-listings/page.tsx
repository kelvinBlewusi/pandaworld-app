import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase/server";
import { PublicLanding } from "@/components/marketing/public-landing";

// ─── /push-listings — intro page behind the extension dashboard's ────────────
// "Push Listings from here" button.
//
// Deliberately OUTSIDE the (main) route group, same reason as
// /extension/dashboard: (main)/layout.tsx's gate would otherwise redirect a
// seller with no Jumia connection away before this page ever rendered — but
// the whole point is to show them this intro FIRST, and only enter the
// classic Jumia-OAuth flow when they deliberately click "Get Started".
//
// EXCEPT for a seller who's already connected — showing them the "why
// connect Jumia" pitch every time they click this button is pointless
// friction, so they skip straight to /dashboard. Only a logged-in seller
// with no active Jumia connection sees the intro at all.
//
// Reuses PublicLanding's content (variant="push-listings" strips Pricing +
// Sign-in from the nav and points every CTA at /dashboard) so editing the
// shared marketing copy keeps both surfaces in sync — see that component
// for the full explanation.

export const metadata: import("next").Metadata = {
  title: "Push Listings the Classic Way",
  robots: { index: false }, // only ever linked from the logged-in extension dashboard
};

export default async function PushListingsPage() {
  const { userId } = await auth();

  if (userId) {
    // Same "connected" definition as GET /api/jumia/status — active status
    // and past the credential-only (pre-OAuth) stage.
    const db = createServerClient();
    const { data } = await db
      .from("jumia_connections")
      .select("status, access_token")
      .eq("user_id", userId)
      .maybeSingle();

    const connected = data?.status === "active" && data.access_token !== "credential_auth";
    if (connected) redirect("/dashboard");
  }

  return <PublicLanding isAuthenticated={!!userId} variant="push-listings" />;
}
