import { callGeminiBackend } from "@/lib/ai/gemini-client";

/**
 * AI fallback for interpreting free-form chat replies during batch
 * confirmation, used ONLY when the deterministic parsers in
 * lib/whatsapp/batch.ts (parseSubmitCommand, parseEditCommand) don't
 * match — e.g. "go ahead and push everything" or "please change the
 * second one's price to 200 cedis" instead of the exact "submit" /
 * "submit 2" / "2: ..." forms. Kept strictly as a fallback so the common,
 * well-formed commands stay fast, free, and fully deterministic — this
 * only costs a Gemini call for genuinely ambiguous free text, never for
 * the primary path.
 */

export type ChatIntent =
  | { type: "submit_all" }
  | { type: "submit_specific"; seqs: number[] }
  | { type: "edit"; seq: number; instruction: string }
  | { type: "unclear" };

const ACTION_WORDS = /\b(submit|push|send|post|go|change|edit|update|fix|set|make|price|stock|qty|quantity|all|everything)\b/i;

/**
 * Cheap pre-filter so classifyBatchIntent only ever runs for text that
 * could plausibly be a submit/edit instruction — a digit (a product
 * number) or a recognizable action word. Without this, every off-topic
 * reply during batch confirmation ("thanks", "ok", "cool") would cost a
 * Gemini call for nothing.
 */
export function looksActionable(text: string): boolean {
  return /\d/.test(text) || ACTION_WORDS.test(text);
}

// A small, fast/cheap text model — this is chat-command routing, not a
// billed listing-generation feature, so it deliberately bypasses the
// plan-tier model resolution + analyze quota used elsewhere in this
// codebase (lib/actions/ai.ts's resolveModel).
const CLASSIFY_MODEL = "gemini-2.5-flash-lite";

export async function classifyBatchIntent(
  text: string,
  products: { seq: number; title: string | null }[],
): Promise<ChatIntent> {
  const productList = products.map((p) => `${p.seq}. ${p.title ?? "(untitled)"}`).join("\n");
  const prompt = [
    "A seller is texting a WhatsApp bot about a batch of draft product listings they're about to push to Jumia.",
    "Products in this batch:",
    productList,
    "",
    `Seller's message: "${text.replace(/"/g, "'").slice(0, 500)}"`,
    "",
    "Classify their intent as exactly ONE of these JSON shapes:",
    '{"type":"submit_all"} - push every product to Jumia',
    '{"type":"submit_specific","seqs":[<product numbers>]} - push only these product numbers',
    '{"type":"edit","seq":<product number>,"instruction":"<what to change, in their own words>"} - change one product before submitting',
    '{"type":"unclear"} - anything else: small talk, a question, or too ambiguous to act on',
    "",
    "Reply with ONLY the JSON object, nothing else — no markdown fencing, no explanation.",
  ].join("\n");

  try {
    const { text: raw } = await callGeminiBackend(CLASSIFY_MODEL, [{ text: prompt }]);
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return { type: "unclear" };

    const parsed = JSON.parse(match[0]) as Record<string, unknown>;

    if (parsed.type === "submit_all") return { type: "submit_all" };

    if (parsed.type === "submit_specific" && Array.isArray(parsed.seqs)) {
      const seqs = parsed.seqs.filter((n): n is number => typeof n === "number" && Number.isFinite(n));
      if (seqs.length > 0) return { type: "submit_specific", seqs };
    }

    if (
      parsed.type === "edit" &&
      typeof parsed.seq === "number" &&
      typeof parsed.instruction === "string" &&
      parsed.instruction.trim()
    ) {
      return { type: "edit", seq: parsed.seq, instruction: parsed.instruction.trim() };
    }

    return { type: "unclear" };
  } catch (e) {
    console.warn(`[whatsapp intent] classification failed: ${(e as Error).message}`);
    return { type: "unclear" };
  }
}
