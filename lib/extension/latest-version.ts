/**
 * The newest extension version published on the Chrome Web Store, told to
 * the panel with the account (GET /api/extension/account ->
 * latestExtensionVersion). A panel older than it shows "A new version is
 * available" (extension/panel/panel.js, from 0.2.57).
 *
 * Kept in app_settings, key extension_latest_version, rather than in code,
 * so it's set when the Store has actually published a version: a deploy
 * can't tell sellers to update to a version Chrome can't give them yet. Set
 * by hand after publishing:
 *
 *   insert into app_settings (key, value) values ('extension_latest_version', '"0.2.58"')
 *   on conflict (key) do update set value = excluded.value, updated_at = now();
 *
 * Unset means no banner.
 */

import { createServerClient } from "@/lib/supabase/server";

const KEY = "extension_latest_version";

/** "0.2.58"-style: two to four dot-separated numbers. Anything else is ignored. */
const VERSION_RE = /^\d+(\.\d+){1,3}$/;

export async function latestExtensionVersion(): Promise<string | null> {
  try {
    const { data, error } = await createServerClient().from("app_settings").select("value").eq("key", KEY).maybeSingle();
    if (error) throw new Error(error.message);
    const value = data?.value;
    return typeof value === "string" && VERSION_RE.test(value) ? value : null;
  } catch (e) {
    // Never fail the panel's status call over a banner.
    console.warn(`[extension] couldn't read the latest extension version: ${(e as Error).message}`);
    return null;
  }
}
