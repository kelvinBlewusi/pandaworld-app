import { redirect } from "next/navigation";

/**
 * Legacy `/listings/new` entry point — superseded by `/listings/new/batch`
 * which handles 1–N products via tabs.
 *
 * We preserve this route as a permanent server-side redirect so that:
 *   - any external bookmarks / old sidebar references still resolve
 *   - the URL space stays clean (single canonical upload page)
 *
 * The previous AI-text and URL-import tiles ("Soon" placeholders) lived
 * here. They've been dropped — when those features ship, the batch page
 * will get tabs/modes for them rather than reviving this separate entry.
 */
export default function LegacyNewListingRedirect() {
  redirect("/listings/new/batch?count=1");
}
