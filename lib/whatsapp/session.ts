import { createServerClient } from "@/lib/supabase/server";

/**
 * Per-phone-number conversation state for the WhatsApp chatbot. See
 * supabase/migrations/2026-09-10_whatsapp-sessions.sql,
 * supabase/migrations/2026-09-12_whatsapp-batches.sql, and
 * supabase/migrations/2026-09-12_whatsapp-jumia-connect.sql for the
 * schema and the state machine's shape.
 */

export type WhatsAppSessionState =
  | "awaiting_jumia_credentials"
  | "awaiting_jumia_oauth"
  | "awaiting_count"
  | "awaiting_photos"
  | "analyzing"
  | "awaiting_confirmation"
  | "error";

export interface WhatsAppSession {
  phoneNumber:   string;
  userId:        string;
  state:         WhatsAppSessionState;
  listingId:     string | null;
  lastMessageId: string | null;
  // The current multi-product run. batchSize is how many products the
  // seller said they're listing; batchSeq is the one currently being
  // collected (1-based). All three are null outside a batch (or before
  // the seller has answered "how many?").
  batchId:       string | null;
  batchSize:     number | null;
  batchSeq:      number | null;
  // Holds the Client ID while awaiting_jumia_credentials and the seller
  // has pasted it but not yet the Client Secret (or vice versa — see
  // lib/whatsapp/intake.ts's handleAwaitingJumiaCredentials).
  pendingAppId:  string | null;
  /**
   * A note the seller sent before the product had a listing to hang it
   * on. WhatsApp does not order separate webhook deliveries, and a photo
   * is a much bigger payload than a line of text, so the note routinely
   * wins the race. Parked here rather than dropped; flushed the moment a
   * listing exists.
   */
  pendingNotes:  string | null;
  /**
   * When the most recent photo for the current product landed.
   *
   * WhatsApp delivers an album as several independent webhook deliveries,
   * and the bot used to answer every one — five "got it (N photos)"
   * messages, each with its own Done button, for one album. This is the
   * burst marker that lets handleAwaitingPhotos confirm the first and stay
   * quiet for the rest. Null means no burst in progress.
   */
  lastImageAt:   string | null;
  /**
   * The listing the bot has just asked the seller, in chat, to give a
   * price for. Null whenever no such question is outstanding.
   *
   * A bare number is the single most ambiguous thing a seller can send —
   * it could be a price, a quantity, a size, or a product number — so the
   * bot only reads one as a price while this pointer is set, and drops the
   * pointer the moment they say anything else. See
   * askForNextMissingPrice in lib/whatsapp/intake.ts.
   *
   * Exists because "no price" was the single commonest reason a drafted
   * product never reached Jumia: in one real 10-product session on
   * 2026-09-15, five products were blocked on it, and the only way to fix
   * that was to leave WhatsApp for the review page.
   */
  awaitingPriceFor: string | null;
  /**
   * True when the seller picked "just send it all" at the how-many-
   * products step instead of the default step-by-step flow. Nothing sent
   * back for any product but the last — see handleQuietBatchText in
   * lib/whatsapp/intake.ts.
   */
  batchQuiet: boolean;
}

function fromRow(row: Record<string, unknown>): WhatsAppSession {
  return {
    phoneNumber:   row.phone_number as string,
    userId:        row.user_id as string,
    state:         row.state as WhatsAppSessionState,
    listingId:     (row.listing_id as string | null) ?? null,
    lastMessageId: (row.last_message_id as string | null) ?? null,
    batchId:       (row.batch_id as string | null) ?? null,
    batchSize:     (row.batch_size as number | null) ?? null,
    batchSeq:      (row.batch_seq as number | null) ?? null,
    pendingAppId:  (row.pending_app_id as string | null) ?? null,
    pendingNotes:  (row.pending_notes as string | null) ?? null,
    lastImageAt:   (row.last_image_at as string | null) ?? null,
    awaitingPriceFor: (row.awaiting_price_for as string | null) ?? null,
    batchQuiet: (row.batch_quiet as boolean | null) ?? false,
  };
}

/**
 * Fetch the session for a linked number, creating a fresh one if this is
 * the seller's first message since linking (or since their last
 * completed/reset batch). `initialState` lets the caller start a
 * brand-new number in `awaiting_jumia_credentials`/`awaiting_jumia_oauth`
 * instead of the usual `awaiting_count` default — see the LINK-code
 * handling in app/api/whatsapp/webhook/route.ts, which already knows
 * whether this seller has Jumia connected before any session row exists.
 * Has no effect on an existing row.
 */
export async function getOrCreateSession(
  userId: string,
  phoneNumber: string,
  initialState: WhatsAppSessionState = "awaiting_count",
): Promise<WhatsAppSession> {
  const db = createServerClient();

  const { data: existing } = await db
    .from("whatsapp_sessions")
    .select("*")
    .eq("phone_number", phoneNumber)
    .maybeSingle();

  if (existing) {
    // Same number, DIFFERENT account. The session row is keyed by phone
    // number alone, so relinking a number to another PandaWorld account
    // updated whatsapp_connections and left this row pointing at the old
    // one — and this function returned it regardless of who was asking.
    //
    // Found live on 2026-09-15: phone 233550607231 had a
    // whatsapp_connections row for one user and an active
    // whatsapp_sessions row, mid-batch at awaiting_confirmation, for a
    // different user whose Clerk account had since been deleted. The new
    // owner of the number was inheriting the previous owner's session —
    // its listingId, its batchId, and any notes parked against it. One
    // seller resuming another seller's in-flight batch is a data leak,
    // not a glitch.
    //
    // A change of owner ends the conversation. Everything batch-scoped is
    // cleared rather than carried over: a half-finished batch belongs to
    // the account that started it, and there is no sense in which the new
    // owner asked to continue it.
    if (existing.user_id !== userId) {
      console.warn(
        `[whatsapp session] ${phoneNumber} changed owner ` +
        `(${existing.user_id} → ${userId}) — resetting the session rather than ` +
        `handing over the previous account's batch`,
      );
      const { data: adopted } = await db
        .from("whatsapp_sessions")
        .update({
          user_id:         userId,
          state:           initialState,
          listing_id:      null,
          batch_id:        null,
          batch_size:      null,
          batch_seq:       null,
          pending_app_id:  null,
          pending_notes:   null,
          last_image_at:   null,
          last_message_id: null,
          awaiting_price_for: null,
          batch_quiet:     false,
          updated_at:      new Date().toISOString(),
        })
        .eq("phone_number", phoneNumber)
        // Pinned to the owner we read, so two concurrent relinks cannot
        // both believe they won.
        .eq("user_id", existing.user_id)
        .select("*")
        .maybeSingle();

      // A lost race means someone else adopted it first; re-read rather
      // than assume either version.
      if (adopted) return fromRow(adopted);
      const { data: reread } = await db
        .from("whatsapp_sessions")
        .select("*")
        .eq("phone_number", phoneNumber)
        .maybeSingle();
      if (reread) return fromRow(reread);
    }

    return fromRow(existing);
  }

  const { data: created, error } = await db
    .from("whatsapp_sessions")
    .insert({ phone_number: phoneNumber, user_id: userId, state: initialState })
    .select()
    .single();

  if (error) {
    // Race: a concurrent message for the same number already created the
    // row between our select and insert — re-fetch instead of failing.
    const { data: retry } = await db
      .from("whatsapp_sessions")
      .select("*")
      .eq("phone_number", phoneNumber)
      .maybeSingle();
    if (retry) return fromRow(retry);
    throw new Error(`Failed to create WhatsApp session: ${error.message}`);
  }

  return fromRow(created);
}

export async function updateSession(
  phoneNumber: string,
  patch: Partial<{
    state:         WhatsAppSessionState;
    listingId:     string | null;
    lastMessageId: string | null;
    batchId:       string | null;
    batchSize:     number | null;
    batchSeq:      number | null;
    pendingAppId:  string | null;
    pendingNotes:  string | null;
    lastImageAt:   string | null;
    awaitingPriceFor: string | null;
    batchQuiet: boolean;
  }>,
): Promise<void> {
  const db = createServerClient();
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.state         !== undefined) update.state           = patch.state;
  if (patch.listingId     !== undefined) update.listing_id      = patch.listingId;
  if (patch.lastMessageId !== undefined) update.last_message_id = patch.lastMessageId;
  if (patch.batchId       !== undefined) update.batch_id        = patch.batchId;
  if (patch.batchSize     !== undefined) update.batch_size      = patch.batchSize;
  if (patch.batchSeq      !== undefined) update.batch_seq       = patch.batchSeq;
  if (patch.pendingAppId  !== undefined) update.pending_app_id  = patch.pendingAppId;
  if (patch.pendingNotes  !== undefined) update.pending_notes   = patch.pendingNotes;
  if (patch.lastImageAt   !== undefined) update.last_image_at   = patch.lastImageAt;
  if (patch.awaitingPriceFor !== undefined) update.awaiting_price_for = patch.awaitingPriceFor;
  if (patch.batchQuiet !== undefined) update.batch_quiet = patch.batchQuiet;
  await db.from("whatsapp_sessions").update(update).eq("phone_number", phoneNumber);
}

/**
 * Win the right to send ONE "got it (N photos)" confirmation for the burst
 * of photos arriving right now. True means send it; false means another
 * delivery in the same album already did.
 *
 * Atomic on purpose — see claim_photo_confirmation in
 * 2026-09-15_session-last-image-at.sql. Album deliveries run as separate
 * serverless invocations that all read the session before any writes, so
 * only the row lock can decide this.
 *
 * Fails OPEN: if the claim itself errors, the seller gets the confirmation
 * they would have got before. A duplicate message is noise; a missing one
 * looks like their photo was dropped, which is the thing this whole
 * confirmation exists to disprove.
 */
export async function claimPhotoConfirmation(phoneNumber: string): Promise<boolean> {
  const db = createServerClient();
  const { data, error } = await db.rpc("claim_photo_confirmation", { p_phone: phoneNumber });
  if (error) {
    console.warn(`[whatsapp session] photo-confirmation claim failed for ${phoneNumber}: ${error.message}`);
    return true;
  }
  return data === true;
}

/**
 * Back to a clean slate for the next batch. Keeps the row (and its
 * user_id) rather than deleting it — there's nothing sensitive in a
 * conversation-state pointer, and keeping it avoids a re-create race with
 * the very next incoming message.
 */
export async function resetSession(phoneNumber: string): Promise<void> {
  await updateSession(phoneNumber, {
    state:     "awaiting_count",
    listingId: null,
    batchId:   null,
    batchSize: null,
    batchSeq:  null,
    // A note parked against the abandoned batch must not survive into the
    // next one — restart means start over, and inheriting the old batch's
    // price or variants is the opposite of that.
    pendingNotes: null,
    // No burst in progress in a fresh batch — otherwise the first photo of
    // the NEXT product could be silenced by the last one of the old batch.
    lastImageAt: null,
    // An unanswered price question dies with the batch it was asked
    // about — otherwise the first number of the NEXT batch (the product
    // count, "3") would be banked as the old batch's price.
    awaitingPriceFor: null,
    // A mode choice belongs to the batch it was made for. Without this,
    // restarting after a quiet batch would silently carry quiet mode into
    // the next one before the seller ever gets asked again.
    batchQuiet: false,
  });
}
