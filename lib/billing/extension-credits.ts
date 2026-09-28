/**
 * The credit ledger — one never-expiring balance per seller, spent on
 * extension autofills (app/api/extension/fill/route.ts) and on WhatsApp
 * and web drafts (lib/whatsapp/intake.ts, app/api/listings/[id]/
 * auto-analyze). The only billing there is: the monthly plans were
 * removed 2026-09-28. See supabase/migrations/2026-08-24_extension-
 * credits.sql.
 *
 * Nothing is charged while billing is switched off (lib/billing/mode.ts):
 * reads return Infinity and deductions are no-ops, so balances stay put
 * until the switch is flipped. Purchases always land, whatever the switch.
 *
 * Plain server module, not "use server": exporting these as server
 * actions would let any browser call creditPurchase for any user id.
 */

import { createServerClient } from "@/lib/supabase/server";
import { FREE_SIGNUP_CREDITS, getCreditPackByCredits, type CreditPack } from "@/lib/billing/credit-packs";
import { isAdmin } from "@/lib/auth/is-admin";
import { isBillingEnabled } from "@/lib/billing/mode";

/** Admins, and everyone while billing is off, spend nothing. */
async function isUnmetered(userId: string): Promise<boolean> {
  return isAdmin(userId) || !(await isBillingEnabled());
}

export interface CreditTransaction {
  id: string;
  type: "grant" | "purchase" | "deduction" | "refund";
  amount: number;
  balance_after: number;
  description: string | null;
  created_at: string;
}

/**
 * Recent entries from the credit ledger, newest first — powers the
 * dashboard's notification bell (components/extension/shell.tsx). Admins
 * never touch this ledger (getOrCreateCreditBalance short-circuits them to
 * Infinity), so there's nothing to show them.
 */
export async function getRecentTransactions(userId: string, limit = 10): Promise<CreditTransaction[]> {
  if (isAdmin(userId)) return [];

  const db = createServerClient();
  const { data, error } = await db
    .from("extension_credit_transactions")
    .select("id, type, amount, balance_after, description, created_at")
    .eq("user_id", userId)
    .is("dismissed_at", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    console.error("[extension-credits] getRecentTransactions failed:", error.message);
    return [];
  }
  return data ?? [];
}

/**
 * When this user last opened the notification bell dropdown — anything
 * newer is "new" (see shell.tsx). NULL means never opened it.
 */
export async function getNotificationsSeenAt(userId: string): Promise<string | null> {
  if (isAdmin(userId)) return null;

  const db = createServerClient();
  const { data } = await db
    .from("extension_credits")
    .select("notifications_seen_at")
    .eq("user_id", userId)
    .maybeSingle();
  return data?.notifications_seen_at ?? null;
}

/** Marks the notification bell as viewed right now — called when the dropdown opens. */
export async function markNotificationsSeen(userId: string): Promise<void> {
  if (isAdmin(userId)) return;

  // Ensure the row exists first — a brand-new user opening the bell before
  // any other extension_credits read/write would otherwise no-op silently.
  await storedBalance(userId);

  const db = createServerClient();
  await db
    .from("extension_credits")
    .update({ notifications_seen_at: new Date().toISOString() })
    .eq("user_id", userId);
}

/**
 * Hides one notification from the bell going forward (the "x" button). The
 * ledger row itself is kept — it's still part of the credit balance's audit
 * trail — this only sets dismissed_at so getRecentTransactions() skips it.
 * Scoped to userId so one user can never dismiss another's row.
 */
export async function dismissNotification(userId: string, transactionId: string): Promise<void> {
  const db = createServerClient();
  await db
    .from("extension_credit_transactions")
    .update({ dismissed_at: new Date().toISOString() })
    .eq("id", transactionId)
    .eq("user_id", userId);
}

/**
 * The credit pack from the user's most recent purchase, if any — the
 * dashboard's "Plan" pill (components/extension/shell.tsx) shows its name,
 * and "Free" for a seller who has never bought one.
 *
 * Matched by credit amount rather than a stored pack id — see
 * getCreditPackByCredits(). Returns null if the user has never purchased a
 * pack, or if a since-removed/renamed pack no longer matches any credits
 * value in CREDIT_PACKS.
 */
export async function getMostRecentCreditPack(userId: string): Promise<CreditPack | null> {
  if (isAdmin(userId)) return null;

  const db = createServerClient();
  const { data, error } = await db
    .from("extension_credit_transactions")
    .select("amount")
    .eq("user_id", userId)
    .eq("type", "purchase")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  return getCreditPackByCredits(Number(data.amount)) ?? null;
}

/**
 * What the seller can spend: Infinity for admins (ADMIN_USER_IDS) and for
 * everyone while billing is off, otherwise their stored balance. Infinity
 * is safe in arithmetic (`balance < amount` is always false); routes that
 * serialize it to JSON must use serializeCredits first, since
 * JSON.stringify turns Infinity into null.
 */
export async function getOrCreateCreditBalance(userId: string): Promise<number> {
  if (await isUnmetered(userId)) return Infinity;
  return storedBalance(userId);
}

/**
 * The balance actually stored for this seller, provisioning the free
 * sign-up grant the first time it's needed (a metered read, a purchase,
 * or the Clerk user.created webhook while billing is on). The insert is
 * guarded by the table's primary key, so a race between two of those
 * doesn't double-grant: the loser's insert fails and re-reads the
 * winner's row.
 */
export async function storedBalance(userId: string): Promise<number> {
  const db = createServerClient();
  const { data: existing } = await db
    .from("extension_credits")
    .select("balance")
    .eq("user_id", userId)
    .maybeSingle();
  if (existing) return Number(existing.balance);

  const { error } = await db
    .from("extension_credits")
    .insert({ user_id: userId, balance: FREE_SIGNUP_CREDITS });

  if (error) {
    const { data: after } = await db
      .from("extension_credits")
      .select("balance")
      .eq("user_id", userId)
      .maybeSingle();
    return Number(after?.balance ?? 0);
  }

  await db.from("extension_credit_transactions").insert({
    user_id: userId,
    type: "grant",
    amount: FREE_SIGNUP_CREDITS,
    balance_after: FREE_SIGNUP_CREDITS,
    description: `Welcome bonus — ${FREE_SIGNUP_CREDITS} free credits`,
  });

  return FREE_SIGNUP_CREDITS;
}

/**
 * Add `amount` to the stored balance with a compare-and-swap (see
 * deductCredits for why), returning the new balance, or null if five
 * attempts in a row lost a race.
 */
async function addToBalance(userId: string, amount: number): Promise<number | null> {
  const db = createServerClient();
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await storedBalance(userId);
    const newBalance = Math.round((current + amount) * 100) / 100;
    const { data, error } = await db
      .from("extension_credits")
      .update({ balance: newBalance, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("balance", current)
      .select("balance");
    if (error) {
      console.error("[extension-credits] balance update failed:", error.message);
      return null;
    }
    if (data && data.length > 0) return newBalance;
  }
  return null;
}

/**
 * Spend credits for one extension autofill or one draft.
 *
 * Compare-and-swap, not a plain read-then-write: two concurrent autofills
 * from the same seller can both call storedBalance() before
 * either writes back, both see (say) balance=5, and both would compute and
 * write the same newBalance=2.5 — one deduction is silently lost and the
 * seller effectively spent 2.5 credits for two autofills. The extra
 * `.eq("balance", balance)` makes the UPDATE a no-op unless the row still
 * holds the exact value we read; Supabase returns the updated row only when
 * it actually matched, so a lost race is detectable (empty `data`) rather
 * than silently overwriting a fresher balance, and we retry against the
 * now-current one instead of racing again blind.
 */
export async function deductCredits(
  userId: string,
  amount: number,
  description: string,
): Promise<{ ok: true; balance: number } | { ok: false; error: string; balance: number }> {
  if (await isUnmetered(userId)) return { ok: true, balance: Infinity };

  const db = createServerClient();

  for (let attempt = 0; attempt < 5; attempt++) {
    const balance = await storedBalance(userId);
    if (balance < amount) {
      return { ok: false, error: "insufficient_credits", balance };
    }
    const newBalance = Math.round((balance - amount) * 100) / 100;
    const { data, error } = await db
      .from("extension_credits")
      .update({ balance: newBalance, updated_at: new Date().toISOString() })
      .eq("user_id", userId)
      .eq("balance", balance)
      .select("balance");
    if (error) {
      console.error("[extension-credits] deduct failed:", error.message);
      return { ok: false, error: "db_error", balance };
    }
    if (!data || data.length === 0) continue; // lost the race — retry fresh

    await db.from("extension_credit_transactions").insert({
      user_id: userId,
      type: "deduction",
      amount: -amount,
      balance_after: newBalance,
      description,
    });
    return { ok: true, balance: newBalance };
  }

  console.error(`[extension-credits] deduct gave up after 5 CAS retries for user=${userId}`);
  return { ok: false, error: "concurrent_update", balance: await storedBalance(userId) };
}

/**
 * Credit a successful Paystack purchase. Idempotent on `reference` — the
 * webhook and the client-side verify call can both fire for the same
 * transaction (or the webhook can retry), and only the first one lands.
 *
 * Always writes the stored balance, whatever the billing switch: credits
 * bought while billing is off are waiting when it's switched on.
 */
export async function creditPurchase(args: {
  userId: string;
  credits: number;
  reference: string;
  description: string;
}): Promise<{ ok: true; balance: number; alreadyProcessed?: boolean } | { ok: false; error: string }> {
  const db = createServerClient();

  // Dedupe guard FIRST — the unique index on `reference` makes a second
  // attempt at the same transaction fail here rather than double-crediting.
  const { error: txError } = await db.from("extension_credit_transactions").insert({
    user_id: args.userId,
    type: "purchase",
    amount: args.credits,
    balance_after: 0, // corrected below once the real balance is known
    reference: args.reference,
    description: args.description,
  });

  if (txError) {
    if (txError.code === "23505") {
      return { ok: true, balance: await storedBalance(args.userId), alreadyProcessed: true };
    }
    console.error("[extension-credits] creditPurchase tx insert failed:", txError.message);
    return { ok: false, error: txError.message };
  }

  const newBalance = await addToBalance(args.userId, args.credits);
  if (newBalance === null) {
    // Take the dedupe row back out so Paystack's webhook retry (or the
    // seller's verify) can credit it, rather than being turned away as
    // already processed with the credits never added.
    await db.from("extension_credit_transactions").delete().eq("reference", args.reference);
    console.error(`[extension-credits] creditPurchase couldn't update the balance for ${args.reference}`);
    return { ok: false, error: "balance_update_failed" };
  }

  await db
    .from("extension_credit_transactions")
    .update({ balance_after: newBalance })
    .eq("reference", args.reference);

  return { ok: true, balance: newBalance };
}

/**
 * Admin top-up (/admin/billing): bring every stored balance below
 * `target` up to it, one "grant" per seller, so sellers who signed up
 * under the old 10-credit welcome start level with new ones. Only touches
 * sellers who already have a ledger row; everyone else gets the full
 * sign-up grant on first use anyway. Safe to run twice: the second run
 * finds nobody below the target.
 */
export async function topUpBalancesTo(target: number): Promise<{ toppedUp: number }> {
  const db = createServerClient();
  const { data, error } = await db.from("extension_credits").select("user_id, balance").lt("balance", target);
  if (error) throw new Error(`Couldn't read balances: ${error.message}`);

  let toppedUp = 0;
  for (const row of (data ?? []) as { user_id: string; balance: number | string }[]) {
    const current = Number(row.balance);
    const gift = Math.round((target - current) * 100) / 100;
    if (gift <= 0 || isAdmin(row.user_id)) continue;
    // CAS on the value just read: a seller spending or buying at this
    // moment is skipped rather than overwritten.
    const { data: updated } = await db
      .from("extension_credits")
      .update({ balance: target, updated_at: new Date().toISOString() })
      .eq("user_id", row.user_id)
      .eq("balance", current)
      .select("balance");
    if (!updated || updated.length === 0) continue;
    await db.from("extension_credit_transactions").insert({
      user_id: row.user_id,
      type: "grant",
      amount: gift,
      balance_after: target,
      description: `Top-up to ${target} free credits`,
    });
    toppedUp++;
  }
  return { toppedUp };
}
