/**
 * /api/extension/keys — manage the current user's Chrome-extension API keys.
 *
 * Called from the browser dashboard (app/extension/dashboard) with a normal
 * Clerk session — NOT called by the extension itself (the extension calls
 * /api/extension/fill with the key it already has). Protected by the default
 * Clerk middleware like any other app route (not in the public allowlist).
 */

import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import {
  listExtensionApiKeys,
  createExtensionApiKey,
  revokeExtensionApiKey,
} from "@/lib/security/extension-keys";

export const runtime = "nodejs";

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const keys = await listExtensionApiKeys(userId);
  return NextResponse.json({ keys });
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let name = "Chrome Extension";
  try {
    const body = await req.json();
    if (typeof body?.name === "string" && body.name.trim()) name = body.name.trim();
  } catch {
    // no body — use the default name
  }

  const result = await createExtensionApiKey(userId, name);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ fullKey: result.fullKey, key: result.row }, { status: 201 });
}

export async function DELETE(req: Request) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const keyId = searchParams.get("keyId");
  if (!keyId) return NextResponse.json({ error: "Missing keyId" }, { status: 400 });

  const revoked = await revokeExtensionApiKey(userId, keyId);
  if (!revoked) return NextResponse.json({ error: "Key not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
