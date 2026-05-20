import { NextRequest, NextResponse } from "next/server";
import { Webhook } from "svix";
import * as Sentry from "@sentry/nextjs";
import { sendEmail } from "@/lib/email/send";
import { welcomeEmail } from "@/lib/email/templates";

// ─── POST /api/webhooks/clerk ────────────────────────────────────────────────
//
// Receives signed webhook events from Clerk — currently we only care
// about user.created so we can fire the welcome email. Future events
// (user.deleted, user.updated for email-change) can be added here.
//
// Required setup in Clerk dashboard:
//   Webhooks → Add Endpoint
//   URL:    https://<your-domain>/api/webhooks/clerk
//   Events: user.created
//   Copy the Signing Secret into Vercel env var:
//     CLERK_WEBHOOK_SECRET = whsec_…
//
// Without the secret, every request returns 500 — fail-secure. Don't
// silently accept unsigned webhooks the way the old cron route did.

export async function POST(req: NextRequest) {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[clerk-webhook] CLERK_WEBHOOK_SECRET is not set — refusing to process.");
    return new NextResponse("Webhook not configured", { status: 500 });
  }

  const svixId        = req.headers.get("svix-id")        ?? "";
  const svixTimestamp = req.headers.get("svix-timestamp") ?? "";
  const svixSignature = req.headers.get("svix-signature") ?? "";

  if (!svixId || !svixTimestamp || !svixSignature) {
    return new NextResponse("Missing svix headers", { status: 401 });
  }

  // Read raw body — svix verifies against the unparsed bytes.
  const body = await req.text();

  let event: ClerkWebhookEvent;
  try {
    const wh = new Webhook(secret);
    event = wh.verify(body, {
      "svix-id":        svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ClerkWebhookEvent;
  } catch (e) {
    console.warn(`[clerk-webhook] signature verification failed: ${(e as Error).message}`);
    return new NextResponse("Invalid signature", { status: 401 });
  }

  // ── Dispatch on event type ─────────────────────────────────────────────────
  try {
    if (event.type === "user.created") {
      await handleUserCreated(event.data);
    }
    // Other event types we might handle later (out of scope for now):
    //   - user.deleted: belt + braces — our /api/account/delete already
    //     deletes from Clerk, but if a Clerk dashboard admin deletes
    //     a user directly we'd want to clean up our DB rows here.
    //   - user.updated: rotate cached email/name if a seller changes it.
  } catch (e) {
    // Log and capture, but return 200 so Clerk doesn't retry forever
    // for what's likely an issue on our side (email service down etc).
    // The seller still has an account; they just don't get the email.
    Sentry.captureException(e, { tags: { surface: "clerk-webhook", event: event.type } });
    console.error(`[clerk-webhook] handler for ${event.type} failed: ${(e as Error).message}`);
  }

  return NextResponse.json({ received: true });
}

// ─── user.created handler ────────────────────────────────────────────────────

async function handleUserCreated(user: ClerkUserData): Promise<void> {
  const email = user.email_addresses?.[0]?.email_address;
  if (!email) {
    console.warn(`[clerk-webhook] user.created without email: ${user.id}`);
    return;
  }

  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL ??
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://pandaworld.gh");

  const tpl = welcomeEmail({ firstName: user.first_name, appUrl });

  await sendEmail({
    to:       email,
    subject:  tpl.subject,
    html:     tpl.html,
    text:     tpl.text,
    category: "welcome",
  });
}

// ─── Minimal types for the bits of the Clerk webhook payload we use ──────────

interface ClerkUserData {
  id: string;
  first_name: string | null;
  last_name:  string | null;
  email_addresses: Array<{ email_address: string }>;
}

interface ClerkWebhookEvent {
  type: "user.created" | "user.updated" | "user.deleted" | string;
  data: ClerkUserData;
}
