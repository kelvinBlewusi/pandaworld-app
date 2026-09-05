"use server";

/**
 * Extension credit ledger — a separate, never-expiring balance for the
 * Chrome extension's autofill flow (app/api/extension/fill/route.ts),
 * independent from the classic app's plan-based monthly quota
 * (lib/billing/quota.ts). See supabase/migrations/2026-08-24_extension-
 * credits.sql and docs/chrome-extension-plan.md §10 update.
 */

import { createServerClient } from "@/lib/supabase/server";
import { FREE_SIGNUP_CREDITS, getCreditPackByCredits, type CreditPack } from "@/lib/billing/credit-packs";
import { isAdmin } from "@/lib/auth/is-admin";

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
  await getOrCreateCreditBalance(userId);

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
 * The credit pack from the user's most recent purchase, if any — lets the
 * dashboard's "Plan" pill (components/extension/shell.tsx) show something
 * meaningful for extension-only sellers, who never touch the classic app's
 * subscription tiers (lib/billing/plans.ts) and would otherwise be stuck
 * looking permanently "Free" no matter how many credits they've bought.
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
 * Reads the user's credit balance, provisioning the free sign-up grant the
 * first time anyone asks (dashboard load, fill request, or the Clerk
 * user.created webhook — whichever happens first). The insert is guarded
 * by the table's primary key, so a race between two of those doesn't
 * double-grant: the loser's insert fails and we just re-read the winner's row.
 *
 * Admins (ADMIN_USER_IDS — same gate lib/billing/quota.ts uses for
 * unlimited plan quota) get Infinity, never touching the ledger — safe to
 * use directly in arithmetic (`balance < amount` is always false); routes
 * that serialize this to JSON must guard it first, since JSON.stringify
 * turns Infinity into null.
 */
export async function getOrCreateCreditBalance(userId: string): Promise<number> {
  if (isAdmin(userId)) return Infinity;

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
 * Spend credits for one extension autofill.
 *
 * Compare-and-swap, not a plain read-then-write: two concurrent autofills
 * from the same seller can both call getOrCreateCreditBalance() before
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
  if (isAdmin(userId)) return { ok: true, balance: Infinity };

  const db = createServerClient();

  for (let attempt = 0; attempt < 5; attempt++) {
    const balance = await getOrCreateCreditBalance(userId);
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
  return { ok: false, error: "concurrent_update", balance: await getOrCreateCreditBalance(userId) };
}

/**
 * Credit a successful Paystack purchase. Idempotent on `reference` — the
 * webhook and the client-side verify call can both fire for the same
 * transaction (or the webhook can retry), and only the first one lands.
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
      const balance = await getOrCreateCreditBalance(args.userId);
      return { ok: true, balance, alreadyProcessed: true };
    }
    console.error("[extension-credits] creditPurchase tx insert failed:", txError.message);
    return { ok: false, error: txError.message };
  }

  const current = await getOrCreateCreditBalance(args.userId);
  const newBalance = Math.round((current + args.credits) * 100) / 100;
  await db
    .from("extension_credits")
    .upsert({ user_id: args.userId, balance: newBalance, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  await db
    .from("extension_credit_transactions")
    .update({ balance_after: newBalance })
    .eq("reference", args.reference);

  return { ok: true, balance: newBalance };
}
