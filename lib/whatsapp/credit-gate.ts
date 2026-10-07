/**
 * The bot and the seller's credits (owner's rules, 2026-10-06), checked on
 * every message from a linked number before anything else
 * (lib/whatsapp/intake.ts handleLinkedMessage):
 *
 *   - Below BOT_MIN_CREDITS (what one WhatsApp listing costs): ONE reply
 *     about their credits, then silence (no reply, no "typing…") until they
 *     can afford a listing again: a purchase, or a refund when Jumia's
 *     quality check rejects a listing. The owner, after a test seller with
 *     1 credit sent a whole product's photos only to be refused at drafting:
 *     "after the first message that their balance is low, the bot is left
 *     quiet". Disconnecting Jumia still answers. Linking a number is handled
 *     before this (the webhook), and listing updates are sent, not
 *     answered, so both carry on. Order alerts stop too (order-alerts.ts).
 *   - From there up to LOW_CREDITS: one "running low" warning, sent with the
 *     reply to their next message (inside WhatsApp's 24 hours, so it arrives).
 *   - At the start of a batch, a count their credits can't cover is refused
 *     before any photo is accepted (batchCreditRefusal).
 *
 * Admins and everyone while billing is off pass straight through.
 */

import { availableCredits, getOrCreateCreditBalance, isUnmetered, listingCreditCost, storedBalance } from "@/lib/billing/extension-credits";
import { LIVE_LISTING_CREDIT_COST } from "@/lib/billing/credit-packs";
import {
  BOT_MIN_CREDITS, LOW_CREDITS, claimLowWhatsAppWarning, claimOutOfCreditsReply, creditReach, onBalanceSeen, outOfCreditsReplied,
} from "@/lib/billing/credit-status";
import { parseGlobalCommand } from "@/lib/whatsapp/commands";
import { buyCreditsUrl } from "@/lib/whatsapp/batch";
import { sendCtaUrlIfConfigured } from "@/lib/whatsapp/client";

/** What still answers when the bot is quiet: disconnecting Jumia, and its "keep it" reply. */
const STILL_ANSWERED = new Set(["disconnect", "confirm_disconnect", "keep_connected"]);

const credits = (n: number) => `${n} credit${n === 1 ? "" : "s"}`;

/** The one reply when the seller can't afford a listing. */
export function outOfCreditsMessage(balance: number, listingCost = LIVE_LISTING_CREDIT_COST): string {
  const why = balance <= 0
    ? "You've used all your PandaWorld credits"
    : `You have ${credits(balance)} left, and a WhatsApp listing needs ${listingCost}`;
  return `${why}, so I'll stay quiet until you top up. Buy credits on your dashboard, then send me a message to carry on.\n\n` +
    "Updates about listings already with Jumia will still come here.";
}

export function lowCreditsMessage(balance: number, listingCost = LIVE_LISTING_CREDIT_COST): string {
  return `💡 Heads up: you have ${credits(balance)} left, ${creditReach(balance, listingCost)} ` +
    `(a listing costs ${listingCost} credits when it goes live on Jumia). Top up to keep listing.`;
}

/** Whether the bot is paused for this seller: they can't afford one WhatsApp listing. */
export async function botPausedForCredits(userId: string): Promise<boolean> {
  if (await isUnmetered(userId)) return false;
  return (await storedBalance(userId)) < BOT_MIN_CREDITS;
}

/** "go": handle the message as usual. "stop": the bot is quiet for this seller; nothing more is said. */
export async function creditGate(userId: string, phoneNumber: string, text: string | undefined): Promise<"go" | "stop"> {
  if (await isUnmetered(userId)) return "go";
  const balance = await storedBalance(userId);
  // A balance back above the line (bought, refunded, or topped up by hand)
  // forgets what was said, so the next drop is told again.
  await onBalanceSeen(userId, balance);

  if (balance >= BOT_MIN_CREDITS) {
    if (balance < LOW_CREDITS && (await claimLowWhatsAppWarning(userId))) {
      await sendCtaUrlIfConfigured(phoneNumber, lowCreditsMessage(balance, await listingCreditCost(userId)), "Buy credits", buyCreditsUrl());
    }
    return "go";
  }

  const cmd = text ? parseGlobalCommand(text) : null;
  if (cmd && STILL_ANSWERED.has(cmd.type)) return "go";
  if (await claimOutOfCreditsReply(userId)) {
    await sendCtaUrlIfConfigured(phoneNumber, outOfCreditsMessage(balance, await listingCreditCost(userId)), "Buy credits", buyCreditsUrl());
  }
  return "stop";
}

/**
 * Whether a message will get no reply at all, so the webhook shows read
 * ticks without "typing…". Only once the one reply has gone out.
 */
export async function isCreditQuiet(userId: string): Promise<boolean> {
  try {
    if (await isUnmetered(userId)) return false;
    if (!(await outOfCreditsReplied(userId))) return false;
    return (await storedBalance(userId)) < BOT_MIN_CREDITS;
  } catch {
    return false;
  }
}

/**
 * When a seller says how many products they're listing: refused, before any
 * photo is accepted, if their credits can't list them all
 * (the seller's listing price each when live; credits held for listings still
 * with Jumia don't count). Says how many they can, so they can reply with
 * that or buy credits. Null when the count is fine, or they aren't charged.
 */
export async function batchCreditRefusal(userId: string, count: number): Promise<string | null> {
  const available = await availableCredits(userId);
  if (!Number.isFinite(available)) return null;
  const listingCost = await listingCreditCost(userId);
  const affordable = Math.max(0, Math.floor(available / listingCost));
  if (affordable >= count) return null;
  const held = Math.max(0, Math.round(((await getOrCreateCreditBalance(userId)) - available) * 100) / 100);
  const shown = Math.max(0, available);
  const have = `You have ${credits(shown)} available` + (held > 0 ? ` (${held} more held for listings waiting on Jumia)` : "");
  const each = `${listingCost} credits each when it goes live on Jumia`;
  return affordable === 0
    ? `⚠️ ${have}: not enough to list a product (${each}). Buy credits${held > 0 ? ", or wait for Jumia's verdict on those listings" : ""}, then tell me how many products you're listing.`
    : `⚠️ ${have}: enough to list ${affordable} of your ${count} products (${each}). Reply *${affordable}* to list those now, or buy credits to list all ${count}.`;
}
