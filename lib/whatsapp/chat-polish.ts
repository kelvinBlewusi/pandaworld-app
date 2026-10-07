/**
 * Image polish in the chat (owner, 2026-10-07): four product photos made
 * from the seller's own (lib/gemini-image.ts PRODUCT_SHOTS: main on white,
 * angle, lifestyle, detail), the same as the extension's Polish images, for
 * a product being listed from WhatsApp or the Jumia Listing Assistant.
 *
 *   - From the seller's note: when it asks for the photos to be polished
 *     ("polish the pictures", "white background"), read by the note pass
 *     with the seller's own words as proof (note-intent.ts polish_images),
 *     the listing is queued at drafting (queuePolish) and polished by
 *     app/api/worker/polish-images ("when inferred and executed from the
 *     user's note let it be billed accordingly"). No ask, no polish.
 *   - On request: "polish 2" (the /polish command), any time before the
 *     product is submitted.
 *
 * POLISH_CREDIT_COST an image that came back, on every plan; checked for
 * all four first, charged once per request (`polish:<id>:<requested_at>`).
 * The new photos replace the seller's own on the listing (owner,
 * 2026-10-07: "it must replace them entirely"); original_images keeps the
 * seller's as they were. The reply says nothing of the credits it took on
 * the web (owner, 2026-10-07: "don't mention credit spent after an
 * action"); WhatsApp's still says, as each reply there does. A product
 * already with Jumia isn't polished (its photos change in Vendor Center),
 * and one whose photos are still being polished isn't submitted until
 * they're done (lib/jumia/push-listing.ts).
 */

import { createServerClient } from "@/lib/supabase/server";
import { POLISH_CREDIT_COST } from "@/lib/billing/credit-packs";
import { availableCredits, chargeService } from "@/lib/billing/extension-credits";
import { generateProductShots, isGeminiImageEnabled, PRODUCT_SHOTS } from "@/lib/gemini-image";
import { resolveOneImage } from "@/lib/extension/harvested-images";
import { chatAddressFor } from "@/lib/jumia/push-listing";
import { isWebAddress } from "@/lib/whatsapp/channel";
import { sendCtaUrlIfConfigured, sendImageIfConfigured, sendTextIfConfigured } from "@/lib/whatsapp/client";
import { buyCreditsUrl } from "@/lib/whatsapp/batch";
import { appUrl } from "@/lib/whatsapp/app-url";

/** What four images cost. */
export const POLISH_COST = PRODUCT_SHOTS.length * POLISH_CREDIT_COST;

/** Statuses a product's photos can still be changed in: not sent to Jumia yet. */
const EDITABLE = new Set(["draft", "awaiting_review", "failed"]);
/** Photos the model is given: enough angles to get it right, few enough to be quick. */
const MAX_SOURCES = 3;
/** Jumia takes up to 8 images a product. */
const MAX_IMAGES = 8;
/** A polish still "running" after this was cut off (the function's time ran out): it can run again. */
export const POLISH_STALE_MS = 5 * 60_000;

export interface PolishRow {
  id: string; user_id: string; whatsapp_seq: number | null; title: string | null; user_prompt: string | null;
  images: string[] | null; original_images: string[] | null; status: string; chat_channel: string | null;
  polish_status: string | null; polish_requested_at: string | null; updated_at?: string | null;
}
const COLUMNS = "id, user_id, whatsapp_seq, title, user_prompt, images, original_images, status, chat_channel, polish_status, polish_requested_at, updated_at";

export type PolishOutcome = "done" | "failed" | "skipped" | "busy" | "missing";

const productName = (row: PolishRow) => (row.whatsapp_seq ? `Product ${row.whatsapp_seq}` : `"${row.title ?? "your product"}"`);

/**
 * Queue a listing's photos for polishing, from the seller's note at
 * drafting. Only once: a listing polished, or refused, before isn't queued
 * again by drafting (a redraft reads the same note). True when queued now.
 */
export async function queuePolish(listingId: string): Promise<boolean> {
  const { data } = await createServerClient()
    .from("listings")
    .update({ polish_status: "queued", polish_requested_at: new Date().toISOString() })
    .eq("id", listingId)
    .is("polish_status", null)
    .select("id");
  return ((data ?? []) as unknown[]).length > 0;
}

/** Start the polish worker now rather than at pg_cron's next minute. Never throws. */
export async function nudgePolishWorker(): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  try {
    await fetch(`${appUrl()}/api/worker/polish-images`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(2_000),
    });
  } catch {
    // Timed out (it's working, which is the point) or unreachable: pg_cron picks it up within the minute.
  }
}

/**
 * "polish 2": polish that product of the batch now, whatever was asked
 * before (a polish that failed or ran out of credits can be asked again).
 */
export async function polishOnRequest(userId: string, phone: string, listingId: string): Promise<PolishOutcome> {
  const db = createServerClient();
  const { data } = await db.from("listings").select(COLUMNS).eq("id", listingId).eq("user_id", userId).maybeSingle();
  const row = data as PolishRow | null;
  if (!row) return "missing";
  if (row.polish_status === "running" && !isStale(row)) {
    await sendTextIfConfigured(phone, `✨ ${productName(row)}'s photos are being polished already: they'll be here in a moment.`);
    return "busy";
  }
  await db.from("listings").update({ polish_status: "queued", polish_requested_at: new Date().toISOString() }).eq("id", listingId);
  return polishListing(listingId, phone);
}

/** A run is stamped (updated_at) when it's claimed: one older than POLISH_STALE_MS was cut off. */
const isStale = (row: { updated_at?: string | null }) =>
  !row.updated_at || Date.now() - new Date(row.updated_at).getTime() > POLISH_STALE_MS;

/**
 * Polish one queued listing: claims it (so two workers never both pay for
 * it), checks it can still be polished and paid for, makes the four
 * photos, charges for those that came back, puts them first on the
 * listing and tells the seller where they're chatting. `phone` is where to
 * tell them; null works it out from the listing.
 */
export async function polishListing(listingId: string, phone: string | null = null): Promise<PolishOutcome> {
  const db = createServerClient();
  const { data: claimed } = await db
    .from("listings")
    .update({ polish_status: "running", updated_at: new Date().toISOString() })
    .eq("id", listingId)
    .eq("polish_status", "queued")
    .select(COLUMNS);
  const row = ((claimed ?? []) as PolishRow[])[0];
  if (!row) return "busy";
  const to = phone ?? (await chatAddressFor(row.user_id, row.chat_channel).catch(() => null));
  const say = async (text: string) => { if (to) await sendTextIfConfigured(to, text); };
  const finish = (status: "done" | "failed" | "skipped", patch: Record<string, unknown> = {}) =>
    db.from("listings").update({ polish_status: status, ...patch }).eq("id", listingId);
  const name = productName(row);

  if (!EDITABLE.has(row.status)) {
    await finish("skipped");
    await say(`${name} is already with Jumia, so its photos weren't polished: photos of a product on Jumia are changed in Vendor Center.`);
    return "skipped";
  }
  const originals = (row.original_images ?? row.images ?? []).filter(Boolean);
  if (originals.length === 0) {
    await finish("skipped");
    await say(`${name} has no photos to polish yet. Send its photos, then *polish ${row.whatsapp_seq ?? ""}*.`.replace(" *polish *", " *polish*"));
    return "skipped";
  }
  const available = await availableCredits(row.user_id);
  if (available < POLISH_COST) {
    await finish("skipped");
    const shown = Math.max(0, Math.round(available * 100) / 100);
    const text = `📸 Polishing ${name}'s photos makes ${PRODUCT_SHOTS.length} images at ${POLISH_CREDIT_COST} credits each (${POLISH_COST}), and you have ${shown}. ` +
      `Your own photos stay on it. Buy credits, then send *polish${row.whatsapp_seq ? ` ${row.whatsapp_seq}` : ""}*.`;
    if (to) await sendCtaUrlIfConfigured(to, text, "Buy credits", buyCreditsUrl());
    return "skipped";
  }
  if (!isGeminiImageEnabled()) {
    await finish("failed");
    await say(`I couldn't polish ${name}'s photos just now. Nothing was charged.`);
    return "failed";
  }

  if (to) await sendTextIfConfigured(to, `✨ Polishing ${name}'s photos: ${PRODUCT_SHOTS.length} new ones from yours, about 30 seconds…`);
  const sources = (await Promise.all(originals.slice(0, MAX_SOURCES).map((url) => resolveOneImage({ imageUrl: url }))))
    .filter((s): s is { base64: string; mimeType: string } => s !== null);
  if (sources.length === 0) {
    await finish("failed");
    await say(`I couldn't read ${name}'s photos to polish them. Nothing was charged.`);
    return "failed";
  }
  const context = [row.title, row.user_prompt].filter(Boolean).join(". ").slice(0, 500) || undefined;
  const shots = await generateProductShots(sources.map((s) => ({ mimeType: s.mimeType, data: s.base64 })), row.user_id, { productContext: context, timeoutMs: 45_000 });
  const made = shots.filter((s): s is typeof s & { url: string } => typeof s.url === "string");
  if (made.length === 0) {
    await finish("failed");
    await say(`I couldn't polish ${name}'s photos just now (${shots[0]?.error ?? "the image service didn't answer"}). Nothing was charged: try *polish${row.whatsapp_seq ? ` ${row.whatsapp_seq}` : ""}* again in a minute.`);
    return "failed";
  }

  // Images that didn't come back are free.
  const cost = made.length * POLISH_CREDIT_COST;
  const charged = await chargeService(row.user_id, cost, `polish:${row.id}:${row.polish_requested_at ?? ""}`, `Polished ${made.length} photo${made.length === 1 ? "" : "s"} of ${name.toLowerCase().startsWith("product") ? name.toLowerCase() : name} in chat`);
  if (!charged.ok) {
    await finish("skipped");
    await say(`I couldn't take the ${cost} credits for ${name}'s polished photos, so its own photos stay on it. Nothing was charged.`);
    return "skipped";
  }

  const images = made.map((s) => s.url).slice(0, MAX_IMAGES);
  await finish("done", { images, original_images: originals });
  if (to) {
    const spent = isWebAddress(to) ? "" : `, ${cost} credits`;
    const caption = `✨ ${name}: ${made.length} polished photo${made.length === 1 ? "" : "s"} (${made.map((s) => s.label.toLowerCase()).join(", ")})${spent}. ` +
      `They replace your own photos on its listing.`;
    // Each photo is a paid message on WhatsApp: the main one there, all of them here.
    const shown = isWebAddress(to) ? made : made.slice(0, 1);
    for (let i = 0; i < shown.length; i++) await sendImageIfConfigured(to, shown[i].url, i === 0 ? caption : undefined);
  }
  return "done";
}

/** The listings waiting for the worker: queued, or running so long they were cut off. */
export async function polishQueue(limit: number): Promise<string[]> {
  const db = createServerClient();
  const { data } = await db.from("listings").select("id, polish_status, updated_at").in("polish_status", ["queued", "running"]).limit(50);
  const rows = (data ?? []) as { id: string; polish_status: string; updated_at: string | null }[];
  const stale = rows.filter((r) => r.polish_status === "running" && isStale(r));
  // A cut-off run goes back in the queue to be claimed again.
  for (const r of stale) await db.from("listings").update({ polish_status: "queued" }).eq("id", r.id).eq("polish_status", "running");
  return rows.filter((r) => r.polish_status === "queued" || stale.includes(r)).map((r) => r.id).slice(0, limit);
}
