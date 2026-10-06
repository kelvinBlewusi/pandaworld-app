/**
 * Messages from PandaWorld to one seller (table user_notices): shown in the
 * extension panel and the dashboard's notification bell until dismissed.
 * Added by hand in SQL for now (see supabase/migrations/2026-10-06_user-notices.sql).
 */

import { createServerClient } from "@/lib/supabase/server";

export interface UserNotice {
  id:         string;
  title:      string;
  /** Plain text: *word* is shown bold, a blank line starts a new paragraph. */
  body:       string;
  created_at: string;
}

/** The seller's notices not yet dismissed, newest first. */
export async function getUserNotices(userId: string, limit = 3): Promise<UserNotice[]> {
  const { data, error } = await createServerClient()
    .from("user_notices")
    .select("id, title, body, created_at")
    .eq("user_id", userId)
    .is("dismissed_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) {
    console.error("[notices] getUserNotices failed:", error.message);
    return [];
  }
  return (data ?? []) as UserNotice[];
}

/**
 * The seller's newest open notice marked to be shown at the dashboard's
 * API-key card (show_on_key_card), or null. Shown above the Copy button and
 * dismissed when they copy their key, so it is seen once.
 */
export async function getKeyCardNotice(userId: string): Promise<UserNotice | null> {
  const { data, error } = await createServerClient()
    .from("user_notices")
    .select("id, title, body, created_at")
    .eq("user_id", userId)
    .eq("show_on_key_card", true)
    .is("dismissed_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[notices] getKeyCardNotice failed:", error.message);
    return null;
  }
  return ((data ?? []) as UserNotice[])[0] ?? null;
}

/** Hide one notice for good. Scoped to the seller, so nobody dismisses another's. */
export async function dismissUserNotice(userId: string, noticeId: string): Promise<void> {
  await createServerClient()
    .from("user_notices")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", noticeId)
    .eq("user_id", userId);
}
