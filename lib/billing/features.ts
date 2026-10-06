/**
 * Which pack features a seller has (PACK_FEATURES in
 * lib/billing/credit-packs.ts). A feature comes with the highest pack the
 * seller has ever bought: buying Standard once unlocks Standard's features
 * for good, and a later Starter top-up doesn't lock them again. The owner
 * can also give one seller a feature without the pack
 * (lib/billing/feature-grants.ts).
 *
 * Admins have everything, and so does everyone while billing is off: off
 * means PandaWorld is free, features included (lib/billing/mode.ts).
 */

import { createServerClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/is-admin";
import { isBillingEnabled } from "@/lib/billing/mode";
import { PACK_FEATURES, getCreditPackByCredits, packRank, type CreditPack } from "@/lib/billing/credit-packs";
import { activeFeatureGrant } from "@/lib/billing/feature-grants";

export type FeatureId = "qc_fix" | "image_polish_extension" | "fee_calc_extension";

/** The biggest pack the seller has bought, from their purchase ledger. Null if none. */
export async function highestPackBought(userId: string): Promise<CreditPack | null> {
  const db = createServerClient();
  const { data } = await db
    .from("extension_credit_transactions")
    .select("amount")
    .eq("user_id", userId)
    .eq("type", "purchase");
  let best: CreditPack | null = null;
  for (const row of (data ?? []) as { amount: number | string }[]) {
    const pack = getCreditPackByCredits(Number(row.amount));
    if (pack && packRank(pack.id) > packRank(best?.id)) best = pack;
  }
  return best;
}

export async function hasFeature(userId: string, feature: FeatureId): Promise<boolean> {
  if (isAdmin(userId) || !(await isBillingEnabled())) return true;
  const minPack = PACK_FEATURES.find((f) => f.id === feature)?.minPack;
  if (minPack) {
    const top = await highestPackBought(userId);
    if (top && packRank(top.id) >= packRank(minPack)) return true;
  }
  return (await activeFeatureGrant(userId, feature)) != null;
}

/** The pack a feature starts at, for telling a seller where to get it. */
export function featureMinPackName(feature: FeatureId): string {
  const id = PACK_FEATURES.find((f) => f.id === feature)?.minPack ?? "";
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : "";
}
