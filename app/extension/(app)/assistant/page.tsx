import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { ListingAssistant } from "@/components/assistant/listing-assistant";
import { listingAssistantFor } from "@/lib/whatsapp/listing-assistant";
import { isAdmin } from "@/lib/auth/is-admin";
import { shopCurrencyForUser } from "@/lib/whatsapp/listing-edits";
import { ADMIN_MAX_BATCH_SIZE, MAX_BATCH_SIZE } from "@/lib/whatsapp/batch";
import { POLISH_COST } from "@/lib/whatsapp/chat-polish";
import { isGeminiImageEnabled } from "@/lib/gemini-image";

// ─── /extension/assistant — the Listing Assistant ───────────────────────────
//
// The WhatsApp bot as a chat on the dashboard (owner, 2026-10-07), with photo
// upload: listing from photos, drafts, submitting, live products, questions
// about the shop. Every seller has it (2026-10-07); only while the
// assistant's kill switch is off does this say it's paused. Shipping labels
// and order alerts stay on WhatsApp. See lib/whatsapp/channel.ts for how the
// same bot runs here.

export const metadata: import("next").Metadata = {
  title: "Jumia Listing Assistant",
  robots: { index: false },
};

export const dynamic = "force-dynamic";

export default async function ListingAssistantPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/extension/assistant");

  if (!(await listingAssistantFor(userId))) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-orange-50">
          <Image src="/brand/panda-p-logo-trimmed.png" alt="PandaWorld" width={634} height={562} className="h-8 w-auto" />
        </span>
        <h2 className="mt-4 text-lg font-semibold text-zinc-900">The Jumia Listing Assistant is paused</h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-600">
          It&apos;s back shortly. Meanwhile, list from WhatsApp: it does the same.
        </p>
        <Link
          href="/extension/whatsapp-listings"
          className="mt-5 inline-flex rounded-lg bg-orange-500 px-4 py-2.5 text-sm font-semibold text-white hover:bg-orange-600"
        >
          List from WhatsApp
        </Link>
      </div>
    );
  }

  const user = await currentUser().catch(() => null);
  // The product form: how products are listed on the web (owner, 2026-10-08).
  const productForm = {
    currency:    await shopCurrencyForUser(userId).catch(() => "GHS"),
    maxProducts: isAdmin(userId) ? ADMIN_MAX_BATCH_SIZE : MAX_BATCH_SIZE,
    // "Polish photos" on each card when the image service is on (lib/whatsapp/chat-polish.ts).
    polishCost:  isGeminiImageEnabled() ? POLISH_COST : null,
  };
  return <ListingAssistant firstName={user?.firstName ?? null} productForm={productForm} />;
}
