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
  if (existing) return fromRow(existing);

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
  await db.from("whatsapp_sessions").update(update).eq("phone_number", phoneNumber);
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
  });
}
