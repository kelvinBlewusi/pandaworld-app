/**
 * Parse Gemini's JSON response text — shared by every AI pass in
 * lib/actions/ai.ts (~13 call sites: describe, department pick, rank,
 * combined pick+fill, gap-fill, ...).
 *
 * Kept in its own plain module, NOT inside lib/actions/ai.ts, because that
 * file starts with "use server" — every top-level export there is a Next.js
 * Server Action, and Server Actions must be async functions. parseAIResponse
 * is synchronous (pure text-in, object-out), so exporting it directly from
 * ai.ts breaks the production build ("Server actions must be async
 * functions") — confirmed live on the 2026-09-21 staging deploy the first
 * version of this fix shipped as. Extracting it here sidesteps that
 * constraint entirely and makes it independently unit-testable.
 */

/** Escape one raw control byte (U+0000–U+001F) found inside a JSON string
 *  literal, in whatever form JSON.parse actually accepts. */
function escapeControlChar(ch: string, code: number): string {
  switch (ch) {
    case "\n": return "\\n";
    case "\r": return "\\r";
    case "\t": return "\\t";
    default:   return `\\u${code.toString(16).padStart(4, "0")}`;
  }
}

/**
 * Escape raw control bytes (U+0000–U+001F: newline, CR, tab, and the rest
 * of the Cc block) found INSIDE JSON string literals, before JSON.parse
 * ever sees them.
 *
 * Every prompt in lib/actions/ai.ts that wants a multi-line value
 * (highlights' bullets, what_is_in_the_box's item list, ...) explicitly
 * asks Gemini to write the line break as the two-character escape sequence
 * \n — but it occasionally emits the literal newline BYTE instead, which
 * V8's JSON.parse rejects outright with "Bad control character in string
 * literal in JSON at position N" (a native error string, not one this
 * codebase authors anywhere). Confirmed live on the staging WhatsApp
 * canary, 2026-09-21: a long `description`/`highlights` value is exactly
 * where this shows up, since those are the fields most likely to carry a
 * literal control byte the model meant as a line break — and because
 * every one of parseAIResponse's call sites shares this one function,
 * fixing it here closes the gap everywhere at once rather than patching
 * whichever pass happened to be the one that canaried it.
 *
 * Scoped to inside string literals only, by tracking in-string / escaped
 * state character by character — a raw newline OUTSIDE a string is
 * ordinary, insignificant JSON whitespace, and blindly escaping every
 * control character in the whole text would turn that harmless
 * whitespace into invalid syntax between tokens.
 */
function sanitizeJsonControlChars(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);

    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }

    if (escaped) {
      escaped = false;
      out += code <= 0x1f ? escapeControlChar(ch, code) : ch;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }
    out += code <= 0x1f ? escapeControlChar(ch, code) : ch;
  }

  return out;
}

export function parseAIResponse(raw: string): Record<string, unknown> {
  const cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  // Find the JSON object
  const start = cleaned.indexOf("{");
  const end   = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("No JSON object in AI response");

  return JSON.parse(sanitizeJsonControlChars(cleaned.slice(start, end + 1)));
}
