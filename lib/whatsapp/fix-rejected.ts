/**
 * Fixing products Jumia's quality check rejected, from the chat (owner,
 * 2026-10-09: "can we be able to fix rejected products from the chat").
 *
 *   - "fix my rejected products": the rejected ones, each with Jumia's reason
 *     when its API gives one, as a list to tap.
 *   - One product listed through PandaWorld: its Fix & resubmit (the guided
 *     QC fix lib/whatsapp/intake.ts runs on `fix:<listingId>`): it's redrafted
 *     or asked about and sent to Jumia again as a new listing.
 *   - One listed some other way (Vendor Center, another tool): Jumia's
 *     reason is read the same way (lib/jumia/qc-remedy.ts decideQcAction),
 *     then what the API can fix is offered as a content change for one tap
 *     (POST /feeds/products/update; Jumia checks it again), what only the
 *     seller knows is asked for in the words that change it, and what the
 *     API can't change (category, main photo, price before approval) is said
 *     plainly with where to do it.
 */

import { createServerClient } from "@/lib/supabase/server";
import { sendButtonsIfConfigured, sendCtaUrlIfConfigured, sendListIfConfigured, sendTextIfConfigured } from "@/lib/whatsapp/client";
import { decideQcAction, type QcAction } from "@/lib/jumia/qc-remedy";
import { findProducts, type ShopProduct } from "@/lib/jumia/shop";
import { getCategoryByCode } from "@/lib/jumia/categories";
import { categoryDetails } from "@/lib/whatsapp/live-details";
import { CHANGES, CHANGES_FEATURE, catalog, label, proposeContentChange, shopContext, shorten } from "@/lib/whatsapp/shop";

const VENDOR_CENTER = "https://vendorcenter.jumia.com";
const REJECTED_PATH = "Products → Manage Products → Rejected";

/** What to do for one rejected product: a rewrite offered for a tap, or words to say. */
export type FixPlan =
  | { kind: "rewrite"; fields: ("name" | "description" | "highlights")[]; instructions: string; intro: string }
  | { kind: "say"; text: string; vendorCenter?: boolean };

/** The product as the seller would say it, for the words that change it: "the neck fan". */
function shortName(name: string): string {
  const words = name.replace(/[–—-].*$/, "").replace(/\(.*?\)/g, "").split(/\s+/).filter(Boolean);
  return words.slice(0, 4).join(" ").toLowerCase();
}

/** The fields Jumia's reason is about ("Wrong Title" → name). Both name and description when it doesn't say. */
export function fieldsFor(reason: string): ("name" | "description" | "highlights")[] {
  const r = reason.toLowerCase();
  const out: ("name" | "description" | "highlights")[] = [];
  if (/\b(title|name)\b/.test(r)) out.push("name");
  if (/\bdescription\b/.test(r) && !/short description/.test(r)) out.push("description");
  if (/highlight|short description|key features/.test(r)) out.push("highlights");
  return out.length > 0 ? out : ["name", "description"];
}

/** The plan for one rejected product, from what decideQcAction said. Pure. */
export function fixPlan(action: QcAction, name: string, reason: string): FixPlan {
  const short = shortName(name);
  switch (action.kind) {
    case "redraft": {
      const fields = fieldsFor(reason);
      const what = fields.map((f) => (f === "highlights" ? "highlights" : f)).join(" and ");
      return {
        kind: "rewrite", fields,
        instructions: `Fix what Jumia's quality check rejected it for${reason ? `: ${reason}` : ""}. Keep every fact that is there and add none.`,
        intro: `🔧 *${shorten(name, 60)}*: ${action.why} I've rewritten its ${what} to fix it.`,
      };
    }
    case "ask_brand":
      return { kind: "say", text: `🔍 *${shorten(name, 60)}*: Jumia's quality check says the brand is wrong${action.why}. What brand is on the product? Say e.g. "change the ${short}'s brand to Nivea", or "…to Generic" if it has none, and I'll send the fix.` };
    case "ask_value":
      return {
        kind: "say",
        text: `🔍 *${shorten(name, 60)}*: Jumia's quality check needs something only you have. ${action.question}\n\n` +
          (action.field
            ? `Send it like "the ${short}'s ${action.fieldLabel.toLowerCase()} is …" and I'll add it.`
            : `Send it like "add <it> to the ${short}'s description" and I'll add it.`),
      };
    case "ask_price":
      return { kind: "say", vendorCenter: true, text: `🔍 *${shorten(name, 60)}*: Jumia's quality check flagged the price${action.why}. Jumia only takes a price change through its API once a product has been approved, so change the price in Vendor Center (${REJECTED_PATH}) and send it for checking again there.` };
    case "ask_photos":
      return { kind: "say", vendorCenter: true, text: `📷 *${shorten(name, 60)}*: Jumia's quality check rejected the photos${action.why}. Jumia doesn't let its API change a product's main photo, so change them in Vendor Center (${REJECTED_PATH}), or list it again here with new photos (clear, well lit, plain background).` };
    case "switch_category":
      return { kind: "say", vendorCenter: true, text: `🗂️ *${shorten(name, 60)}*: Jumia's quality check says it belongs in "${action.path}". Jumia doesn't let its API move a product to another category, so change it in Vendor Center (${REJECTED_PATH}), or list it again here and I'll put it there.` };
    case "ask_category":
      return { kind: "say", vendorCenter: true, text: `🗂️ *${shorten(name, 60)}*: Jumia's quality check says the category is wrong, without saying which is right. Jumia doesn't let its API move a product to another category, so change it in Vendor Center (${REJECTED_PATH}), or list it again here in the right one.` };
    case "ask_details":
      return { kind: "say", vendorCenter: true, text: `🔍 *${shorten(name, 60)}*: Jumia's API didn't send why it was rejected. Open it in Vendor Center (${REJECTED_PATH}), copy Jumia's reason, and send it here as "fix the ${short}: <the reason>". I'll work out the fix.` };
    case "cannot_fix":
      return { kind: "say", text: `⚠️ *${shorten(name, 60)}*: ${action.why}` };
  }
}

/** The PandaWorld listing behind one of these SKUs that Jumia's check rejected, or null. */
async function pandaListing(userId: string, skus: string[]): Promise<{ id: string } | null> {
  if (skus.length === 0) return null;
  const db = createServerClient();
  const { data: direct } = await db.from("listings").select("id, status, jumia_error")
    .eq("user_id", userId).in("sku", skus).order("created_at", { ascending: false }).limit(1);
  let row = ((direct ?? []) as { id: string; status: string | null; jumia_error: string | null }[])[0] ?? null;
  if (!row) {
    const { data: v } = await db.from("variants").select("listing_id").in("seller_sku", skus).limit(5);
    const ids = Array.from(new Set(((v ?? []) as { listing_id: string }[]).map((x) => x.listing_id))).filter(Boolean);
    if (ids.length > 0) {
      const { data: viaVariant } = await db.from("listings").select("id, status, jumia_error")
        .eq("user_id", userId).in("id", ids).order("created_at", { ascending: false }).limit(1);
      row = ((viaVariant ?? []) as { id: string; status: string | null; jumia_error: string | null }[])[0] ?? null;
    }
  }
  return row && row.jumia_error ? { id: row.id } : null;
}

/** One entry per product (its sizes are one product), rejected ones only. */
function rejectedSets(products: ShopProduct[]): ShopProduct[] {
  const rejected = products.filter((p) => p.status !== "DELETED" && p.qcStatus === "REJECTED");
  return Array.from(new Map(rejected.map((p) => [p.setSid ?? p.sid, p])).values());
}

/**
 * "Fix my rejected products" / "fix the neck fan" / "fix the neck fan: <the
 * reason pasted from Vendor Center>". `query` null lists them to tap.
 */
export async function fixRejected(userId: string, phone: string, query: string | null, pasted: string | null = null): Promise<string> {
  const ctx = await shopContext(userId, phone, CHANGES_FEATURE, CHANGES);
  if (!ctx) return "blocked";
  const products = await catalog(ctx);
  if (!products) return "no catalog";
  const rejected = rejectedSets(products);

  if (!query) {
    if (rejected.length === 0) {
      await sendTextIfConfigured(phone, "✅ None of your Jumia products is rejected by Jumia's quality check right now.");
      return "none rejected";
    }
    const body = [
      `❌ ${rejected.length} product${rejected.length === 1 ? " was" : "s were"} rejected by Jumia's quality check. Tap one and I'll work out the fix:`,
      ...rejected.slice(0, 10).map((p) => `• ${shorten(label(p), 50)}${p.qcReason ? `: ${shorten(p.qcReason, 70)}` : ""}`),
      ...(rejected.length > 10 ? [`+${rejected.length - 10} more: say "fix the <name>" for any of them.`] : []),
    ].join("\n");
    await sendListIfConfigured(phone, body.slice(0, 1000), "Fix one", rejected.slice(0, 10).map((p) => ({
      id: `qcfix:${p.sellerSku}`.slice(0, 200),
      title: shorten(p.name, 24),
      description: shorten(p.qcReason ?? "Jumia didn't send the reason", 72),
    })));
    return `listed ${rejected.length} rejected`;
  }

  // The one they mean, among the rejected ones first.
  const hits = findProducts(rejected, query);
  if (hits.length === 0) {
    const any = findProducts(products, query);
    if (any.length > 0) {
      const p = any[0];
      const qc = p.qcStatus === "APPROVED" ? "approved" : p.qcStatus === "PENDING" || p.qcStatus === "NOT_READY_TO_QC" ? "waiting for Jumia's check" : (p.qcStatus ?? "not checked yet").toLowerCase();
      await sendTextIfConfigured(phone, `${shorten(label(p), 60)} isn't rejected: Jumia's quality check says ${qc}.`);
      return "not rejected";
    }
    await sendTextIfConfigured(phone, `I couldn't find "${shorten(query, 60)}" among your Jumia products. Try its name as it shows on Jumia, or say "fix my rejected products" to see them.`);
    return "not found";
  }
  const sets = Array.from(new Map(hits.map((p) => [p.setSid ?? p.sid, p])).values());
  if (sets.length > 1) {
    await sendListIfConfigured(phone, `"${shorten(query, 40)}" could be ${sets.length} rejected products. Which one?`, "Pick one",
      sets.slice(0, 10).map((p) => ({ id: `qcfix:${p.sellerSku}`.slice(0, 200), title: shorten(p.name, 24), description: shorten(p.qcReason ?? "", 72) })));
    return `fix unclear: ${sets.length}`;
  }
  const product = sets[0];
  const skus = products.filter((p) => (p.setSid ?? p.sid) === (product.setSid ?? product.sid)).map((p) => p.sellerSku);

  // Listed through PandaWorld: its own guided fix, which sends it again.
  const listing = await pandaListing(userId, skus);
  if (listing) {
    await sendButtonsIfConfigured(phone,
      `🔧 *${shorten(product.name, 60)}* was listed through PandaWorld${product.qcReason ? `, and Jumia's quality check rejected it: ${shorten(product.qcReason, 200)}` : ""}. Tap Fix & resubmit: I'll work out what Jumia wants, ask you for anything only you know, and send it again.`,
      [{ id: `fix:${listing.id}`, title: "Fix & resubmit" }]);
    return "offered panda fix";
  }

  const reason = [pasted?.trim(), product.qcReason].filter(Boolean).join(". ") || null;
  const code = product.categoryCode ? Number(product.categoryCode) : NaN;
  const [category, attrs] = Number.isFinite(code)
    ? await Promise.all([getCategoryByCode(code).catch(() => null), categoryDetails(ctx.token, code).catch(() => [])])
    : [null, []];
  const decided = await decideQcAction({
    reason, comment: null, title: product.name, brand: product.brand, categoryPath: category?.path ?? null,
    fields: attrs.map((a) => ({ name: a.name, label: a.label ?? null })),
  });
  const plan = fixPlan(decided.action, product.name, reason ?? "");
  console.info(`[qc-chat] ${product.sellerSku}: ${decided.action.kind} (${decided.source})`);
  if (plan.kind === "say") {
    if (plan.vendorCenter) await sendCtaUrlIfConfigured(phone, plan.text, "Vendor Center", VENDOR_CENTER);
    else await sendTextIfConfigured(phone, plan.text);
    return `fix: ${decided.action.kind}`;
  }
  await sendTextIfConfigured(phone, `${plan.intro} Check it below, then tap Yes to send it to Jumia, which checks it again.`);
  const offered = await proposeContentChange(userId, phone, product.sellerSku, { rewrite: plan.fields, instructions: plan.instructions });
  return `fix: rewrite (${offered})`;
}

/** A tap on the rejected list (`qcfix:<sku>`), or null when it isn't one. Cheap: no I/O. */
export function parseFixTap(text: string | undefined): string | null {
  const m = (text ?? "").trim().match(/^qcfix:(\S{1,190})$/i);
  return m ? m[1] : null;
}
