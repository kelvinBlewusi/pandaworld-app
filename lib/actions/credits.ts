"use server";

/**
 * The signed-in seller's credits, for client components (the web app's
 * sidebar chip and account page). Server action scoped to auth()'s user,
 * so it can only ever read the caller's own balance.
 */

import { auth } from "@clerk/nextjs/server";
import { isAdmin } from "@/lib/auth/is-admin";
import { getOrCreateCreditBalance } from "@/lib/billing/extension-credits";
import { serializeCredits } from "@/lib/billing/credit-packs";

export interface MyCredits {
  /** null when unlimited (admins, and everyone while billing is off). */
  credits:   number | null;
  unlimited: boolean;
  isAdmin:   boolean;
}

export async function getMyCredits(): Promise<MyCredits | null> {
  const { userId } = await auth();
  if (!userId) return null;
  const { value, unlimited } = serializeCredits(await getOrCreateCreditBalance(userId));
  return { credits: value, unlimited, isAdmin: isAdmin(userId) };
}
