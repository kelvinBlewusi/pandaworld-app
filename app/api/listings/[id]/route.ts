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
// Partial update — supports { status?, images? }.
//
// images: string[] of Supabase Storage public URLs. Used by the
// EnhanceModal to apply the seller's accept/reject picks. We validate
// that every URL came out of our own bucket (no arbitrary external URLs)
// so a malicious client can't smuggle a foreign URL into listings.images.

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

  if (body.images !== undefined) {
    if (
      !Array.isArray(body.images) ||
      body.images.some((u: unknown) => typeof u !== "string" || u.length === 0)
    ) {
      return NextResponse.json(
        { error: "images must be a non-empty array of URL strings" },
        { status: 400 },
      );
    }
    // Whitelist Supabase Storage URLs from this project's bucket so the
    // EnhanceModal can't be tricked into pointing listings.images at an
    // external host. We also accept the storage-API URL shape that
    // Supabase emits for both public and signed URLs.
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
    const allowedPrefix = supabaseUrl
      ? `${supabaseUrl.replace(/\/$/, "")}/storage/v1/`
      : "";
    if (allowedPrefix) {
      const bad = (body.images as string[]).find((u) => !u.startsWith(allowedPrefix));
      if (bad) {
        return NextResponse.json(
          { error: `images URLs must be in this project's Supabase Storage (found ${bad.slice(0, 60)}…)` },
          { status: 400 },
        );
      }
    }
    updates.images = body.images as string[];
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
