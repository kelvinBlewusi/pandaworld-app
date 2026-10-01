import { NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isAdmin } from "@/lib/auth/is-admin";
import { getValidJumiaCredentials } from "@/lib/jumia/api";
import { JUMIA_API_BASE } from "@/lib/jumia/oauth";

// ─── GET /api/admin/jumia/diagnose-categories ─────────────────────────────────
// Phase 2 diagnostic — tests correct endpoints after learning from phase 1:
//  1. GET /catalog/categories?parentCode={rootCode}  (children of root)
//  2. GET /catalog/attribute-sets/{sid}              (attributes via attributeSet.sid)
//  3. GET /catalog/attribute-sets/{sid}/attributes   (alternative)
//  4. GET /catalog/categories?parentCode={childCode} (grandchildren — are there more levels?)

export async function GET() {
  const { userId } = await auth();
  if (!userId) return new NextResponse("Unauthorized", { status: 401 });
  if (!isAdmin(userId)) return NextResponse.json({ error: "Admin only" }, { status: 403 });

  let accessToken: string;
  try {
    ({ accessToken } = await getValidJumiaCredentials(userId));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 403 });
  }

  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
  const results: Record<string, unknown> = {};

  // ── 1. Get root categories + their attributeSet sids ─────────────────────
  const rootRes = await fetch(`${JUMIA_API_BASE}/catalog/categories`, { headers });
  const rootRaw = await rootRes.json() as Record<string, unknown>;
  const rootList = (Array.isArray(rootRaw) ? rootRaw : (rootRaw.categories ?? [])) as Record<string, unknown>[];

  // Pick "Electronics" (code 1000004) as our test case — always has good subcategories
  const electronics = rootList.find((c) => c.code === 1000004) ?? rootList[0];
  const rootCode    = electronics?.code as number;
  const attrSetSid  = (electronics?.attributeSet as Record<string, unknown>)?.sid as string;

  results.root_sample = { code: rootCode, name: electronics?.name, attrSetSid };

  // ── 2. Fetch children of Electronics ─────────────────────────────────────
  try {
    const url = `${JUMIA_API_BASE}/catalog/categories?parentCode=${rootCode}`;
    const res = await fetch(url, { headers });
    const text = await res.text();
    results.children_url    = url;
    results.children_status = res.status;
    results.children_raw    = text.slice(0, 1200);
  } catch (e) { results.children_error = (e as Error).message; }

  // ── 3. Try attributeSet sid endpoint ─────────────────────────────────────
  if (attrSetSid) {
    // 3a. /catalog/attribute-sets/{sid}
    try {
      const url = `${JUMIA_API_BASE}/catalog/attribute-sets/${attrSetSid}`;
      const res = await fetch(url, { headers });
      const text = await res.text();
      results.attrset_v1_url    = url;
      results.attrset_v1_status = res.status;
      results.attrset_v1_raw    = text.slice(0, 1200);
    } catch (e) { results.attrset_v1_error = (e as Error).message; }

    // 3b. /catalog/attribute-sets/{sid}/attributes
    try {
      const url = `${JUMIA_API_BASE}/catalog/attribute-sets/${attrSetSid}/attributes`;
      const res = await fetch(url, { headers });
      const text = await res.text();
      results.attrset_v2_url    = url;
      results.attrset_v2_status = res.status;
      results.attrset_v2_raw    = text.slice(0, 1200);
    } catch (e) { results.attrset_v2_error = (e as Error).message; }

    // 3c. /catalog/attributeSets/{sid} (camelCase variant)
    try {
      const url = `${JUMIA_API_BASE}/catalog/attributeSets/${attrSetSid}`;
      const res = await fetch(url, { headers });
      const text = await res.text();
      results.attrset_v3_url    = url;
      results.attrset_v3_status = res.status;
      results.attrset_v3_raw    = text.slice(0, 1200);
    } catch (e) { results.attrset_v3_error = (e as Error).message; }
  }

  // ── 4. Try fetching grandchildren (children of first child) ──────────────
  try {
    const childRes  = await fetch(`${JUMIA_API_BASE}/catalog/categories?parentCode=${rootCode}`, { headers });
    if (childRes.ok) {
      const childRaw  = await childRes.json() as Record<string, unknown>;
      const childList = (Array.isArray(childRaw) ? childRaw : (childRaw.categories ?? [])) as Record<string, unknown>[];
      const firstChild = childList[0];
      results.first_child = firstChild;

      if (firstChild?.code) {
        const grandUrl = `${JUMIA_API_BASE}/catalog/categories?parentCode=${firstChild.code}`;
        const grandRes = await fetch(grandUrl, { headers });
        const grandText = await grandRes.text();
        results.grandchildren_url    = grandUrl;
        results.grandchildren_status = grandRes.status;
        results.grandchildren_raw    = grandText.slice(0, 800);
      }
    }
  } catch (e) { results.grandchildren_error = (e as Error).message; }

  return NextResponse.json(results, { status: 200 });
}
