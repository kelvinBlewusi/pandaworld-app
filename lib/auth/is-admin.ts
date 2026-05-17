/**
 * Admin gate — controls who can trigger category sync and access the
 * admin pages.
 *
 * Membership is configured via the `ADMIN_USER_IDS` environment variable
 * — comma-separated Clerk user IDs (e.g. "user_2abc123,user_2xyz789").
 * Whitespace around the commas is tolerated.
 *
 * Why env var (vs Clerk publicMetadata.role): simpler bootstrap, no need
 * to round-trip to Clerk's API to check, and easy to update from the
 * Vercel dashboard without touching code. For a maintainer-managed app
 * with one or two admins this is the right amount of machinery.
 *
 * To find your Clerk user ID:
 *   1. Sign in to the app
 *   2. Visit /api/jumia/status (or any logged-in endpoint that logs auth())
 *      OR check the Clerk dashboard → Users → your account
 *   3. Drop the ID into Vercel → Project Settings → Environment Variables
 *      as ADMIN_USER_IDS. Redeploy.
 */

export function isAdmin(userId: string | null | undefined): boolean {
  if (!userId) return false;
  const raw = process.env.ADMIN_USER_IDS ?? "";
  if (!raw.trim()) return false;
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return ids.includes(userId);
}
