import { NextRequest, NextResponse } from "next/server";
import { Webhook } from "svix";
import * as Sentry from "@sentry/nextjs";
import { sendEmail } from "@/lib/email/send";
import { welcomeEmail } from "@/lib/email/templates";
import { getOrCreateCreditBalance } from "@/lib/billing/extension-credits";
import { purgeUserData } from "@/lib/account/purge";

// ─── POST /api/webhooks/clerk ────────────────────────────────────────────────
//
// Receives signed webhook events from Clerk.
//
//   user.created — fire the welcome email, pre-warm the credit ledger
//   user.deleted — erase the seller's data from Supabase
//
// user.deleted is NOT optional, and treating it as such caused a real
// incident. Clerk is the only place a user exists — this project has no
// users table, every row is keyed by a Clerk user_id string, and there are
// no foreign keys. So deleting a user in the Clerk dashboard removed the
// identity and left every row behind. Confirmed on 2026-09-15: an account
// was deleted in Clerk and the WhatsApp bot kept serving that number
// normally, because whatsapp_connections — the phone → account link the bot
// resolves through — was still there, along with the seller's listings,
// their Jumia tokens, and their extension API key.
//
// Required setup in Clerk dashboard:
//   Webhooks → Add Endpoint
//   URL:    https://<your-domain>/api/webhooks/clerk
//   Events: user.created, user.deleted        ← both
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
    } else if (event.type === "user.deleted") {
      await handleUserDeleted(event.data);
    }
    // Still unhandled:
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
  // Pre-warm the extension credit ledger with the free sign-up credits
  // (FREE_SIGNUP_CREDITS in lib/billing/credit-packs.ts).
  // Not strictly required here — getOrCreateCreditBalance() also grants
  // them lazily the first time the dashboard or a fill request touches a
  // new user — but doing it on signup means the balance is already there
  // the moment they first look, rather than "created on first read".
  getOrCreateCreditBalance(user.id).catch((e) =>
    console.warn(`[clerk-webhook] extension credit grant failed for ${user.id}: ${(e as Error).message}`),
  );

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

// ─── user.deleted handler ────────────────────────────────────────────────────

async function handleUserDeleted(user: ClerkUserData): Promise<void> {
  if (!user.id) {
    console.warn("[clerk-webhook] user.deleted with no id — nothing to purge");
    return;
  }

  const { deleted, errors } = await purgeUserData(user.id);

  // Reported to Sentry rather than thrown: the account is gone from Clerk
  // either way, and throwing would make Clerk retry the whole delivery
  // while the rows that DID delete stay deleted. What matters is that a
  // survivor is visible to us, because a leftover credential is the part
  // that has security weight.
  if (errors.length > 0) {
    Sentry.captureMessage(`Partial purge for deleted user ${user.id}`, {
      level: "error",
      tags:  { surface: "clerk-webhook", event: "user.deleted" },
      extra: { deleted, errors },
    });
  }
}

// ─── Minimal types for the bits of the Clerk webhook payload we use ──────────

interface ClerkUserData {
  // Optional on purpose: a user.deleted payload is far thinner than
  // user.created, and only carries an id and a deleted flag.
  id: string;
  first_name?: string | null;
  last_name?:  string | null;
  email_addresses?: Array<{ email_address: string }>;
}

interface ClerkWebhookEvent {
  type: "user.created" | "user.updated" | "user.deleted" | string;
  data: ClerkUserData;
}
