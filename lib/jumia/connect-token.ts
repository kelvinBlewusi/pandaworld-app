import { createServerClient } from "@/lib/supabase/server";

/**
 * One-time tokens that let a WhatsApp-originated link kick off the Jumia
 * OAuth authorize redirect without an active Clerk browser session — see
 * supabase/migrations/2026-09-12_whatsapp-jumia-connect.sql for the schema
 * and the security reasoning (short-lived, single-use, only ever triggers
 * a redirect to Jumia's own login page).
 */

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

export async function createConnectToken(userId: string): Promise<string> {
  const db = createServerClient();
  const token = crypto.randomUUID();
  const { error } = await db.from("jumia_connect_tokens").insert({
    token,
    user_id: userId,
    expires_at: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
  });
  if (error) throw new Error(`Failed to create Jumia connect token: ${error.message}`);
  return token;
}

/** Validate + burn a token, returning the userId it was issued for, or null. */
export async function redeemConnectToken(token: string): Promise<string | null> {
  const db = createServerClient();
  const { data: row } = await db
    .from("jumia_connect_tokens")
    .select("user_id, expires_at, used_at")
    .eq("token", token)
    .maybeSingle();

  if (!row || row.used_at) return null;
  if (new Date(row.expires_at as string) < new Date()) return null;

  await db.from("jumia_connect_tokens").update({ used_at: new Date().toISOString() }).eq("token", token);
  return row.user_id as string;
}
