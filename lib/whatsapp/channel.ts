/**
 * The Listing Assistant (owner, 2026-10-07: "a chat interface with image +
 * upload button named Listing Assistant, where the interface does all
 * queries, drafting and pushing except order alerts and labels") runs the
 * same bot as WhatsApp, under its own address: `web:<userId>` stands where
 * a phone number would.
 *
 *   - lib/whatsapp/client.ts: a message to a web address isn't sent to Meta;
 *     it's written to whatsapp_message_log with its buttons, list rows or
 *     link, and the page shows it (app/extension/(app)/assistant).
 *   - lib/whatsapp/media.ts: a photo uploaded on the page is already stored;
 *     its media id is `web:<storage path>`.
 *   - The session, the batch, the assistant and its log all key on the
 *     address, so the web chat and WhatsApp are separate conversations.
 *   - Listings made here carry listings.chat_channel = 'web', so their
 *     updates (live, rejected, fixed) come back here, not to WhatsApp
 *     (chatAddressFor in lib/jumia/push-listing.ts).
 *   - Orders and shipping labels stay on WhatsApp (lib/whatsapp/orders.ts),
 *     and the order alerts and shop notices only ever go to WhatsApp numbers.
 */

export const WEB_PREFIX = "web:";

/** The Listing Assistant's address for a seller. */
export const webAddress = (userId: string) => `${WEB_PREFIX}${userId}`;

/** Whether a "phone number" is the Listing Assistant's, not WhatsApp's. */
export const isWebAddress = (to: string | null | undefined): boolean => typeof to === "string" && to.startsWith(WEB_PREFIX);

/** listings.chat_channel for a listing started at this address: 'web', or null for WhatsApp. */
export const chatChannelOf = (address: string): "web" | null => (isWebAddress(address) ? "web" : null);
