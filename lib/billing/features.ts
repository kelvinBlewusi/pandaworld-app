/**
 * Which pack features a seller has (PACK_FEATURES in
 * lib/billing/credit-packs.ts). Owner's rules, 2026-10-06:
 *
 *   - The pack a seller is ON decides: the last pack they bought. A smaller
 *     pack bought after a bigger one means the smaller pack's features (it
 *     used to be the biggest pack ever bought).
 *   - At 0 credits or below, no pack feature works until the balance is
 *     above 0 again (lib/billing/extension-credits.ts isOutOfCredits),
 *     grants included. `ignoreBalance` is for what must keep running at 0:
 *     the QC follow-up that refunds a rejected listing (which is what lets
 *     a seller at 0 carry on), and the wording of listing updates.
 *
 * The owner can also give one seller a feature without the pack
 * (lib/billing/feature-grants.ts). Admins have everything, and so does
 * everyone while billing is off: off means PandaWorld is free, features
 * included (lib/billing/mode.ts).
 */

import { createServerClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/is-admin";
import { isBillingEnabled } from "@/lib/billing/mode";
import { PACK_FEATURES, getCreditPackByCredits, packRank, type CreditPack } from "@/lib/billing/credit-packs";
import { activeFeatureGrant } from "@/lib/billing/feature-grants";
import { isOutOfCredits } from "@/lib/billing/extension-credits";

export type FeatureId =
  | "qc_fix" | "image_polish_extension" | "fee_calc_extension" | "order_alerts" | "shipping_labels";

/** Why a seller can't use a feature: their pack doesn't include it, or they're out of credits. */
export type FeatureBlock = "pack" | "credits";

/**
 * The pack the seller is on: their latest purchase, matched to a pack by its
 * credits. Null if they never bought one. Ties (no timestamps) go to the
 * later row.
 */
export async function currentPack(userId: string): Promise<CreditPack | null> {
  const { data } = await createServerClient()
    .from("extension_credit_transactions")
    .select("amount, created_at")
    .eq("user_id", userId)
    .eq("type", "purchase");
  let latest: { amount: number | string; created_at?: string | null } | null = null;
  for (const row of (data ?? []) as { amount: number | string; created_at?: string | null }[]) {
    if (!latest || String(row.created_at ?? "") >= String(latest.created_at ?? "")) latest = row;
  }
  return latest ? getCreditPackByCredits(Number(latest.amount)) ?? null : null;
}

export async function featureAccess(
  userId:  string,
  feature: FeatureId,
  opts:    { ignoreBalance?: boolean } = {},
): Promise<{ ok: true } | { ok: false; blockedBy: FeatureBlock }> {
  if (isAdmin(userId) || !(await isBillingEnabled())) return { ok: true };

  const minPack = PACK_FEATURES.find((f) => f.id === feature)?.minPack;
  let included = false;
  if (minPack) {
    const pack = await currentPack(userId);
    included = !!pack && packRank(pack.id) >= packRank(minPack);
  }
  if (!included) included = (await activeFeatureGrant(userId, feature)) != null;
  if (!included) return { ok: false, blockedBy: "pack" };

  if (!opts.ignoreBalance && (await isOutOfCredits(userId))) return { ok: false, blockedBy: "credits" };
  return { ok: true };
}

export async function hasFeature(userId: string, feature: FeatureId, opts: { ignoreBalance?: boolean } = {}): Promise<boolean> {
  return (await featureAccess(userId, feature, opts)).ok;
}

/** The pack a feature starts at, for telling a seller where to get it. */
export function featureMinPackName(feature: FeatureId): string {
  const id = PACK_FEATURES.find((f) => f.id === feature)?.minPack ?? "";
  return id ? id.charAt(0).toUpperCase() + id.slice(1) : "";
}
