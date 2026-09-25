import { NextRequest, NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { isAdmin } from "@/lib/auth/is-admin";
import { sendEmail } from "@/lib/email/send";
import { whatsappExtensionAnnouncementEmail } from "@/lib/email/templates";

// ─── /api/admin/broadcast/whatsapp-extension-announcement ────────────────────
//
// One-off admin-triggered broadcast of the "Two faster ways to list on
// Jumia" email (lib/email/templates.ts) to every Clerk sign-up with an
// email address — not just active users, per direct request.
//
// There is no `users` table in this project (see app/api/webhooks/clerk/
// route.ts) — Clerk is the only source of the real sign-up list, so this
// pulls it live via clerkClient().users.getUserList() rather than
// querying Supabase.
//
// GET  — dry run. Counts recipients, returns a small sample, sends nothing.
//        Use this first to sanity-check the list before the real send.
// POST — real send. Requires { "confirm": true } in the JSON body as a
//        deliberate extra step so a bare POST (e.g. from a tool that
//        auto-retries) can't trigger a real send by accident.
//
// This is intentionally a one-off script, not a reusable "campaigns"
// feature — there's no send-tracking table, so re-running POST re-sends
// to everyone. Don't run it twice.
export const maxDuration = 60;

interface Recipient {
  id:        string;
  email:     string;
  firstName: string | null;
}

async function collectRecipients(): Promise<Recipient[]> {
  const client = await clerkClient();
  const recipients: Recipient[] = [];
  const limit = 100;
  let offset = 0;

  for (;;) {
    const { data } = await client.users.getUserList({ limit, offset, orderBy: "created_at" });
    for (const user of data) {
      const email = user.primaryEmailAddress?.emailAddress;
      if (email) recipients.push({ id: user.id, email, firstName: user.firstName });
    }
    if (data.length < limit) break;
    offset += limit;
  }

  return recipients;
}

async function requireAdmin(): Promise<NextResponse | null> {
  const { userId } = await auth();
  if (!userId) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  if (!isAdmin(userId)) {
    return NextResponse.json({ error: "Admin only" }, { status: 403 });
  }
  return null;
}

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;

  const recipients = await collectRecipients();
  return NextResponse.json({
    dryRun: true,
    totalRecipients: recipients.length,
    sample: recipients.slice(0, 5).map((r) => r.email),
    note: "Nothing was sent. POST with { \"confirm\": true } to actually send.",
  });
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const body = await req.json().catch(() => ({})) as { confirm?: boolean };
  if (body.confirm !== true) {
    return NextResponse.json(
      { error: "Pass { \"confirm\": true } in the request body to actually send. GET this route first to preview the recipient list." },
      { status: 400 },
    );
  }

  const recipients = await collectRecipients();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://pandaworldai.site";

  let sent = 0;
  const failed: { email: string; error: string }[] = [];

  // Small batches with a pause between them — stays gentle on Resend's
  // rate limits rather than firing everything at once. Adjust BATCH_SIZE
  // down (or the delay up) if Resend starts rejecting requests.
  const BATCH_SIZE = 5;
  for (let i = 0; i < recipients.length; i += BATCH_SIZE) {
    const batch = recipients.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (r) => {
        const tpl = whatsappExtensionAnnouncementEmail({ firstName: r.firstName, appUrl });
        const result = await sendEmail({
          to:       r.email,
          subject:  tpl.subject,
          html:     tpl.html,
          text:     tpl.text,
          category: "announcement-whatsapp-extension",
        });
        return { email: r.email, result };
      }),
    );
    for (const { email, result } of results) {
      if (result.success) sent++;
      else failed.push({ email, error: result.error ?? "unknown error" });
    }
    if (i + BATCH_SIZE < recipients.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return NextResponse.json({
    totalRecipients: recipients.length,
    sent,
    failedCount: failed.length,
    failed: failed.slice(0, 20),
  });
}
