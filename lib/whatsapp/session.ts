import { createServerClient } from "@/lib/supabase/server";

/**
 * Per-phone-number conversation state for the WhatsApp chatbot. See
 * supabase/migrations/2026-09-10_whatsapp-sessions.sql,
 * supabase/migrations/2026-09-12_whatsapp-batches.sql, and
 * supabase/migrations/2026-09-12_whatsapp-jumia-connect.sql for the
 * schema and the state machine's shape.
 */


/** A missing-value question the bot is waiting on (WhatsAppSession.awaitingValueFor). */
export type ValueQuestion = { listingId: string; field: string; resubmit?: boolean };

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
   * The listing the bot has just asked the seller to name a category for,
   * after Jumia refused ours twice. Null whenever no such question is
   * outstanding. A typed reply is only read as a category while this is
   * set, and anything that clearly isn't one drops it. See
   * askSellerForCategory in lib/whatsapp/intake.ts.
   */
  awaitingCategoryFor: string | null;
  /**
   * The question the bot asked after Jumia's quality check rejected a
   * listing (lib/jumia/qc-remedy.ts): an FDA number, the brand, a price,
   * new photos, or the reason itself. Null when none is outstanding. Read
   * between batches only, like awaitingCategoryFor; anything that isn't an
   * answer drops it.
   */
  awaitingQcAnswer: QcQuestion | null;
  /**
   * The held product's missing field the bot just asked the seller for
   * ("Jumia needs its Weight (kg)"), so their reply can be saved as it.
   * Null when none is outstanding; anything that isn't an answer drops it.
   * See askForNextMissingValue in lib/whatsapp/intake.ts. `resubmit`: the
   * question came from a submit Jumia's rules stopped (or Fix & resubmit),
   * so the answer sends the product straight back.
   */
  awaitingValueFor: ValueQuestion | null;
  /**
   * The batch the seller just submitted in full, while the chat waits for
   * what's next: only a clear new count or "Start another" begins a batch,
   * anything else is told the products are already with Jumia.
   */
  lastSubmittedBatchId: string | null;
  /**
   * The way of sending picked for this batch: true for I (send it all,
   * nothing sent back for any product but the last, see
   * handleQuietBatchMessage in lib/whatsapp/intake.ts), false for II
   * (guide me each step), null while nothing is picked.
   */
  batchQuiet: boolean | null;
  /**
   * The way this number picked last time, used when a batch's choice isn't
   * tapped. Null until one is picked.
   */
  preferredBatchQuiet: boolean | null;
}

/** What awaitingQcAnswer holds. */
export interface QcQuestion {
  listingId:   string;
  kind:        "value" | "brand" | "price" | "photos" | "details";
  /** ask_value: the category field the answer goes in, null for the description. */
  field?:      string | null;
  fieldLabel?: string;
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
    awaitingCategoryFor: (row.awaiting_category_for as string | null) ?? null,
    awaitingQcAnswer: (row.awaiting_qc_answer as QcQuestion | null) ?? null,
    awaitingValueFor: (row.awaiting_value_for as ValueQuestion | null) ?? null,
    lastSubmittedBatchId: (row.last_submitted_batch_id as string | null) ?? null,
    batchQuiet: (row.batch_quiet as boolean | null) ?? null,
    preferredBatchQuiet: (row.preferred_batch_quiet as boolean | null) ?? null,
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
          awaiting_category_for: null,
          awaiting_qc_answer: null,
          awaiting_value_for: null,
          batch_quiet:     null,
          // The previous account's habit, not this one's.
          preferred_batch_quiet: null,
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
    batchId:       string | null;
    batchSize:     number | null;
    batchSeq:      number | null;
    pendingAppId:  string | null;
    pendingNotes:  string | null;
    lastImageAt:   string | null;
    awaitingPriceFor: string | null;
    awaitingCategoryFor: string | null;
    awaitingQcAnswer: QcQuestion | null;
    awaitingValueFor: ValueQuestion | null;
    lastSubmittedBatchId: string | null;
    batchQuiet: boolean | null;
    preferredBatchQuiet: boolean | null;
  }>,
): Promise<void> {
  const db = createServerClient();
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (patch.state         !== undefined) update.state           = patch.state;
  if (patch.listingId     !== undefined) update.listing_id      = patch.listingId;
  if (patch.batchId       !== undefined) update.batch_id        = patch.batchId;
  if (patch.batchSize     !== undefined) update.batch_size      = patch.batchSize;
  if (patch.batchSeq      !== undefined) update.batch_seq       = patch.batchSeq;
  if (patch.pendingAppId  !== undefined) update.pending_app_id  = patch.pendingAppId;
  if (patch.pendingNotes  !== undefined) update.pending_notes   = patch.pendingNotes;
  if (patch.lastImageAt   !== undefined) update.last_image_at   = patch.lastImageAt;
  if (patch.awaitingPriceFor !== undefined) update.awaiting_price_for = patch.awaitingPriceFor;
  if (patch.awaitingCategoryFor !== undefined) update.awaiting_category_for = patch.awaitingCategoryFor;
  if (patch.awaitingQcAnswer !== undefined) update.awaiting_qc_answer = patch.awaitingQcAnswer;
  if (patch.awaitingValueFor !== undefined) update.awaiting_value_for = patch.awaitingValueFor;
  if (patch.lastSubmittedBatchId !== undefined) update.last_submitted_batch_id = patch.lastSubmittedBatchId;
  if (patch.batchQuiet !== undefined) update.batch_quiet = patch.batchQuiet;
  if (patch.preferredBatchQuiet !== undefined) update.preferred_batch_quiet = patch.preferredBatchQuiet;
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
 * Win the right to actually PROCESS this wamid for this phone number. True
 * means it's new — proceed; false means another delivery of the same
 * message already claimed it (a genuine WhatsApp webhook retry, or two
 * concurrent deliveries racing each other).
 *
 * Atomic on purpose — see claim_message_id in
 * 2026-09-19_atomic-message-id-claim.sql. The plain "read session.
 * lastMessageId, act, write it back at the end" this replaces left a
 * window the length of the ENTIRE handler (an AI rerun plus a Jumia push
 * can run well past WhatsApp's own webhook ack timeout, which is exactly
 * when Meta redelivers) during which a second delivery of the same
 * message read the same stale value and ran the whole thing again.
 *
 * Fails OPEN: if the claim itself errors, the message is treated as new
 * rather than silently dropped — a duplicate run is wasteful but
 * recoverable, a message nobody ever answers is not.
 */
export async function claimMessageId(phoneNumber: string, messageId: string): Promise<boolean> {
  const db = createServerClient();
  const { data, error } = await db.rpc("claim_message_id", { p_phone: phoneNumber, p_message_id: messageId });
  if (error) {
    console.warn(`[whatsapp session] message-id claim failed for ${phoneNumber}: ${error.message}`);
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
    // Same for an unanswered category question: a new batch's first
    // message is never an answer to it. Its list rows still work after a
    // restart, since those carry the listing id themselves.
    awaitingCategoryFor: null,
    // And for a quality-check question: the Fix button asks it again.
    awaitingQcAnswer: null,
    // And for a missing-value question about the abandoned batch.
    awaitingValueFor: null,
    // A restart is a clear "list something new".
    lastSubmittedBatchId: null,
    // A mode choice belongs to the batch it was made for. Without this,
    // restarting after a quiet batch would silently carry quiet mode into
    // the next one before the seller ever gets asked again. Unpicked, the
    // next batch falls back to preferredBatchQuiet, which is kept.
    batchQuiet: null,
  });
}
