/**
 * POST /api/extension/notices/dismiss — the panel's "Got it" on a notice
 * (lib/notices.ts). Authed with the seller's API key, like
 * /api/extension/account; the dashboard bell has its own dismiss
 * (/api/extension/notifications/dismiss, Clerk session).
 */

import { NextResponse } from "next/server";
import { authenticateExtensionKey } from "@/lib/security/extension-keys";
import { dismissUserNotice } from "@/lib/notices";

export const runtime = "nodejs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  const authResult = await authenticateExtensionKey(req.headers.get("authorization"));
  if (!authResult.ok) {
    return NextResponse.json({ error: authResult.error }, { status: 401, headers: CORS });
  }

  let id: string | undefined;
  try {
    id = ((await req.json()) as { id?: string }).id;
  } catch {
    return NextResponse.json({ error: "Missing notice id" }, { status: 400, headers: CORS });
  }
  if (!id || typeof id !== "string") {
    return NextResponse.json({ error: "Missing notice id" }, { status: 400, headers: CORS });
  }

  await dismissUserNotice(authResult.userId, id);
  return NextResponse.json({ success: true }, { status: 200, headers: CORS });
}
