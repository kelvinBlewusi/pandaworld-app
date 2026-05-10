import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import type { ListingStatus } from "@/lib/supabase/types";

const ALLOWED_STATUSES: ListingStatus[] = [
  "draft",
  "awaiting_review",
  "processing",
  "pending_approval",
  "live",
  "failed",
];

// ─── PATCH /api/listings/[id] ─────────────────────────────────────────────────
// Partial update — currently supports { status } only.

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const { id } = params;
  const body = await req.json().catch(() => ({}));

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if (body.status !== undefined) {
    if (!ALLOWED_STATUSES.includes(body.status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    }
    updates.status = body.status;
  }

  const db = createServerClient();
  const { error } = await db
    .from("listings")
    .update(updates)
    .eq("id", id)
    .eq("user_id", userId); // ensure user owns the listing

  if (error) {
    console.error("[PATCH listing]", error);
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
