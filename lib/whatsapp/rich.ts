/**
 * Answers laid out for reading (owner, 2026-10-09: "our presentation of
 * results is bad ... organized ... with tables if needed or graphics if
 * possible ... rich texts"). An answer is sent as its text, as before, plus
 * these blocks: the Listing Assistant's page draws them (stat tiles, tables
 * with coloured statuses, bars; components/assistant/rich-message.tsx),
 * WhatsApp gets the text, which it can show. The text is also what the
 * conversation's history keeps for the AI.
 */

import { isWebAddress } from "@/lib/whatsapp/channel";
import { sendRichIfConfigured, sendTextIfConfigured } from "@/lib/whatsapp/client";
import { splitForText } from "@/lib/whatsapp/text-limits";
import type { RichBlock } from "@/lib/whatsapp/rich-blocks";

export * from "@/lib/whatsapp/rich-blocks";

/** An answer: its blocks on the page, its text on WhatsApp (split to fit). */
export async function sendRich(to: string, text: string, blocks: RichBlock[]): Promise<void> {
  if (isWebAddress(to)) {
    await sendRichIfConfigured(to, text, { blocks });
    return;
  }
  for (const part of splitForText(text)) await sendTextIfConfigured(to, part);
}

