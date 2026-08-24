/**
 * /api/extension/keys — the current user's fixed Chrome-extension API key.
 *
 * Called from the browser dashboard (app/extension/(app)) with a normal
 * Clerk session — NOT called by the extension itself (the extension calls
 * /api/extension/fill with the key it already has). Protected by the default
 * Clerk middleware like any other app route (not in the public allowlist).
 *
 * Every seller has exactly one fixed key (lib/security/extension-keys.ts) —
 * GET fetches or provisions it, POST replaces it (used by the dashboard's
 * "Regenerate key" action). There's no create/list/revoke-by-id surface
 * here anymore; the dashboard page fetches the key server-side on load, so
 * GET mainly exists for the client-side regenerate flow to re-read state.
 */

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  getOrCreateExtensionApiKey,
  regenerateExtensionApiKey,
} from "@/lib/security/extension-keys";

export const runtime = "nodejs";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await getOrCreateExtensionApiKey(userId);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ fullKey: result.fullKey, key: result.row });
}

export async function POST() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const result = await regenerateExtensionApiKey(userId);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }
  return NextResponse.json({ fullKey: result.fullKey, key: result.row });
}
