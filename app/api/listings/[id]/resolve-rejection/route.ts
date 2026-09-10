import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { resolveRejection } from "@/lib/actions/ai";
import { getCategoryAttributes } from "@/lib/jumia/categories";

// ─── POST /api/listings/[id]/resolve-rejection ────────────────────────────────
//
// Single-shot AI repair pass.
//
// Two trigger modes:
//   (a) Body { mode: "jumia_rejection" } — default. Reads listing.jumia_error
//       as the "rejection reason". Resets status to 'draft' on success so
//       the seller can re-push.
//   (b) Body { mode: "quality_score", reason: "..." } — used for the
//       Quality Score gate below the Submit button. The seller is gated
//       from pushing because qualityResult.score < threshold; this lets
//       them ask the AI to address the listed issues.
//
// Flow (both modes):
//   1. Load the listing, validate the trigger condition.
//   2. Hand the reason + current fields to resolveRejection() in lib/actions/ai.
//   3. Apply the AI's targeted updates (column + dynamic_attributes both).
//   4. (jumia_rejection only) reset status to 'draft'.
//
// We never auto-push. The seller verifies the AI's changes and re-submits.
//
// Response: { updates, summary, reasoning, mode }

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
  category_code:       string | null;
  warranty_text:       string | null;
  warranty_address:    string | null;
  dynamic_attributes:  Record<string, string> | null;
  images:              string[] | null;
  field_sources:       Record<string, "ai" | "user"> | null;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  // Parse trigger mode + optional caller-provided reason. Default mode is
  // jumia_rejection so the rejected-listing case in review-client.tsx's
  // AiAssistCard continues to work without sending a body.
  let mode: "jumia_rejection" | "quality_score" = "jumia_rejection";
  let callerReason: string | null = null;
  try {
    const body = await req.json();
    if (body?.mode === "quality_score") mode = "quality_score";
    if (typeof body?.reason === "string" && body.reason.trim()) {
      callerReason = body.reason.trim().slice(0, 2000);
    }
  } catch { /* no body — fine, defaults apply */ }

  const db = createServerClient();

  // ── 1. Load listing ──────────────────────────────────────────────────────
  const { data, error } = await db
    .from("listings")
    .select(
      "id, user_id, status, jumia_error, " +
      "title, description, highlights, brand, color, color_family, " +
      "weight_kg, main_material, material_family, production_country, " +
      "selling_price, category_path, category_code, warranty_text, warranty_address, " +
      "dynamic_attributes, images, field_sources",
    )
    .eq("id", params.id)
    .eq("user_id", userId)
    .maybeSingle();

  if (error || !data) {
    return NextResponse.json({ error: "Listing not found" }, { status: 404 });
  }
  const listing = data as unknown as ListingForResolve;

  // ── 2. Derive the reason text the AI should fix ──────────────────────────
  let rejectionReason: string;
  if (mode === "quality_score") {
    if (!callerReason) {
      return NextResponse.json(
        { error: "Quality-score mode requires a 'reason' in the body" },
        { status: 400 }
      );
    }
    rejectionReason = callerReason;
  } else {
    if (!listing.jumia_error) {
      return NextResponse.json(
        { error: "Listing has no recorded rejection reason" },
        { status: 400 }
      );
    }
    // Parse jumia_error: it's a JSON-stringified Jumia error object most of
    // the time, but plain text is also possible.
    rejectionReason = listing.jumia_error;
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
        category_code:      listing.category_code ? Number(listing.category_code) : null,
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

  // Belt-and-braces: server-side scrub numeric attributes before saving.
  // The AI is told (in the resolveRejection prompt) about the schema's
  // numeric types, but a stubborn model might still return "true" or
  // "yes" for a number field. Walk the schema and either canonicalise
  // or drop any non-numeric value pretending to be numeric.
  if (listing.category_code) {
    try {
      const schema = await getCategoryAttributes(Number(listing.category_code));
      const numericNames = new Set(
        schema.filter((a) => a.type === "number").map((a) => a.name.toLowerCase()),
      );
      for (const key of Object.keys(dynamicMergedKeys)) {
        if (!numericNames.has(key.toLowerCase())) continue;
        const raw   = String(dynamicMergedKeys[key]);
        const match = raw.match(/-?\d+(?:\.\d+)?/);
        if (match) {
          const n = parseFloat(match[0]);
          if (Number.isFinite(n)) {
            dynamicMergedKeys[key] = String(n);
            continue;
          }
        }
        console.warn(
          `[resolve-rejection] dropping non-numeric value for numeric attr '${key}': '${raw.slice(0, 40)}'`,
        );
        delete dynamicMergedKeys[key];
      }
    } catch (e) {
      console.warn(`[resolve-rejection] schema fetch for scrub failed: ${(e as Error).message}`);
    }
  }

  // Same scrub for top-level weight_kg (it's a number column too).
  if (columnUpdate.weight_kg != null) {
    const raw   = String(columnUpdate.weight_kg);
    const match = raw.match(/-?\d+(?:\.\d+)?/);
    if (match) {
      const n = parseFloat(match[0]);
      columnUpdate.weight_kg = Number.isFinite(n) && n > 0 && n < 1000 ? n : null;
    } else {
      columnUpdate.weight_kg = null;
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

  // ── 5. Apply update + (jumia_rejection only) reset status ────────────────
  const patch: Record<string, unknown> = {
    ...columnUpdate,
    field_sources: newSources,
    updated_at:    new Date().toISOString(),
  };
  // Jumia-rejection mode resets to draft so the seller can re-push. Quality-
  // score mode keeps the existing status (already draft anyway) — the AI
  // just shores up fields before the seller hits Submit.
  if (mode === "jumia_rejection") {
    patch.status = "draft";
  }
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
    mode,
  });
}
