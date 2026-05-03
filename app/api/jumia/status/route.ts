import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import type { JumiaConnectionPublic } from "@/lib/types/jumia";

// ─── GET /api/jumia/status ────────────────────────────────────────────────────
// Returns the current user's Jumia connection status.
// Never exposes tokens to the client.

export async function GET() {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  const db = createServerClient();
  const { data, error } = await db
    .from("jumia_connections")
    .select(
      "status, seller_name, seller_email, store_name, seller_id, connected_at, token_expires_at"
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    console.error("[Jumia] Status fetch error:", error);
    return NextResponse.json({ connected: false, status: null } as JumiaConnectionPublic);
  }

  if (!data) {
    return NextResponse.json({
      connected:        false,
      status:           null,
      seller_name:      null,
      seller_email:     null,
      store_name:       null,
      seller_id:        null,
      connected_at:     null,
      token_expires_at: null,
    } satisfies JumiaConnectionPublic);
  }

  return NextResponse.json({
    connected:        data.status === "active",
    status:           data.status,
    seller_name:      data.seller_name,
    seller_email:     data.seller_email,
    store_name:       data.store_name,
    seller_id:        data.seller_id,
    connected_at:     data.connected_at,
    token_expires_at: data.token_expires_at,
  } satisfies JumiaConnectionPublic);
}
