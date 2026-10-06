/**
 * Pack features given to one seller without the pack (table
 * feature_grants), on top of what their packs include (lib/billing/
 * features.ts). A grant can be free to use, with no credits charged, and
 * can end once the seller has spent a number of credits since it began:
 * the first was Image Polish, free, for a seller on free credits "until
 * his 8 credits run out" (owner's request, 2026-10-06).
 *
 * Counting credits spent rather than watching the balance means a top-up
 * doesn't stretch the grant past what was given.
 */

import { createServerClient } from "@/lib/supabase/server";
import type { FeatureId } from "@/lib/billing/features";

export interface FeatureGrant {
  id:      string;
  freeUse: boolean;
}

interface GrantRow {
  id:               string;
  free_use:         boolean | null;
  credit_allowance: number | string | null;
  ends_at:          string | null;
  created_at:       string;
}

/** Credits the seller has spent since `since`: deductions less refunds. */
async function creditsSpentSince(userId: string, since: string): Promise<number> {
  const { data } = await createServerClient()
    .from("extension_credit_transactions")
    .select("amount")
    .eq("user_id", userId)
    .in("type", ["deduction", "refund"])
    .gt("created_at", since);
  return ((data ?? []) as { amount: number | string }[]).reduce((spent, r) => spent - Number(r.amount), 0);
}

/** The seller's grant of `feature` still running, or null. */
export async function activeFeatureGrant(userId: string, feature: FeatureId): Promise<FeatureGrant | null> {
  const { data, error } = await createServerClient()
    .from("feature_grants")
    .select("id, free_use, credit_allowance, ends_at, created_at")
    .eq("user_id", userId)
    .eq("feature", feature);
  if (error || !data) return null;

  for (const g of data as GrantRow[]) {
    if (g.ends_at && Date.parse(g.ends_at) <= Date.now()) continue;
    if (g.credit_allowance != null && (await creditsSpentSince(userId, g.created_at)) >= Number(g.credit_allowance)) continue;
    return { id: g.id, freeUse: !!g.free_use };
  }
  return null;
}

/** Count one free use of a grant. Best effort: a lost count costs nothing. */
export async function recordGrantUse(grantId: string): Promise<void> {
  const db = createServerClient();
  const { data } = await db.from("feature_grants").select("uses").eq("id", grantId).maybeSingle();
  if (!data) return;
  await db.from("feature_grants").update({ uses: Number(data.uses ?? 0) + 1 }).eq("id", grantId);
}
