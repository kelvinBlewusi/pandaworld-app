import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { createServerClient } from "@/lib/supabase/server";
import { encrypt } from "@/lib/security/token-crypto";

// ─── POST /api/jumia/save-credentials ─────────────────────────────────────────
// Saves per-user Jumia app credentials (credential-based auth, not OAuth).
// access_token is required NOT NULL in the table — we use a sentinel value
// "credential_auth" to indicate this row was created via app credentials,
// not the traditional OAuth flow. The real auth is app_id + app_secret.

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const { appId, secretKey, storeName, country } = await req.json();

  if (!appId || !secretKey) {
    return NextResponse.json({ error: "App ID and Secret Key are required." }, { status: 400 });
  }

  const db  = createServerClient();
  const now = new Date().toISOString();

  // Encrypt the app_secret at rest. Same OAuth-power as the access
  // token — a leak gives an attacker the ability to mint new tokens
  // for this seller indefinitely. See lib/security/token-crypto.ts.
  const encryptedSecret = encrypt(secretKey);

  // Try full upsert with new columns (requires add_onboarding.sql migration)
  const { error: fullError } = await db.from("jumia_connections").upsert(
    {
      user_id:      userId,
      access_token: "credential_auth",   // sentinel — real auth via app_id/app_secret
      app_id:       appId,
      app_secret:   encryptedSecret,
      store_name:   storeName || "Jumia Store",
      country:      country ?? "GH",
      status:       "active",
      connected_at: now,
      updated_at:   now,
    },
    { onConflict: "user_id" }
  );

  if (!fullError) return NextResponse.json({ ok: true });

  console.warn("[save-credentials] Full upsert failed, trying minimal:", fullError.code, fullError.message);

  // If the new columns don't exist yet (migration not run), fall back to a
  // minimal upsert that only touches columns guaranteed to exist.
  const isMissingColumn =
    fullError.code === "42703" || fullError.message?.includes("column");

  if (!isMissingColumn) {
    console.error("[save-credentials] Unexpected DB error:", fullError);
    return NextResponse.json(
      { error: "Failed to save credentials. Please try again." },
      { status: 500 }
    );
  }

  // (note: this minimal fallback skips app_secret because the
  // installation hasn't run the add_onboarding.sql migration yet.
  // It's a degraded path used only on fresh deploys; the seller will
  // need to re-save credentials after the migration runs.)
  const { error: minError } = await db.from("jumia_connections").upsert(
    {
      user_id:      userId,
      access_token: "credential_auth",
      store_name:   storeName || "Jumia Store",
      status:       "active",
      connected_at: now,
      updated_at:   now,
    },
    { onConflict: "user_id" }
  );

  if (minError) {
    console.error("[save-credentials] Minimal upsert also failed:", minError);
    return NextResponse.json(
      { error: "Failed to save credentials. Please try again." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, migrationPending: true });
}
