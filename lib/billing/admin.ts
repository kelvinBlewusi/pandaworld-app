/**
 * Admin detection — bypasses every quota check for staff / founder
 * accounts. Pure userId comparison, no Clerk round-trip, runs in O(1)
 * on every gated route call.
 *
 * Source of truth: the `ADMIN_USER_IDS` env var, a comma-separated
 * list of Clerk user ids (e.g. "user_2abc...,user_2def..."). Set it
 * in Vercel + .env.local. To find your Clerk user id, sign in to
 * Clerk Dashboard → Users → click your row → copy the `user_xxx` id.
 *
 * Why env var instead of a DB column or Clerk metadata:
 *   - No extra schema (and no migration drift when promoting an admin).
 *   - No round-trip to Clerk on every quota check.
 *   - Privileged status lives outside the app DB, so a compromised
 *     Supabase service-role key can't grant admin to anyone — they'd
 *     also need access to Vercel env.
 *
 * Note: admin is a developer/staff override, NOT a customer-facing
 * feature. The billing UI shows admin users an "Unlimited usage"
 * banner; everyone else sees standard quota bars.
 */

let _cachedAdmins: Set<string> | null = null;

function getAdminSet(): Set<string> {
  if (_cachedAdmins) return _cachedAdmins;
  const raw = process.env.ADMIN_USER_IDS ?? "";
  _cachedAdmins = new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
  return _cachedAdmins;
}

/**
 * True if the given userId is on the admin allow-list.
 * Safe to call with null / undefined / empty strings (returns false).
 */
export function isAdmin(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return getAdminSet().has(userId);
}

/**
 * Reset the in-memory cache. Useful in tests or when the env var
 * changes at runtime. Not called from production code paths.
 */
export function _resetAdminCache(): void {
  _cachedAdmins = null;
}
