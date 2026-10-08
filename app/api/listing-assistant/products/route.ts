import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { checkRateLimit, RATE_LIMITS } from "@/lib/rate-limit";
import { webAddress } from "@/lib/whatsapp/channel";
import { MAX_ALBUM, listingAssistantFor, ownMedia } from "@/lib/whatsapp/listing-assistant";
import { startBatchFromForm, type FormProduct } from "@/lib/whatsapp/intake";
import { logAppError } from "@/lib/observability/errors";

/**
 * The Listing Assistant's product form (components/assistant/product-form.tsx):
 * several products, each with its photos (media ids from
 * /api/listing-assistant/upload), price, quantity, sizes, colour and notes,
 * made into a batch and drafted (startBatchFromForm in lib/whatsapp/intake.ts).
 * Every seller since 2026-10-08 (owner: "open the form on the web for users
 * who want to list so they don't go through the old flow"); admins first.
 */

export const maxDuration = 60;

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  if (!(await listingAssistantFor(userId))) return NextResponse.json({ error: "The Jumia Listing Assistant isn't on for your account yet." }, { status: 403 });
  const blocked = checkRateLimit(`assistant-message:${userId}`, RATE_LIMITS.assistantMessage);
  if (blocked) return blocked;

  const body = (await req.json().catch(() => null)) as { id?: unknown; products?: unknown } | null;
  const id = typeof body?.id === "string" && /^[\w-]{8,80}$/.test(body.id) ? body.id : null;
  if (!id) return NextResponse.json({ error: "Missing message id." }, { status: 400 });
  if (!Array.isArray(body?.products) || body.products.length === 0) return NextResponse.json({ error: "Add a product first." }, { status: 400 });

  const products: FormProduct[] = [];
  const given = (body.products as unknown[]).slice(0, 20);
  for (let i = 0; i < given.length; i++) {
    const raw = given[i];
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const mediaIds = (Array.isArray(r.mediaIds) ? r.mediaIds : []).filter((m): m is string => typeof m === "string").slice(0, MAX_ALBUM);
    if (mediaIds.length === 0) return NextResponse.json({ error: `Product ${i + 1} needs at least one photo.` }, { status: 400 });
    if (mediaIds.some((m) => !ownMedia(userId, m))) return NextResponse.json({ error: "A photo isn't yours to send." }, { status: 400 });
    const price = Number(r.price);
    if (!Number.isFinite(price) || price <= 0) return NextResponse.json({ error: `Product ${i + 1} needs its price.` }, { status: 400 });
    const quantity = r.quantity == null || r.quantity === "" ? null : Number(r.quantity);
    if (quantity != null && (!Number.isInteger(quantity) || quantity < 1)) {
      return NextResponse.json({ error: `Product ${i + 1}'s quantity should be a whole number.` }, { status: 400 });
    }
    products.push({
      mediaIds, price: Math.round(price * 100) / 100, quantity,
      sizes: text(r.sizes, 200), colour: text(r.colour, 80), notes: text(r.notes, 800),
    });
  }

  try {
    const r = await startBatchFromForm(userId, webAddress(userId), id, products);
    return r.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: r.error }, { status: 400 });
  } catch (e) {
    console.error(`[product form] ${userId}: ${(e as Error).message}`);
    logAppError("listing-assistant", e, { userId });
    return NextResponse.json({ error: "Something went wrong saving these. Try again in a moment." }, { status: 500 });
  }
}
