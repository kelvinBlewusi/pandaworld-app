import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { PublicLanding } from "@/components/marketing/public-landing";

// ─── Root route ──────────────────────────────────────────────────────────────
//
// Logged-out visitors see the marketing landing (PublicLanding —
// shared with /landing). Authenticated users are auto-redirected to
// their dashboard so they don't have to click through the marketing
// site every time they open the app.
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
    const db = createServerClient();
    const { data } = await db
      .from("jumia_connections")
      .select("user_id")
      .eq("user_id", userId)
      .maybeSingle();

    if (!data) redirect("/onboarding/channel");
    redirect("/dashboard");
  }

  return <PublicLanding />;
}
