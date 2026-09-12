import { notFound } from "next/navigation";
import { getListing } from "@/lib/actions/listings";
import { WhatsAppFocusedEditor } from "@/components/extension/whatsapp-focused-editor";

// ─── /extension/whatsapp-listings/[id] ───────────────────────────────────────
//
// The "focused editor" a seller lands on by tapping a per-product edit link
// sent from the WhatsApp chat flow (see lib/whatsapp/intake.ts) — a simple,
// category-scoped form for exactly ONE chat-drafted product. No extra auth
// logic needed here: app/extension/(app)/layout.tsx already gates this whole
// route group behind a Clerk session, and getListing() already scopes by
// user_id, so another seller's listing id just 404s.

export const metadata: import("next").Metadata = {
  title: "Edit product — WhatsApp listings",
  robots: { index: false },
};

export default async function WhatsAppFocusedEditorPage({
  params,
}: {
  params: { id: string };
}) {
  const listing = await getListing(params.id);
  if (!listing) notFound();
  return <WhatsAppFocusedEditor listing={listing} />;
}
