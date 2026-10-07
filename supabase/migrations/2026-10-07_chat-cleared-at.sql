-- "Clear chat" in the Jumia Listing Assistant (lib/whatsapp/chat-clear.ts):
-- when the seller's web chat was last cleared. The messages stay in
-- whatsapp_message_log; the chat and the assistant read only those after it.
alter table whatsapp_sessions add column if not exists chat_cleared_at timestamptz;
