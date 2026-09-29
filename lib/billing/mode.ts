/**
 * The billing switch: free for everyone, or charge credits.
 *
 * Off: every signed-in seller drafts and autofills without spending
 * anything; the credit ledger isn't touched, so balances stay exactly
 * where they were. On: extension autofills and WhatsApp / web drafts cost
 * credits (lib/billing/credit-packs.ts), sellers who run out are sent to
 * buy a pack, and the public site shows pricing.
 *
 * Stored in app_settings (supabase/migrations/2026-09-28_app-settings-
 * billing-switch.sql) and flipped from /admin/billing, so starting to bill
 * is one button rather than a code change and redeploy. Replaces the
 * FREE_FOR_ALL_MODE constant (2026-09-13 to 2026-09-28).
 *
 * Read on every metered request and public page, so each server instance
 * caches it for CACHE_MS: a flip reaches every instance within that
 * window (the instance that flips it sees it at once). Five minutes, not
 * the 30 seconds it started at: at 30s these reads were ~90% of the
 * project's idle Supabase API traffic, each one a ~2.7 KB entry in
 * Supabase's metered log ingest, for a switch flipped a handful of times
 * ever. If the
 * setting can't be read, the last value this instance saw is kept, and an
 * instance that never read it stays free: a settings outage must not lock
 * sellers out of their listings.
 */

import { createServerClient } from "@/lib/supabase/server";

const KEY = "billing_enabled";
const CACHE_MS = 5 * 60_000;

let cached: { on: boolean; at: number } | null = null;

export async function isBillingEnabled(): Promise<boolean> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.on;
  try {
    const db = createServerClient();
    const { data, error } = await db.from("app_settings").select("value").eq("key", KEY).maybeSingle();
    if (error) throw new Error(error.message);
    const on = data?.value === true;
    cached = { on, at: Date.now() };
    return on;
  } catch (e) {
    console.warn(`[billing] couldn't read the billing switch, staying ${cached?.on ? "on" : "free"}: ${(e as Error).message}`);
    return cached?.on ?? false;
  }
}

/** Flip the switch. Admin-only: callers check isAdmin first. */
export async function setBillingEnabled(on: boolean, adminUserId: string): Promise<void> {
  const db = createServerClient();
  const { error } = await db.from("app_settings").upsert(
    { key: KEY, value: on, updated_at: new Date().toISOString(), updated_by: adminUserId },
    { onConflict: "key" },
  );
  if (error) throw new Error(`Couldn't change the billing switch: ${error.message}`);
  cached = { on, at: Date.now() };
}

/** When the switch last changed and who changed it, for the admin page. */
export async function billingSwitchInfo(): Promise<{ on: boolean; updatedAt: string | null; updatedBy: string | null }> {
  const db = createServerClient();
  const { data } = await db.from("app_settings").select("value, updated_at, updated_by").eq("key", KEY).maybeSingle();
  return { on: data?.value === true, updatedAt: data?.updated_at ?? null, updatedBy: data?.updated_by ?? null };
}

/** Test hook: forget the cached value. */
export function _resetBillingModeCache(): void {
  cached = null;
}
