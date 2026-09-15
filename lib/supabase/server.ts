import { createClient } from "@supabase/supabase-js";

/**
 * Server client — uses the service role key and therefore bypasses RLS.
 * Only use in Server Actions / Route Handlers.
 *
 * EVERY table in this database has RLS enabled with ZERO policies — a
 * deliberate deny-all. Nothing outside the service role can read or write
 * any of them. That is the right posture, but it has a sharp edge: when a
 * caller is NOT the service role, PostgREST does not refuse it. RLS filters
 * silently, so the query answers `200 []`. An empty result and "you have no
 * access" are the same bytes.
 *
 * That edge drew blood on 2026-09-15. /api/cron/jumia-feeds returned
 * {"checked":0,"updated":0} every minute for hours while listings sat at
 * pending_approval, and the seller's statuses only ever moved when they
 * opened a page. Measured directly against the live database:
 *
 *   role            rows visible
 *   anon                       0
 *   authenticated              0
 *   service_role               2   ← the truth
 *
 * Ruled out along the way: the index (listings_status_idx already exists),
 * CDN caching (BYPASS on every tick), stale code (identical on main), and
 * the generated query (`status=eq.pending_approval&jumia_ref=not.is.null`,
 * verified correct). What is left is the key.
 *
 * So the key is now checked rather than assumed. A wrong key must announce
 * itself at construction, because downstream it is indistinguishable from
 * an empty database.
 */

/** Logged once per process rather than per call — this runs on every
 *  request, and a broken deploy would otherwise bury the logs. */
let keyWarningIssued = false;

/**
 * Decode a JWT payload without verifying it. We are not authenticating
 * anything here, only reading the `role` claim the key asserts about
 * itself, so verification would buy nothing.
 */
function roleClaimOf(key: string): string | null {
  const parts = key.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload?.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

function assertServiceRoleKey(key: string | undefined): void {
  if (keyWarningIssued) return;

  if (!key) {
    keyWarningIssued = true;
    console.error(
      "[supabase] SUPABASE_SERVICE_ROLE_KEY is not set. Every table has RLS " +
      "enabled with no policies, so all reads will return empty and all " +
      "writes will be rejected.",
    );
    return;
  }

  // Newer Supabase secret keys are opaque (sb_secret_…) rather than JWTs.
  if (key.startsWith("sb_secret_")) return;
  if (key.startsWith("sb_publishable_")) {
    keyWarningIssued = true;
    console.error(
      "[supabase] SUPABASE_SERVICE_ROLE_KEY holds a PUBLISHABLE key. RLS will " +
      "filter every query to empty rather than refusing it, so this looks " +
      "exactly like an empty database.",
    );
    return;
  }

  const role = roleClaimOf(key);
  if (role === "service_role") return;

  keyWarningIssued = true;
  if (role) {
    console.error(
      `[supabase] SUPABASE_SERVICE_ROLE_KEY carries role "${role}", not ` +
      `"service_role". RLS will filter every query to empty rather than ` +
      `refusing it, so this looks exactly like an empty database.`,
    );
  } else {
    // Not fatal and not necessarily wrong — an unrecognised format may
    // simply be a key shape we have not seen. Said once, quietly.
    console.warn("[supabase] SUPABASE_SERVICE_ROLE_KEY is in an unrecognised format — cannot confirm it grants service_role.");
  }
}

export function createServerClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  assertServiceRoleKey(key);

  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    key!,
    { auth: { persistSession: false } }
  );
}

/**
 * What the configured key actually grants, for the health check to report.
 * Returns null when it cannot be determined.
 */
export function serviceKeyRole(): string | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) return "missing";
  if (key.startsWith("sb_secret_")) return "service_role";
  if (key.startsWith("sb_publishable_")) return "publishable";
  return roleClaimOf(key);
}
