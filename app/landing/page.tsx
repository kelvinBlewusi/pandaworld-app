import { auth } from "@clerk/nextjs/server";
import { PublicLanding } from "@/components/marketing/public-landing";

// ─── /landing — public landing for logged-in sellers ─────────────────────────
//
// The root path (/) auto-redirects authenticated users to the extension
// dashboard (the default product experience — see
// docs/chrome-extension-plan.md), so they never see the marketing copy
// after sign-up. That redirect is intentional (faster default UX), but
// some sellers want to revisit the landing — to read the pricing
// comparison, share the URL with a friend, or just refresh their memory
// on the value prop.
//
// This route always renders the same PublicLanding component, no
// redirect, regardless of auth state. The component receives the auth
// flag so its nav can swap "Sign in / Get started" for a single
// "Dashboard" button when the viewer is signed in.
//
// Sidebar (components/layout/Sidebar.tsx) has a "Landing page" link
// pointing here so logged-in sellers can find it without typing the
// URL.

export const metadata: import("next").Metadata = {
  title:       "AI Listing Assistant for Jumia Africa Sellers",
  description: "Generate complete Jumia listings from product photos in seconds. AI-picked categories, attributes filled, white-background images, push straight to Vendor Center. Works across Ghana, Nigeria, Kenya, Egypt, Morocco, and more. Free for 5 listings every month.",
  alternates: {
    canonical: "/landing",
  },
};

export default async function LandingPage() {
  const { userId } = await auth();
  return <PublicLanding isAuthenticated={!!userId} />;
}
