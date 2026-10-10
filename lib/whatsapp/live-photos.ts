/**
 * More photos for a live Jumia product, from the chat (owner, 2026-10-09:
 * "a live product's extra photos - let's do this").
 *
 *   1. "Add photos to the neck fan": the product is found, its photos read
 *      from Jumia (at most MAX_PRODUCT_IMAGES), and the seller asked for the
 *      new ones. The change waits in jumia_product_changes ('collecting').
 *   2. Each photo they send is kept (live_photo_uploads, one row each: an
 *      album arrives as several deliveries at once).
 *   3. "Done": the photos become the change, offered for one tap like every
 *      live change, and sent as an update feed with the product's photos
 *      first and these after (lib/jumia/shop.ts withImages). Jumia doesn't
 *      let its API change the main photo, so the main one stays first.
 */

import { createServerClient } from "@/lib/supabase/server";
import { sendButtonsIfConfigured, sendTextIfConfigured } from "@/lib/whatsapp/client";
import { ingestWhatsAppImage } from "@/lib/whatsapp/media";
import { updateSession, type AddPhotosAsk } from "@/lib/whatsapp/session";
import { MAX_PRODUCT_IMAGES, fetchProductSet, findProducts, fromRow, type LiveChange } from "@/lib/jumia/shop";
import { CHANGES, CHANGES_FEATURE, catalog, offerChange, sendLong, shopContext, shorten } from "@/lib/whatsapp/shop";

/** Photos not finished in this long are let go. */
const PHOTOS_TTL_MS = 30 * 60_000;
const DONE = { id: "done", title: "Done ✅" };
const DONE_RE = /^(done|finished|that'?s all|that'?s it|ok done|send|send them)[.!]*$/i;
const STOP_RE = /^(cancel|stop|never ?mind|forget it|no|not now|leave it)[.!]*$/i;

/** "Add photos to the neck fan": asks for them, and waits. */
export async function startAddPhotos(userId: string, phone: string, query: string): Promise<string> {
  const ctx = await shopContext(userId, phone, CHANGES_FEATURE, CHANGES);
  if (!ctx) return "blocked";
  const products = await catalog(ctx);
  if (!products) return "no catalog";
  const found = findProducts(products, query);
  if (found.length === 0) {
    await sendTextIfConfigured(phone, `I couldn't find "${shorten(query, 60)}" among your Jumia products. Try its name as it shows on Jumia, or its SKU.`);
    return "not found";
  }
  const sets = Array.from(new Map(found.map((p) => [p.setSid ?? p.sid, p])).values());
  if (sets.length > 1) {
    await sendLong(phone, [
      `"${shorten(query, 40)}" could be ${sets.length} products. Which one gets the photos?`,
      ...sets.slice(0, 6).map((p) => `• ${shorten(p.name, 60)} (SKU ${p.sellerSku})`),
      "", "Say it again with its name as it shows on Jumia, or its SKU.",
    ].join("\n"));
    return `add photos unclear: ${sets.length}`;
  }
  const product = sets[0];
  const set = await fetchProductSet(ctx.token, product.sellerSku);
  if (!set.ok || !set.data) {
    await sendTextIfConfigured(phone, `I couldn't read ${shorten(product.name, 60)} from Jumia just now${set.ok ? "" : `: ${set.message}`}. Try again in a minute.`);
    return "set unreadable";
  }
  const have = set.data.images.length;
  const room = MAX_PRODUCT_IMAGES - have;
  if (room <= 0) {
    await sendTextIfConfigured(phone, `${shorten(product.name, 60)} already has ${have} photos, the most Jumia takes. Jumia doesn't let its API remove or swap photos, so that's done in Vendor Center.`);
    return "photos full";
  }
  const change: LiveChange = { kind: "content", fields: { images: [] } };
  const { data, error } = await createServerClient().from("jumia_product_changes").insert({
    id: crypto.randomUUID(), user_id: userId, product_sid: product.sid, seller_sku: product.sellerSku, name: product.name,
    change, candidates: null, status: "collecting",
  }).select("id").single();
  if (error || !data) {
    await sendTextIfConfigured(phone, "I couldn't get that ready just now. Ask again in a moment.");
    return `failed: ${error?.message ?? "no row"}`;
  }
  const ask: AddPhotosAsk = { kind: "add_photos", changeId: (data as { id: string }).id, name: product.name, room, at: new Date().toISOString() };
  await updateSession(phone, { assistantPending: ask });
  await sendButtonsIfConfigured(phone,
    `📷 Send up to ${room} more photo${room === 1 ? "" : "s"} for *${shorten(product.name, 80)}* (it has ${have}). Clear, well lit, plain background, no watermarks. ` +
    "Its main photo stays first: Jumia doesn't let its API change that one. Tap Done when they're all here.",
    [DONE]);
  return `asked for photos (${room}) for ${product.sellerSku}`;
}

/** The photos so far, oldest first. */
async function uploads(changeId: string): Promise<string[]> {
  const { data } = await createServerClient().from("live_photo_uploads").select("url").eq("change_id", changeId).order("id", { ascending: true });
  return ((data ?? []) as { url: string }[]).map((r) => r.url);
}

async function letGo(phone: string, ask: AddPhotosAsk): Promise<void> {
  await updateSession(phone, { assistantPending: null });
  await createServerClient().from("jumia_product_changes")
    .update({ status: "cancelled", updated_at: new Date().toISOString() }).eq("id", ask.changeId).eq("status", "collecting");
}

/**
 * A message while photos are asked for: a photo (kept), "done" (offered for
 * the tap), "stop". False for anything else: the question is let go and the
 * message handled as usual.
 */
export async function answerAddPhotos(
  userId: string, phone: string, ask: AddPhotosAsk, content: { text?: string; imageMediaId?: string },
): Promise<boolean> {
  if (Date.now() - new Date(ask.at).getTime() > PHOTOS_TTL_MS) {
    await letGo(phone, ask);
    return false;
  }
  const db = createServerClient();
  if (content.imageMediaId) {
    const url = await ingestWhatsAppImage(content.imageMediaId, userId);
    if (!url) {
      await sendTextIfConfigured(phone, "⚠️ That photo didn't come through cleanly (unsupported format or too large). Try another one.");
      return true;
    }
    await db.from("live_photo_uploads").insert({ change_id: ask.changeId, user_id: userId, url });
    const { count } = await db.from("live_photo_uploads").select("id", { count: "exact", head: true }).eq("change_id", ask.changeId);
    if (count === 1 && ask.room > 1) await sendButtonsIfConfigured(phone, "📷 Got it. Send any more, then tap Done.", [DONE]);
    else if (count === ask.room) await sendButtonsIfConfigured(phone, `That's ${ask.room}, as many as it can take. Tap Done.`, [DONE]);
    else if (count != null && count > ask.room && count === ask.room + 1) await sendButtonsIfConfigured(phone, `It can only take ${ask.room} more, so I'll use the first ${ask.room}. Tap Done.`, [DONE]);
    return true;
  }
  const text = content.text?.trim() ?? "";
  if (STOP_RE.test(text)) {
    await letGo(phone, ask);
    await sendTextIfConfigured(phone, "OK, no photos added.");
    return true;
  }
  if (!DONE_RE.test(text)) {
    await letGo(phone, ask);
    return false;
  }
  const photos = (await uploads(ask.changeId)).slice(0, ask.room);
  if (photos.length === 0) {
    await sendButtonsIfConfigured(phone, `I haven't got any photos for ${shorten(ask.name, 60)} yet. Send them, then tap Done.`, [DONE]);
    return true;
  }
  await updateSession(phone, { assistantPending: null });
  const change: LiveChange = { kind: "content", fields: { images: photos } };
  const { data: row } = await db.from("jumia_product_changes")
    .update({ change, status: "pending", created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq("id", ask.changeId).eq("status", "collecting").select("product_sid").maybeSingle();
  const sid = (row as { product_sid?: string } | null)?.product_sid;
  const { data: prow } = sid ? await db.from("jumia_products").select("*").eq("user_id", userId).eq("product_sid", sid).maybeSingle() : { data: null };
  if (!prow) {
    await sendTextIfConfigured(phone, "I couldn't find that product any more. Ask again to add the photos.");
    return true;
  }
  await offerChange(userId, phone, ask.changeId, fromRow(prow as Record<string, unknown>), change);
  return true;
}
