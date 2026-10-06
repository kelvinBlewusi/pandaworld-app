/**
 * The bot and the seller's credits (owner's rules, 2026-10-06), checked on
 * every message from a linked number before anything else
 * (lib/whatsapp/intake.ts handleLinkedMessage):
 *
 *   - At 0 credits or below: ONE reply about their credits, then silence
 *     (no reply, no "typing…") until the balance is above 0 again: a
 *     purchase, or a refund when Jumia's quality check rejects a listing.
 *     Disconnecting Jumia still answers. Linking a number is handled before
 *     this (the webhook), and listing updates are sent, not answered, so
 *     both carry on.
 *   - Below LOW_CREDITS: one "running low" warning, sent with the reply to
 *     their next message (inside WhatsApp's 24 hours, so it arrives).
 *
 * Admins and everyone while billing is off pass straight through.
 */

import { availableCredits, getOrCreateCreditBalance, isUnmetered, storedBalance } from "@/lib/billing/extension-credits";
import { LIVE_LISTING_CREDIT_COST } from "@/lib/billing/credit-packs";
import {
  LOW_CREDITS, claimLowWhatsAppWarning, claimOutOfCreditsReply, creditReach, onBalanceSeen, outOfCreditsReplied,
} from "@/lib/billing/credit-status";
import { parseGlobalCommand } from "@/lib/whatsapp/commands";
import { buyCreditsUrl } from "@/lib/whatsapp/batch";
import { sendCtaUrlIfConfigured } from "@/lib/whatsapp/client";

/** What still answers at 0: disconnecting Jumia, and its "keep it" reply. */
const STILL_ANSWERED = new Set(["disconnect", "confirm_disconnect", "keep_connected"]);

export function outOfCreditsMessage(): string {
  return "You've used all your PandaWorld credits, so I'll stay quiet until you top up. " +
    "Buy credits on your dashboard, then send me a message to carry on.\n\n" +
    "Updates about listings already with Jumia will still come here.";
}

export function lowCreditsMessage(balance: number): string {
  return `💡 Heads up: you have ${balance} credit${balance === 1 ? "" : "s"} left, ${creditReach(balance)} ` +
    `(a listing costs ${LIVE_LISTING_CREDIT_COST} credits when it goes live on Jumia). Top up to keep listing.`;
}

/**
 * "go": handle the message as usual ("go_warned" when the running-low
 * warning went out with it, so a batch's own credit note isn't repeated).
 * "stop": the seller is out of credits; nothing more is said.
 */
export async function creditGate(userId: string, phoneNumber: string, text: string | undefined): Promise<"go" | "go_warned" | "stop"> {
  if (await isUnmetered(userId)) return "go";
  const balance = await storedBalance(userId);
  // A balance back above the line (bought, refunded, or topped up by hand)
  // forgets what was said, so the next drop is told again.
  await onBalanceSeen(userId, balance);

  if (balance > 0) {
    if (balance < LOW_CREDITS && (await claimLowWhatsAppWarning(userId))) {
      await sendCtaUrlIfConfigured(phoneNumber, lowCreditsMessage(balance), "Buy credits", buyCreditsUrl());
      return "go_warned";
    }
    return "go";
  }

  const cmd = text ? parseGlobalCommand(text) : null;
  if (cmd && STILL_ANSWERED.has(cmd.type)) return "go";
  if (await claimOutOfCreditsReply(userId)) {
    await sendCtaUrlIfConfigured(phoneNumber, outOfCreditsMessage(), "Buy credits", buyCreditsUrl());
  }
  return "stop";
}

/**
 * Whether a message will get no reply at all, so the webhook shows read
 * ticks without "typing…". Only once the one reply at 0 has gone out.
 */
export async function isCreditQuiet(userId: string): Promise<boolean> {
  try {
    if (await isUnmetered(userId)) return false;
    if (!(await outOfCreditsReplied(userId))) return false;
    return (await storedBalance(userId)) <= 0;
  } catch {
    return false;
  }
}

/**
 * At the start of a WhatsApp batch (owner's request, 2026-10-06): when the
 * seller's credits can't list all `count` products (LIVE_LISTING_CREDIT_COST
 * each when live; credits held for listings still with Jumia don't count),
 * how many they can. Null when they can list them all, or aren't charged.
 * Drafting carries on either way: the ones past what they can pay for wait
 * at Done with a Retry, their photos kept.
 */
export async function batchCreditShortfall(userId: string, count: number): Promise<string | null> {
  const available = await availableCredits(userId);
  if (!Number.isFinite(available)) return null;
  const affordable = Math.max(0, Math.floor(available / LIVE_LISTING_CREDIT_COST));
  if (affordable >= count) return null;
  const held = Math.max(0, Math.round(((await getOrCreateCreditBalance(userId)) - available) * 100) / 100);
  const shown = Math.max(0, available);
  return `⚠️ Heads up: you have ${shown} credit${shown === 1 ? "" : "s"} available` +
    (held > 0 ? ` (${held} more held for listings waiting on Jumia)` : "") +
    `: ${affordable === 0 ? "not enough to list any of these yet" : `enough to list ${affordable} of your ${count} products`} ` +
    `(${LIVE_LISTING_CREDIT_COST} credits each when it goes live on Jumia). Buy credits now to list them all; your photos are kept either way.`;
}
