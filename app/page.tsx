import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";

export default async function Home() {
  const { userId } = await auth();

  if (!userId) {
    redirect("/sign-in");
  }

  // Check if this user has started onboarding (any row in jumia_connections)
  const db = createServerClient();
  const { data } = await db
    .from("jumia_connections")
    .select("user_id")
    .eq("user_id", userId)
    .maybeSingle();

  if (!data) {
    // New user — send them through onboarding
    redirect("/onboarding/channel");
  }

  redirect("/dashboard");
}
