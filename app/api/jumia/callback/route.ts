import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { exchangeCodeForTokens, fetchJumiaSellerProfile } from "@/lib/jumia/oauth";
import { encrypt, decrypt } from "@/lib/security/token-crypto";
import { clearJumiaHealthCache } from "@/lib/jumia/api";
import { getWhatsAppConnection } from "@/lib/whatsapp/link";
import { sendTextIfConfigured } from "@/lib/whatsapp/client";
import { updateSession } from "@/lib/whatsapp/session";
import { sanitizeReturnTo } from "@/lib/jumia/return-to";

// ─── GET /api/jumia/callback ──────────────────────────────────────────────────
// Jumia redirects here after the user authorises PandaWorld.
// Query params: ?code=<one-time-code>&state=<base64-encoded-state>
//
// Flow:
//  1. Decode `state` to recover Clerk userId (set in /connect)
//  2. Look up the seller's app_id + app_secret from Supabase
//  3. Exchange the code for access + refresh tokens using their credentials
//  4. Fetch the seller's profile from Jumia API
//  5. Upsert the connection row in Supabase
//  6. Redirect to /onboarding/done (from onboarding) or /settings/integrations

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const code     = searchParams.get("code");
  const stateRaw = searchParams.get("state");
  const error    = searchParams.get("error");

  const origin  = req.nextUrl.origin;
  // Reassigned as soon as state decodes with a returnTo (see
  // lib/jumia/return-to.ts) — a connect started from /extension/settings
  // should send failures back there too, not always to the old dashboard's
  // Settings → Integrations. State is now decoded before ANY failure path,
  // so every one of them honours it.
  let failUrl = `${origin}/settings/integrations?jumia_error=`;

  // ── Decode state FIRST ────────────────────────────────────────────────────
  //
  // Before the error branch, not after it, and that ordering is the fix for
  // a real bug: an error from Jumia used to redirect to the DEFAULT failUrl
  // (/settings/integrations) because returnTo had not been read yet. That
  // page lives in the (main) route group, whose layout bounces anyone
  // without an active Jumia connection to /onboarding/connect — so a seller
  // who started from WhatsApp and hit any OAuth error was thrown into the
  // exact web onboarding the chat flow exists to spare them.
  //
  // OAuth servers echo `state` on error responses too, so there is normally
  // something to decode. Best-effort: a missing or corrupt state is not
  // itself worth failing over when we already have a more specific error to
  // report.
  let userId: string | undefined;
  let storeName: string = "";
  let returnTo: string | undefined;
  if (stateRaw) {
    try {
      const decoded = JSON.parse(Buffer.from(stateRaw, "base64url").toString("utf-8"));
      userId    = typeof decoded.userId === "string" ? decoded.userId : undefined;
      storeName = decoded.storeName ?? "";
      returnTo  = sanitizeReturnTo(decoded.returnTo);
      if (returnTo) failUrl = `${origin}${returnTo}?jumia_error=`;
    } catch (e) {
      console.error("[Jumia OAuth] Invalid state param:", e);
    }
  }

  // ── An error came back from Jumia ─────────────────────────────────────────
  if (error) {
    // The whole OAuth error triple, not just `error`. The description is
    // the part that says WHY, and dropping it is what made "auth request
    // not found" undiagnosable.
    const description = searchParams.get("error_description") ?? "";
    console.warn(
      `[Jumia OAuth] error from Jumia for user=${userId ?? "unknown"}: ` +
      `${error}${description ? ` — ${description}` : ""}`,
    );

    // Is the seller ALREADY connected?
    //
    // Reported on 2026-09-15: connecting from the WhatsApp link showed
    // "auth request not found" while the connection itself worked fine.
    // Jumia's authorize request is single-use, so loading that URL a second
    // time — a reload, a back-navigation, or WhatsApp's in-app browser
    // handing the link to Safari after already opening it — answers exactly
    // that. The first load had already completed the connection.
    //
    // So a stale authorize request is not a failure worth alarming anyone
    // about. If the connection is live, say it is. Only a seller who is
    // genuinely NOT connected sees an error.
    if (userId) {
      const dbCheck = createServerClient();
      const { data: existing } = await dbCheck
        .from("jumia_connections")
        .select("status, access_token, store_name")
        .eq("user_id", userId)
        .maybeSingle();

      const alreadyConnected =
        existing?.status === "active" &&
        typeof existing.access_token === "string" &&
        existing.access_token.length > 0 &&
        existing.access_token !== "credential_auth";

      if (alreadyConnected) {
        console.info(`[Jumia OAuth] stale authorize request for user=${userId} — already connected, treating as success`);
        const store = (existing.store_name as string | null) ?? storeName ?? "Jumia Store";
        return NextResponse.redirect(
          `${origin}/onboarding/done?store=${encodeURIComponent(store)}` +
          (returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : ""),
        );
      }
    }

    // Jumia's own wording, translated. "auth request not found" means
    // nothing to a seller, and pasting it into the URL taught them nothing
    // they could act on.
    const readable =
      /auth request not found|invalid[_ ]request/i.test(`${error} ${description}`)
        ? "That Jumia sign-in link had already been used — ask the bot for a fresh one, or tap Connect again."
        : /access[_ ]denied/i.test(error)
          ? "You cancelled the Jumia sign-in. Tap Connect again when you're ready."
          : description || error;

    return NextResponse.redirect(`${failUrl}${encodeURIComponent(readable)}`);
  }

  if (!code || !stateRaw) {
    return NextResponse.redirect(
      `${failUrl}${encodeURIComponent("Missing code or state parameter")}`
    );
  }

  if (!userId) {
    return NextResponse.redirect(
      `${failUrl}${encodeURIComponent("Invalid state parameter — please try again")}`
    );
  }

  // ── Look up seller's app credentials ─────────────────────────────────────
  const db = createServerClient();
  const { data: conn, error: dbLookupError } = await db
    .from("jumia_connections")
    .select("app_id, app_secret, store_name")
    .eq("user_id", userId)
    .maybeSingle();

  if (dbLookupError || !conn?.app_id || !conn?.app_secret) {
    console.error("[Jumia OAuth] Could not load seller credentials:", dbLookupError);
    return NextResponse.redirect(
      `${failUrl}${encodeURIComponent("Seller credentials not found — please reconnect")}`
    );
  }

  // ── Build redirect URI (must match what was sent in /connect) ─────────────
  const redirectUri = `${origin}/api/jumia/callback`;

  // ── Exchange code for tokens using the seller's own app credentials ────────
  let tokens: { access_token: string; refresh_token?: string; expires_in: number };
  try {
    tokens = await exchangeCodeForTokens(
      code,
      conn.app_id,
      // Decrypt — credentials saved via /save-credentials are now stored
      // encrypted; pre-encryption rows still pass through unchanged.
      decrypt(conn.app_secret as string),
      redirectUri,
    );
  } catch (e) {
    const detail = (e as Error).message ?? "";
    console.error("[Jumia OAuth] Token exchange failed:", e);

    // Same stale-request case as the error branch above, arriving by the
    // other door: a second load of the authorize URL produces a second
    // callback carrying a code Jumia has already consumed, and the exchange
    // fails. If the first callback already connected this seller, the
    // connection is fine and there is nothing to report.
    const { data: existing } = await db
      .from("jumia_connections")
      .select("status, access_token, store_name")
      .eq("user_id", userId)
      .maybeSingle();

    if (
      existing?.status === "active" &&
      typeof existing.access_token === "string" &&
      existing.access_token.length > 0 &&
      existing.access_token !== "credential_auth"
    ) {
      console.info(`[Jumia OAuth] exchange failed for user=${userId} but the connection is already active — treating as success`);
      const store = (existing.store_name as string | null) ?? storeName ?? "Jumia Store";
      return NextResponse.redirect(
        `${origin}/onboarding/done?store=${encodeURIComponent(store)}` +
        (returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : ""),
      );
    }

    // Only NOW is "check your credentials" fair. Sending a seller to
    // re-enter credentials that are perfectly correct is worse than saying
    // nothing — it is a wrong instruction that costs them real time.
    const readable = /auth request not found|invalid[_ ]grant|expired/i.test(detail)
      ? "That Jumia sign-in had already been used or expired — ask the bot for a fresh link, or tap Connect again."
      : "Couldn't finish connecting to Jumia — check your app credentials and try again.";

    return NextResponse.redirect(`${failUrl}${encodeURIComponent(readable)}`);
  }

  // ── Fetch seller profile (best-effort) ────────────────────────────────────
  const profile = await fetchJumiaSellerProfile(tokens.access_token);

  // ── Compute token expiry time ─────────────────────────────────────────────
  const tokenExpiresAt = tokens.expires_in
    ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
    : null;

  // ── Upsert connection — real access_token replaces credential_auth sentinel
  const resolvedStoreName =
    profile.store_name ?? conn.store_name ?? storeName ?? "Jumia Store";

  const { error: dbError } = await db.from("jumia_connections").upsert(
    {
      user_id:          userId,
      // Encrypted at rest — see lib/security/token-crypto.ts. A
      // breach of jumia_connections no longer hands an attacker the
      // seller's vendor-center access. Encryption is idempotent so
      // re-running this code path is safe.
      access_token:     encrypt(tokens.access_token),
      refresh_token:    tokens.refresh_token ? encrypt(tokens.refresh_token) : null,
      token_expires_at: tokenExpiresAt,
      seller_id:        profile.seller_id,
      seller_name:      profile.seller_name,
      seller_email:     profile.seller_email,
      store_name:       resolvedStoreName,
      shop_id:          profile.shop_id,
      status:           "active",
      updated_at:       new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  if (dbError) {
    console.error("[Jumia OAuth] DB upsert failed:", dbError);
    return NextResponse.redirect(
      `${failUrl}${encodeURIComponent("Database error — please try again")}`
    );
  }

  // Bust the layout's health cache so the seller's NEXT navigation
  // hits Jumia for a fresh probe (otherwise they could see the
  // dashboard layout loop them back to onboarding for up to 60s after
  // a successful reconnect, because the cache still says "broken").
  clearJumiaHealthCache(userId);

  console.info(
    `[Jumia OAuth] Connected seller=${profile.seller_name ?? "unknown"} for user=${userId}`
  );

  // NOTE: category sync used to fire here as a fire-and-forget background
  // task. That's been replaced by the admin-controlled batched sync at
  // /admin/categories. Categories are pre-seeded from the bundled JSON
  // snapshot, so by the time this seller reaches the listing flow the
  // picker is already populated. Per-category attribute schemas still
  // load on demand via /api/jumia/categories/[code]/attributes.

  // If this seller was waiting on Jumia to connect from the WhatsApp
  // connect-from-chat flow (lib/whatsapp/intake.ts's awaiting_jumia_oauth
  // state — tapped the one-time link after pasting app credentials — or
  // awaiting_jumia_credentials, meaning they never came back to chat at
  // all and instead finished connecting entirely on the website), unblock
  // the listing flow and tell them here, not just on whatever browser
  // happened to complete this redirect. Gated on those two exact states
  // so an unrelated re-authorise (e.g. a needs_reconnect fix from the web
  // Settings page while mid-batch) never resets a seller's in-progress
  // batch. Best-effort — never let a WhatsApp hiccup break the OAuth flow
  // itself.
  try {
    const wa = await getWhatsAppConnection(userId);
    if (wa.connected && wa.phoneNumber) {
      const { data: session } = await db
        .from("whatsapp_sessions")
        .select("state")
        .eq("phone_number", wa.phoneNumber)
        .maybeSingle();
      if (session?.state === "awaiting_jumia_oauth" || session?.state === "awaiting_jumia_credentials") {
        await updateSession(wa.phoneNumber, {
          state: "awaiting_count", listingId: null, batchId: null, batchSize: null, batchSeq: null, pendingAppId: null,
        });
        await sendTextIfConfigured(
          wa.phoneNumber,
          `🎉 Jumia connected${resolvedStoreName ? ` — ${resolvedStoreName}` : ""}! How many products are you listing today? Reply with a number to get started.`,
        );
      }
    }
  } catch (e) {
    console.warn(`[Jumia OAuth] WhatsApp notify failed for user=${userId}: ${(e as Error).message}`);
  }

  // Redirect to done page (onboarding flow) with store name — carrying
  // returnTo along so the page's own "Continue" button knows to send an
  // /extension/settings-originated connect back there instead of the old
  // web dashboard.
  const successUrl =
    `${origin}/onboarding/done?store=${encodeURIComponent(resolvedStoreName)}` +
    (returnTo ? `&return_to=${encodeURIComponent(returnTo)}` : "");
  return NextResponse.redirect(successUrl);
}
