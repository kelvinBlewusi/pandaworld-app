import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ count: 0 });

  const db = createServerClient();
  const { count } = await db
    .from("listings")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  return NextResponse.json({ count: count ?? 0 });
}
