import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";

const JUMIA_TOKEN_URL = "https://auth-external.jumia.com/connect/token";

// ─── POST /api/jumia/test-credentials ─────────────────────────────────────────
// Verifies an App ID + Secret Key against Jumia's token endpoint.
// Uses client_credentials grant — if Jumia returns invalid_client we know the
// creds are wrong; if it returns unsupported_grant_type the creds are valid
// (Jumia doesn't support client_credentials but the error confirms the app exists).

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });

  const { appId, secretKey } = await req.json();

  if (!appId || !secretKey) {
    return NextResponse.json({ ok: false, error: "App ID and Secret Key are required." }, { status: 400 });
  }

  try {
    const body = new URLSearchParams({
      grant_type:    "client_credentials",
      client_id:     appId,
      client_secret: secretKey,
    });

    const res = await fetch(JUMIA_TOKEN_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    body.toString(),
    });

    const data = await res.json().catch(() => ({}));

    if (res.ok && data.access_token) {
      return NextResponse.json({ ok: true, message: "Credentials verified successfully." });
    }

    const errorCode = data.error ?? "";

    // "unsupported_grant_type" means the app credentials ARE valid —
    // Jumia just doesn't allow client_credentials without a prior auth code flow.
    if (errorCode === "unsupported_grant_type") {
      return NextResponse.json({ ok: true, message: "Credentials look valid. Proceed to connect." });
    }

    // "invalid_client" means the App ID or Secret Key is wrong.
    if (errorCode === "invalid_client" || res.status === 401) {
      return NextResponse.json(
        { ok: false, error: "Invalid App ID or Secret Key. Double-check your Vendor Center credentials." },
        { status: 400 }
      );
    }

    // Any other error
    return NextResponse.json(
      { ok: false, error: `Jumia returned: ${errorCode || res.status}. Check your credentials.` },
      { status: 400 }
    );
  } catch (e) {
    console.error("[test-credentials]", e);
    return NextResponse.json({ ok: false, error: "Could not reach Jumia servers. Try again." }, { status: 502 });
  }
}
