/**
 * Normalises a stored field value into HTML for the rich-text editor
 * (components/jumia/RichTextField.tsx).
 *
 * Split out of that component so it can be tested directly — the test
 * runner is node-environment and only picks up *.test.ts, same reason
 * lib/whatsapp/webhook-verify.ts and lib/utils/strip-html.ts live apart
 * from their callers.
 */

/** Any tag the editor's schema can represent. Matched ANYWHERE in the
 *  value, not just at the start — see normaliseRichTextValue. */
const HTML_TAG_RE =
  /<(p|br|ul|ol|li|h[1-6]|strong|b|em|i|u|s|a|img|blockquote|table|thead|tbody|tr|td|th|div|span|code|pre)\b[^>]*>/i;

const BULLET_RE = /^\s*[•\-*]\s+(.+)$/;

/** Also used by the editor's link-insert command, which builds an
 *  <a> from user-typed text. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert a legacy plain-text value (especially AI-generated "• bullet"
 * highlights) into HTML the editor renders nicely. A value that already
 * contains HTML is passed through untouched.
 *
 * The HTML test used to be ANCHORED to the start of the value
 * (/^\s*<(p|ul|ol|...)/), which is why Description rendered its markup as
 * literal "<strong>" and "<ul>" text while Highlights — a field using the
 * exact same component on the same page — rendered fine. Highlights always
 * begins "<ul>"; a Description often opens with an unwrapped prose
 * paragraph and only reaches its first tag hundreds of characters in
 * (measured on live listings: 319, 373, 609). Anchored, that read as plain
 * text and fell through to the escaping branch below, which turned every
 * real tag into &lt;strong&gt; — the tags the seller then saw spelled out
 * on screen.
 *
 * Passing mixed content through is safe: Tiptap parses against its own
 * schema, so anything its extensions don't define (script tags, event
 * handlers, unknown elements) is dropped rather than rendered, and a
 * leading bare text node is wrapped in a paragraph automatically.
 */
export function normaliseRichTextValue(raw: string): string {
  const trimmed = raw?.trim() ?? "";
  // Whitespace-only used to fall all the way through to the paragraph
  // branch and come back as "<p></p>" — an empty document that reads as
  // content to anything measuring length. RichTextField carries a guard
  // against exactly that string; better not to produce it at all.
  if (!trimmed) return "";

  if (HTML_TAG_RE.test(trimmed)) return trimmed;

  // Bullet list: any line starting with "•", "-" or "*" followed by a
  // space. At least 2 such lines are required, so a single sentence that
  // happens to start with "-" isn't mis-converted.
  const lines = trimmed.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2 && lines.every((l) => BULLET_RE.test(l))) {
    const items = lines
      .map((l) => l.replace(BULLET_RE, "$1"))
      .map((t) => `<li>${escapeHtml(t)}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }

  // Otherwise: blank-line-separated blocks become paragraphs, single line
  // breaks become <br>.
  return trimmed
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}
