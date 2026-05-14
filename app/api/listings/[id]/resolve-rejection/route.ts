import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { resolveRejection } from "@/lib/actions/ai";

// ─── POST /api/listings/[id]/resolve-rejection ────────────────────────────────
//
// Single-shot AI repair pass for a rejected listing.
//
// Flow:
//   1. Load the listing, verify it's actually in a failed state with a
//      Jumia rejection reason recorded.
//   2. Hand the rejection + current listing fields to the AI; ask for
//      targeted updates (NOT a full rewrite).
//   3. Apply the updates to the listings row (column + dynamic_attributes
//      patches both supported).
//   4. Reset status to 'draft' so the seller can review the AI's changes
//      and re-push manually.
//
// We deliberately do NOT auto-push after the AI suggests fixes. The seller
// inspects the diff and decides whether to retry — preserves trust, and
// prevents quota blowouts on cases where the AI repeatedly mis-fixes.
//
// Response: {
//   updates:   Record<string, unknown>,
//   summary:   string,
//   reasoning: string,
// }

interface ListingForResolve {
  id:                  string;
  user_id:             string;
  status:              string | null;
  jumia_error:         string | null;
  title:               string | null;
  description:         string | null;
  highlights:          string | null;
  brand:               string | null;
  color:               string | null;
  color_family:        string | null;
  weight_kg:           number | null;
  main_material:       string | null;
  material_family:     string | null;
  production_country:  string | null;
  selling_price:       number | null;
  category_path:       string | null;
  warranty_text:       string | null;
  warranty_address:    string | null;
  dynamic_attributes:  Record<string, string> | null;
  images:              string[] | null;
  field_sources:       Record<string, "ai" | "user"> | null;
}

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const db = createServerClient();

  // ── 1. Load listing ──────────────────────────────────────────────────────
  const { data, error } = await db
    .from("listings")
    .select(
      "id, user_id, status, jumia_error, " +
      "title, description, highlights, brand, color, color_family, " +
      "weight_kg, main_material, material_family, production_country, " +
      "selling_price, category_path, warranty_text, warranty_address, " +
      "dynamic_attributes, images, field_sources",
    )
    .eq("id", params.id)
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }
  const listing = data as unknown as ListingForResolve;

  // ── 2. Verify there's actually a rejection to fix ────────────────────────
  if (!listing.jumia_error) {
    return NextResponse.json(
      { error: "Listing has no recorded rejection reason" },
      { status: 400 }
    );
  }

  // Parse jumia_error if it's stringified JSON; otherwise treat as plain text.
  let rejectionReason = listing.jumia_error;
  try {
    const parsed = JSON.parse(listing.jumia_error);
    rejectionReason =
      typeof parsed === "string"
        ? parsed
        : (parsed?.message as string) ??
          (parsed?.errorMessage as string) ??
          JSON.stringify(parsed);
  } catch {
    // Plain string, keep as-is.
  }

  // ── 3. Call the AI resolver ──────────────────────────────────────────────
  let resolution;
  try {
    resolution = await resolveRejection(
      {
        title:              listing.title,
        description:        listing.description,
        highlights:         listing.highlights,
        brand:              listing.brand,
        color:              listing.color,
        color_family:       listing.color_family,
        weight_kg:          listing.weight_kg,
        main_material:      listing.main_material,
        material_family:    listing.material_family,
        production_country: listing.production_country,
        selling_price:      listing.selling_price,
        category_path:      listing.category_path,
        warranty_text:      listing.warranty_text,
        warranty_address:   listing.warranty_address,
        dynamic_attributes: listing.dynamic_attributes,
        images:             listing.images,
      },
      rejectionReason,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : "AI resolution failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }

  // ── 4. Split updates: top-level columns vs dynamic_attributes ────────────
  const columnUpdate:      Record<string, unknown> = {};
  const dynamicMergedKeys: Record<string, string>  = {};

  for (const [k, v] of Object.entries(resolution.updates)) {
    if (k.startsWith("dynamic_attributes.")) {
      const dynKey = k.slice("dynamic_attributes.".length);
      if (typeof v === "string") dynamicMergedKeys[dynKey] = v;
    } else {
      columnUpdate[k] = v;
    }
  }

  const mergedDynamic = {
    ...(listing.dynamic_attributes ?? {}),
    ...dynamicMergedKeys,
  };

  // Field sources — mark every changed field as user-confirmed-AI so the
  // confidence dots in the UI reflect that the seller saw these changes.
  const newSources = { ...(listing.field_sources ?? {}) };
  for (const k of Object.keys(resolution.updates)) {
    newSources[k] = "ai";
  }

  // ── 5. Apply update + reset status ───────────────────────────────────────
  const patch: Record<string, unknown> = {
    ...columnUpdate,
    status:             "draft",  // ready for the seller to re-push
    field_sources:      newSources,
    updated_at:         new Date().toISOString(),
  };
  if (Object.keys(dynamicMergedKeys).length > 0) {
    patch.dynamic_attributes = mergedDynamic;
  }

  const { error: updateErr } = await db
    .from("listings")
    .update(patch)
    .eq("id", listing.id)
    .eq("user_id", userId);

  if (updateErr) {
    return NextResponse.json(
      { error: `Failed to apply AI changes: ${updateErr.message}` },
      { status: 500 }
    );
  }

  // ── 6. Return resolution so UI can show the diff ─────────────────────────
  return NextResponse.json({
    updates:   resolution.updates,
    summary:   resolution.summary,
    reasoning: resolution.reasoning,
  });
}
