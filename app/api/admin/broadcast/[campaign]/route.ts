import { NextRequest, NextResponse } from "next/server";
import { auth, clerkClient } from "@clerk/nextjs/server";
import { isAdmin } from "@/lib/auth/is-admin";
import { sendEmail } from "@/lib/email/send";
import { improvementsAndVideosEmail, whatsappExtensionAnnouncementEmail } from "@/lib/email/templates";

// ─── /api/admin/broadcast/<campaign> ─────────────────────────────────────────
//
// Admin-triggered one-off broadcasts to every Clerk sign-up with an email
// address — not just active users, per direct request. One entry in
// CAMPAIGNS per email (lib/email/templates.ts).
//
// There is no `users` table in this project (see app/api/webhooks/clerk/
// route.ts) — Clerk is the only source of the real sign-up list, so this
// pulls it live via clerkClient().users.getUserList() rather than
// querying Supabase.
//
// GET              — dry run. Counts recipients, returns a small sample,
//                    sends nothing. Use this first to sanity-check the list.
// GET ?preview=1   — the email itself, as a page, addressed to you.
// POST { testTo }  — sends one copy to that address only.
// POST { confirm: true } — real send to everyone. The explicit flag is a
//                    deliberate extra step so a bare POST (e.g. from a tool
//                    that auto-retries) can't trigger a real send by accident.
//
// Intentionally not a "campaigns" feature — there's no send-tracking
// table, so re-running the real send re-sends to everyone. Don't run it
// twice.
export const maxDuration = 60;

type Render = (opts: { firstName?: string | null; appUrl: string }) => { subject: string; html: string; text: string };

const CAMPAIGNS: Record<string, { render: Render; category: string }> = {
  "whatsapp-extension-announcement": { render: whatsappExtensionAnnouncementEmail, category: "announcement-whatsapp-extension" },
  // October 2026: what's new, and the five how-to videos.
  "improvements-and-videos":         { render: improvementsAndVideosEmail,        category: "announcement-improvements-videos" },
};

interface Recipient {
  id:        string;
  email:     string;
  firstName: string | null;
}

const appUrl = () => process.env.NEXT_PUBLIC_APP_URL ?? "https://pandaworldai.site";

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

async function requireAdmin(): Promise<{ denied: NextResponse } | { userId: string }> {
  const { userId } = await auth();
  if (!userId) {
    return { denied: new NextResponse("Unauthorized", { status: 401 }) };
  }
  if (!isAdmin(userId)) {
    return { denied: NextResponse.json({ error: "Admin only" }, { status: 403 }) };
  }
  return { userId };
}

function campaignFor(name: string): { render: Render; category: string } | NextResponse {
  return CAMPAIGNS[name] ?? NextResponse.json({ error: `No campaign "${name}". Known: ${Object.keys(CAMPAIGNS).join(", ")}` }, { status: 404 });
}

export async function GET(req: NextRequest, { params }: { params: { campaign: string } }) {
  const admin = await requireAdmin();
  if ("denied" in admin) return admin.denied;
  const campaign = campaignFor(params.campaign);
  if (campaign instanceof NextResponse) return campaign;

  if (req.nextUrl.searchParams.get("preview")) {
    const me = await (await clerkClient()).users.getUser(admin.userId);
    const tpl = campaign.render({ firstName: me.firstName, appUrl: appUrl() });
    return new NextResponse(tpl.html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }

  const recipients = await collectRecipients();
  return NextResponse.json({
    dryRun: true,
    campaign: params.campaign,
    totalRecipients: recipients.length,
    sample: recipients.slice(0, 5).map((r) => r.email),
    note: "Nothing was sent. Add ?preview=1 to see the email, POST { \"testTo\": \"you@example.com\" } to send yourself a copy, or POST { \"confirm\": true } to send to everyone.",
  });
}

export async function POST(req: NextRequest, { params }: { params: { campaign: string } }) {
  const admin = await requireAdmin();
  if ("denied" in admin) return admin.denied;
  const campaign = campaignFor(params.campaign);
  if (campaign instanceof NextResponse) return campaign;

  const body = await req.json().catch(() => ({})) as { confirm?: boolean; testTo?: string };

  if (typeof body.testTo === "string" && body.testTo.includes("@")) {
    const tpl = campaign.render({ firstName: null, appUrl: appUrl() });
    const result = await sendEmail({
      to: body.testTo, subject: `[Test] ${tpl.subject}`, html: tpl.html, text: tpl.text, category: `${campaign.category}-test`,
    });
    return NextResponse.json({ test: true, to: body.testTo, ...result });
  }

  if (body.confirm !== true) {
    return NextResponse.json(
      { error: "Pass { \"confirm\": true } in the request body to actually send. GET this route first to preview the recipient list." },
      { status: 400 },
    );
  }

  const recipients = await collectRecipients();

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
        const tpl = campaign.render({ firstName: r.firstName, appUrl: appUrl() });
        const result = await sendEmail({
          to:       r.email,
          subject:  tpl.subject,
          html:     tpl.html,
          text:     tpl.text,
          category: campaign.category,
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
    campaign: params.campaign,
    totalRecipients: recipients.length,
    sent,
    failedCount: failed.length,
    failed: failed.slice(0, 20),
  });
}
