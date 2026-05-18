// ─── stripHtml ───────────────────────────────────────────────────────────────
//
// Returns the plain-text body of an HTML string — no tags, single-spaced.
// Used wherever we need to count CHARACTERS the seller actually wrote
// (e.g. Jumia's 50-character minimum on product descriptions). Tiptap
// stores rich-text fields as HTML strings, so a raw .length on the
// stored value would count tag characters too and fail the validation
// unfairly.
//
// Light-weight regex approach is fine for our needs — we control the
// HTML produced by Tiptap, so we won't see exotic constructs that need
// a proper parser. We also strip <script>/<style> blocks defensively,
// even though Tiptap would never emit them.
//
// `<br>` and block-element close tags collapse to a single space so
// "two<br>lines" doesn't read as "twolines".

const BLOCK_BREAK_RE =
  /<\/(p|div|h[1-6]|li|tr|td|th|blockquote|pre|section|article)>|<br\s*\/?>/gi;
const SCRIPT_STYLE_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const TAG_RE = /<[^>]+>/g;
const WHITESPACE_RE = /\s+/g;

export function stripHtml(input: string): string {
  if (!input) return "";
  return input
    .replace(SCRIPT_STYLE_RE, "")
    .replace(BLOCK_BREAK_RE, " ")
    .replace(TAG_RE, "")
    // Decode the small set of entities Tiptap emits.
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(WHITESPACE_RE, " ")
    .trim();
}
