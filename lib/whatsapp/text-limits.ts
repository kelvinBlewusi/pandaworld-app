/**
 * Meta's caps on a WhatsApp message's text. Over them the Graph API
 * refuses the send (400, nothing delivered) rather than cutting it: 1024
 * characters for any interactive body (reply buttons, a link button, a
 * list alike) and 4096 for plain text. A list's was taken to be 4096 until
 * a 20-product batch summary of 1,731 was refused (live, 2026-10-02).
 */
export const INTERACTIVE_BODY_MAX = 1024;
export const TEXT_MAX             = 4096;

/** `text` split at line breaks into pieces a plain-text message will take. */
export function splitForText(text: string, max = TEXT_MAX): string[] {
  const parts: string[] = [];
  let part = "";
  for (const line of text.split("\n")) {
    if (part && part.length + 1 + line.length > max) {
      parts.push(part);
      part = "";
    }
    part = part ? `${part}\n${line}` : line.slice(0, max);
  }
  if (part) parts.push(part);
  return parts;
}
