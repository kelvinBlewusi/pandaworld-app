/**
 * Telling a seller about their credits, once (owner's rules, 2026-10-06):
 *
 *   - Below LOW_CREDITS (6): one "running low" notice in the dashboard bell
 *     and the extension panel when a charge takes them there, and one
 *     WhatsApp warning at their next message to the bot.
 *   - At 0 or below: one "out of credits" notice. Below BOT_MIN_CREDITS (one
 *     listing's cost): one WhatsApp reply, then the bot stays quiet until
 *     they can afford a listing again (lib/whatsapp/credit-gate.ts).
 *
 * Each is remembered in credit_notices and forgotten when the balance
 * recovers (a purchase, a refund, a top-up, or a balance seen above the
 * line), so the next drop is told again. Takes balances as arguments: the
 * ledger (lib/billing/extension-credits.ts) calls in here, never the other
 * way round. Nothing here throws: a notice must never fail a charge.
 */

import { createServerClient } from "@/lib/supabase/server";
import { LISTING_CREDIT_COST, LIVE_LISTING_CREDIT_COST, listingCostFor } from "@/lib/billing/credit-packs";
import { sellerCountry } from "@/lib/jumia/unlistable-categories";

/** Below this, a seller is warned they're running low: about 3 WhatsApp listings. */
export const LOW_CREDITS = 6;

/**
 * Below this the WhatsApp bot goes quiet after one reply: the seller can't
 * afford one listing (lib/whatsapp/credit-gate.ts; owner, 2026-10-06).
 */
export const BOT_MIN_CREDITS = LIVE_LISTING_CREDIT_COST;

type Flag = "low_warned_at" | "low_whatsapp_at" | "out_noticed_at" | "out_replied_at";
type Row = Record<Flag, string | null>;

async function readRow(userId: string): Promise<Row | null> {
  const { data } = await createServerClient()
    .from("credit_notices")
    .select("low_warned_at, low_whatsapp_at, out_noticed_at, out_replied_at")
    .eq("user_id", userId)
    .maybeSingle();
  return (data as Row | null) ?? null;
}

async function setFlags(userId: string, patch: Partial<Row>): Promise<void> {
  await createServerClient()
    .from("credit_notices")
    .upsert({ user_id: userId, ...patch, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
}

/**
 * Set `flag` if it isn't set yet, and say whether this call set it: the
 * claim that makes "once" hold when two messages arrive together.
 */
async function claim(userId: string, flag: Flag): Promise<boolean> {
  const db = createServerClient();
  await db.from("credit_notices").upsert({ user_id: userId }, { onConflict: "user_id", ignoreDuplicates: true });
  const { data } = await db
    .from("credit_notices")
    .update({ [flag]: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is(flag, null)
    .select("user_id");
  return (data ?? []).length > 0;
}

/** "about 2 WhatsApp listings" at `listingCost` (the seller's country's price), or what's left still buys. */
export function creditReach(balance: number, listingCost = LIVE_LISTING_CREDIT_COST): string {
  const listings = Math.floor(balance / listingCost);
  if (listings >= 1) return `enough for about ${listings} WhatsApp listing${listings === 1 ? "" : "s"}`;
  const autofills = Math.floor(balance / LISTING_CREDIT_COST);
  return autofills >= 1
    ? `enough for ${autofills} extension autofill${autofills === 1 ? "" : "s"}, but not a WhatsApp listing`
    : "not enough for a listing";
}

const plural = (n: number) => `${n} credit${n === 1 ? "" : "s"}`;

async function addNotice(userId: string, kind: "credits_low" | "credits_out", title: string, body: string): Promise<void> {
  await createServerClient().from("user_notices").insert({ user_id: userId, kind, title, body });
}

async function takeDown(userId: string, kind: "credits_low" | "credits_out"): Promise<void> {
  await createServerClient()
    .from("user_notices")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("kind", kind)
    .is("dismissed_at", null);
}

/**
 * After a charge: the dashboard and extension notice, once, when the
 * balance drops below LOW_CREDITS, and again (as "out of credits") at 0.
 */
export async function onBalanceDropped(userId: string, balance: number): Promise<void> {
  try {
    if (balance >= LOW_CREDITS) return;
    const row = await readRow(userId);
    if (balance <= 0) {
      if (row?.out_noticed_at) return;
      await takeDown(userId, "credits_low");
      await addNotice(
        userId,
        "credits_out",
        "You're out of credits",
        "Your WhatsApp bot, order alerts and pack features are paused until you buy credits. " +
          "Updates on listings already with Jumia still come through, and a refund from Jumia's quality check " +
          "brings everything back.\n\n*Buy credits* from your dashboard to carry on.",
      );
      await setFlags(userId, { out_noticed_at: new Date().toISOString(), low_warned_at: row?.low_warned_at ?? new Date().toISOString() });
      return;
    }
    if (row?.low_warned_at) return;
    await addNotice(
      userId,
      "credits_low",
      "You're running low on credits",
      `You have *${plural(balance)}* left: ${creditReach(balance, listingCostFor(await sellerCountry(userId).catch(() => null)))}.` +
        (balance < BOT_MIN_CREDITS ? " Your WhatsApp bot is paused until you top up." : "") +
        `\n\n*Buy credits* from your dashboard to keep listing.`,
    );
    await setFlags(userId, { low_warned_at: new Date().toISOString() });
  } catch (e) {
    console.warn(`[credit-status] low/out notice failed for ${userId}: ${(e as Error).message}`);
  }
}

/**
 * Whenever a balance is known to have gone up (purchase, refund, top-up) or
 * is seen: forget what no longer holds and take its notice down, so the
 * next drop is told again.
 */
export async function onBalanceSeen(userId: string, balance: number): Promise<void> {
  try {
    const row = await readRow(userId);
    if (!row) return;
    const patch: Partial<Row> = {};
    if (balance > 0 && row.out_noticed_at) patch.out_noticed_at = null;
    // The bot's one reply is forgotten once they can afford a listing again.
    if (balance >= BOT_MIN_CREDITS && row.out_replied_at) patch.out_replied_at = null;
    if (balance >= LOW_CREDITS) {
      if (row.low_warned_at) patch.low_warned_at = null;
      if (row.low_whatsapp_at) patch.low_whatsapp_at = null;
    }
    if (Object.keys(patch).length === 0) return;
    await setFlags(userId, patch);
    if ("out_noticed_at" in patch) await takeDown(userId, "credits_out");
    if ("low_warned_at" in patch) await takeDown(userId, "credits_low");
  } catch (e) {
    console.warn(`[credit-status] reset failed for ${userId}: ${(e as Error).message}`);
  }
}

/** True once per low spell: this message should carry the WhatsApp "running low" warning. */
export async function claimLowWhatsAppWarning(userId: string): Promise<boolean> {
  try { return await claim(userId, "low_whatsapp_at"); } catch { return false; }
}

/** True once per quiet spell: this message gets the one reply, the rest get silence. */
export async function claimOutOfCreditsReply(userId: string): Promise<boolean> {
  try { return await claim(userId, "out_replied_at"); } catch { return false; }
}

/** The one reply at 0 has gone out (the bot is now quiet for this seller). */
export async function outOfCreditsReplied(userId: string): Promise<boolean> {
  try { return !!(await readRow(userId))?.out_replied_at; } catch { return false; }
}
