import { createServerClient } from "@/lib/supabase/server";
import { revokeToken } from "@/lib/jumia/oauth";
import { decrypt } from "@/lib/security/token-crypto";

/**
 * Erase everything belonging to one seller.
 *
 * Shared by BOTH deletion paths, which is the whole point:
 *
 *   /api/account/delete      the seller deletes their own account
 *   /api/webhooks/clerk      user.deleted — an admin deleted them in the
 *                            Clerk dashboard, or Clerk deleted them
 *
 * Only the first existed, and it was incomplete. Reported by the user and
 * confirmed against production on 2026-09-15: a Clerk account was deleted
 * from the dashboard and the WhatsApp bot carried on serving that number as
 * though nothing had happened — because deleting in Clerk did not touch
 * Supabase at all, and whatsapp_connections is what the bot resolves a
 * phone number through.
 *
 * TWO THINGS MADE THE OLD LIST WRONG, and both are worth stating because
 * they are easy to reintroduce:
 *
 * 1. It named a table that does not exist. `app_users` was in the list, and
 *    this project has NO users table — identity lives entirely in Clerk and
 *    every row here is keyed by a Clerk user_id string with no foreign key.
 *    The loop skipped "relation does not exist" errors silently, so the
 *    phantom looked like a success.
 *
 * 2. There is no referential integrity to lean on. Without a users table
 *    there are no cascades, so nothing is deleted implicitly — every table
 *    has to be named. The old list named 5; the database has 15 carrying a
 *    user_id.
 *
 * The omissions that mattered most:
 *
 *   whatsapp_connections   the bot keeps answering for a deleted account
 *   extension_api_keys     the key still authenticates /api/extension/fill
 *
 * The second is a live credential outliving its owner, which is why this
 * list is now derived from the schema rather than from memory. If you add a
 * table with a user_id, add it here.
 */

/**
 * Every table keyed by Clerk user_id, children before parents.
 *
 * Ordering still matters even without foreign keys: variants are found
 * through their listing, so they go first while that link still exists.
 */
const USER_SCOPED_TABLES = [
  // Listing data
  "variants",                      // via listing_id — must precede listings
  "jumia_live_listings",           // via listing_id — must precede listings
  "listings",
  "analysis_jobs",                 // queued work referencing those listings
  // Integrations and credentials — these outliving the account is the
  // security half of this bug, so they go early.
  "whatsapp_connections",          // the phone → account link the bot reads
  "whatsapp_sessions",             // in-flight conversation state
  "whatsapp_link_codes",           // unredeemed codes that would still link
  "extension_api_keys",            // still authenticates the extension
  "jumia_connections",
  "jumia_connect_tokens",
  // Billing and telemetry
  "extension_credits",
  "extension_credit_transactions",
  "extension_fill_events",
  "ai_usage",
  "billing_events",
  "subscriptions",
  "donations",
] as const;

/** Tables reached through the seller's listing ids rather than a user_id. */
const LISTING_SCOPED_TABLES = new Set<string>(["variants", "jumia_live_listings"]);

export interface PurgeResult {
  /** Rows removed per table, for the audit line. */
  deleted: Record<string, number>;
  /** Anything that failed. A partial purge still proceeds — leaving a
   *  credential behind is worse than leaving a telemetry row. */
  errors: string[];
}

/**
 * Revoke the seller's Jumia tokens before the rows holding them are
 * deleted. Best-effort: a revoke we cannot complete must not stop the
 * deletion, but it is attempted FIRST so a database leaked after this
 * point cannot be used against their Vendor Center.
 */
async function revokeJumiaTokens(userId: string, errors: string[]): Promise<void> {
  const db = createServerClient();
  try {
    const { data: conn } = await db
      .from("jumia_connections")
      .select("access_token, refresh_token")
      .eq("user_id", userId)
      .maybeSingle();

    if (conn?.access_token && conn.access_token !== "credential_auth") {
      try { await revokeToken(decrypt(conn.access_token as string)); }
      catch (e) { errors.push(`jumia access-token revoke: ${(e as Error).message}`); }
    }
    if (conn?.refresh_token) {
      try { await revokeToken(decrypt(conn.refresh_token as string)); }
      catch (e) { errors.push(`jumia refresh-token revoke: ${(e as Error).message}`); }
    }
  } catch (e) {
    errors.push(`jumia revoke lookup: ${(e as Error).message}`);
  }
}

/**
 * Stop the recurring charge before the row naming the subscription is
 * deleted.
 *
 * This ran only on the seller-initiated path before. The Clerk webhook did
 * not exist, so an account deleted from the Clerk dashboard kept its
 * Paystack subscription live — billing someone who no longer has an
 * account and cannot log in to stop it.
 */
async function cancelPaystackSubscription(userId: string, errors: string[]): Promise<void> {
  const db = createServerClient();
  try {
    const { data: sub } = await db
      .from("subscriptions")
      .select("paystack_subscription_code, paystack_email_token")
      .eq("user_id", userId)
      .maybeSingle();

    if (!sub?.paystack_subscription_code || !process.env.PAYSTACK_SECRET_KEY) return;

    const res = await fetch("https://api.paystack.co/subscription/disable", {
      method:  "POST",
      headers: {
        Authorization:  `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code:  sub.paystack_subscription_code,
        token: sub.paystack_email_token,
      }),
    });
    if (!res.ok) errors.push(`paystack disable: HTTP ${res.status}`);
  } catch (e) {
    errors.push(`paystack cancel: ${(e as Error).message}`);
  }
}

/**
 * Delete the seller's uploaded product images.
 *
 * Paged, because Supabase storage has no delete-by-prefix and `list`
 * returns at most 1000 entries — a seller past that would otherwise keep
 * every image beyond the first page.
 */
async function purgeStorage(userId: string, errors: string[]): Promise<void> {
  const db = createServerClient();
  try {
    let offset = 0;
    for (;;) {
      const { data: files, error: listError } = await db.storage
        .from("product-images")
        .list(userId, { limit: 1000, offset, sortBy: { column: "created_at", order: "asc" } });
      if (listError) {
        errors.push(`storage list: ${listError.message}`);
        return;
      }
      if (!files || files.length === 0) return;

      const paths = files.map((f) => `${userId}/${f.name}`);
      const { error: removeError } = await db.storage.from("product-images").remove(paths);
      if (removeError) {
        errors.push(`storage delete: ${removeError.message}`);
        return;
      }
      if (files.length < 1000) return;
      // Deleting as we go shrinks the listing, so the offset stays put —
      // advancing it here would skip a page.
      offset = 0;
    }
  } catch (e) {
    errors.push(`storage cleanup: ${(e as Error).message}`);
  }
}

/**
 * Remove every trace of `userId` from Supabase. Does NOT touch Clerk —
 * /api/account/delete deletes the Clerk user afterwards, and the
 * user.deleted webhook is reacting to a Clerk deletion that already
 * happened.
 *
 * Never throws: a caller mid-deletion needs the remaining steps to run.
 * Failures come back in `errors` for the caller to report.
 */
export async function purgeUserData(userId: string): Promise<PurgeResult> {
  const db = createServerClient();
  const errors: string[] = [];
  const deleted: Record<string, number> = {};

  await revokeJumiaTokens(userId, errors);
  await cancelPaystackSubscription(userId, errors);
  await purgeStorage(userId, errors);

  // variants and jumia_live_listings have no user_id of their own — they
  // are reached through the listings being deleted, so those ids are
  // collected while that link is still there.
  let variantListingIds: string[] = [];
  try {
    const { data } = await db.from("listings").select("id").eq("user_id", userId);
    variantListingIds = (data ?? []).map((r) => r.id as string);
  } catch (e) {
    errors.push(`listing lookup for variants: ${(e as Error).message}`);
  }

  for (const table of USER_SCOPED_TABLES) {
    try {
      const query = LISTING_SCOPED_TABLES.has(table)
        ? (variantListingIds.length > 0
            ? db.from(table).delete().in("listing_id", variantListingIds)
            : null)
        : db.from(table).delete().eq("user_id", userId);

      if (!query) continue;

      const { data, error } = await query.select("*");
      if (error) {
        errors.push(`${table}: ${error.message}`);
        continue;
      }
      if (data && data.length > 0) deleted[table] = data.length;
    } catch (e) {
      errors.push(`${table}: ${(e as Error).message}`);
    }
  }

  const summary = Object.entries(deleted).map(([t, n]) => `${t}=${n}`).join(" ") || "nothing";
  if (errors.length > 0) {
    console.error(`[purge] user ${userId}: removed ${summary}; ${errors.length} failure(s): ${errors.join("; ")}`);
  } else {
    console.info(`[purge] user ${userId}: removed ${summary}`);
  }

  return { deleted, errors };
}
