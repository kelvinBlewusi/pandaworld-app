"use server";

/**
 * Extension credit ledger — a separate, never-expiring balance for the
 * Chrome extension's autofill flow (app/api/extension/fill/route.ts),
 * independent from the classic app's plan-based monthly quota
 * (lib/billing/quota.ts). See supabase/migrations/2026-08-24_extension-
 * credits.sql and docs/chrome-extension-plan.md §10 update.
 */

import { createServerClient } from "@/lib/supabase/server";
import { FREE_SIGNUP_CREDITS } from "@/lib/billing/credit-packs";

/**
 * Reads the user's credit balance, provisioning the free sign-up grant the
 * first time anyone asks (dashboard load, fill request, or the Clerk
 * user.created webhook — whichever happens first). The insert is guarded
 * by the table's primary key, so a race between two of those doesn't
 * double-grant: the loser's insert fails and we just re-read the winner's row.
 */
export async function getOrCreateCreditBalance(userId: string): Promise<number> {
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
    description: "Welcome bonus — 5 free credits",
  });

  return FREE_SIGNUP_CREDITS;
}

/** Spend credits for one extension autofill. */
export async function deductCredits(
  userId: string,
  amount: number,
  description: string,
): Promise<{ ok: true; balance: number } | { ok: false; error: string; balance: number }> {
  const db = createServerClient();
  const balance = await getOrCreateCreditBalance(userId);
  if (balance < amount) {
    return { ok: false, error: "insufficient_credits", balance };
  }
  const newBalance = Math.round((balance - amount) * 100) / 100;
  const { error } = await db
    .from("extension_credits")
    .update({ balance: newBalance, updated_at: new Date().toISOString() })
    .eq("user_id", userId);
  if (error) {
    console.error("[extension-credits] deduct failed:", error.message);
    return { ok: false, error: "db_error", balance };
  }
  await db.from("extension_credit_transactions").insert({
    user_id: userId,
    type: "deduction",
    amount: -amount,
    balance_after: newBalance,
    description,
  });
  return { ok: true, balance: newBalance };
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
