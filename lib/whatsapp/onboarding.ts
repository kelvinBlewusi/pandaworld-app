/**
 * First-run onboarding and the on-demand guide.
 *
 * WHY IT IS SPLIT IN TWO. A seller who has just linked their number has a
 * next action waiting — connect Jumia, or answer "how many products?".
 * Onboarding that blocks that action is onboarding that gets scrolled
 * past, so the welcome deliberately teaches ONE thing (state your price)
 * and offers the rest behind a button. The full guide is pull, not push:
 * one tap, re-readable forever, and reachable later by typing *help*.
 *
 * WHY THE COMMAND LIST LIVES HERE. The guide and the *help* reply both
 * render from BOT_COMMANDS below. Two hand-written lists of the same
 * commands drift the moment one is added — `retry` already existed for a
 * while before the help text learned about it.
 *
 * Message-type note: the guide is sent as plain text, not interactive.
 * WhatsApp caps an interactive body at ~1024 characters and a plain text
 * message at 4096, and the guide needs the room.
 */

import { MAX_BATCH_SIZE } from "@/lib/whatsapp/batch";

/** Every command the bot understands, with what it does. Rendered into
 *  both the guide and the *help* reply. */
export const BOT_COMMANDS: { phrase: string; meaning: string }[] = [
  { phrase: "done",       meaning: "finished with this product" },
  { phrase: "submit all", meaning: "push your drafted listings to Jumia" },
  { phrase: "retry",      meaning: "run the last failed step again, using the photos you already sent" },
  { phrase: "restart",    meaning: "abandon this batch and start a new one" },
  { phrase: "status",     meaning: "see where things stand right now" },
  { phrase: "help",       meaning: "show this guide again" },
  { phrase: "disconnect", meaning: "unlink your Jumia store" },
];

function commandLines(): string {
  return BOT_COMMANDS.map((c) => `• *${c.phrase}* — ${c.meaning}`).join("\n");
}

/** The button offered beside the welcome. Its id IS the typed phrase, so a
 *  tap and a typed "how it works" run the identical path — the same rule
 *  every other button in this bot follows (see lib/whatsapp/commands.ts). */
export const HOW_IT_WORKS_BUTTON = { id: "how it works", title: "How it works" };

/**
 * Layer 1 — sent once, the first time a number is linked.
 *
 * Short on purpose. The one rule here is the one that most often decides
 * whether a listing can be pushed at all: a draft with no price cannot go
 * to Jumia, and this bot never invents one.
 */
export function welcomeMessage(): string {
  return [
    "👋 *Welcome to PandaWorld!*",
    "",
    "The short version: tell me how many products, send each one's photos with its price and any notes, then reply *done*. I write the listing, you submit it to Jumia.",
    "",
    "One rule worth knowing now: *always tell me the price* — I never guess it, and a product without one can't be pushed.",
    "",
    "Tap below for the full guide, or just get started.",
  ].join("\n");
}

/**
 * Layer 2, part 1 — the loop, and what notes actually do.
 *
 * The notes section is the highest-value part of this whole guide: these
 * are parsed deterministically (see lib/whatsapp/batch.ts), so a seller
 * who knows the shapes gets exact values instead of AI guesses.
 */
export function guideHowToListMessage(): string {
  return [
    "📦 *How listing works*",
    "",
    // Concatenation, not `${MAX_BATCH_SIZE}` — and that is load-bearing.
    //
    // A seller saw this line arrive as the literal text
    // "📦 *How listing works*". The minifier constant-folds an
    // array of literals plus one interpolation into a single TEMPLATE
    // literal, and escaping an astral emoji into a template literal
    // doubles the backslash, so 📦 ships as its own escape sequence.
    // Confirmed by reading the built chunk: this function came out as
    //   return `\\uD83D\\uDCE6 *How listing works*...`
    // while welcomeMessage (no interpolation, folds to a plain string)
    // came out as "👋 *Welcome...", correct, and
    // guideControlsMessage (calls commandLines(), so it cannot fold at
    // all) kept its array and was also correct.
    //
    // Concatenating keeps every element a plain string, so the fold
    // produces a plain string — the case that works. Don't reintroduce an
    // interpolation into an array that also holds an astral emoji.
    "1. I ask how many products — reply with a number (up to " + MAX_BATCH_SIZE + ").",
    "2. For each product, send its photos and type the price plus any notes.",
    "3. Reply *done* when that product is finished.",
    "4. I draft them all, then you review and submit to Jumia.",
    "",
    "*Your notes — I take these literally:*",
    "• Price: \"price 120\"  (required, never guessed)",
    "• Stock: \"stock 10\"",
    "• Variants: \"comes in red, blue and green\"",
    "• Sale: \"sale price 90 from 20 Sept to 30 Sept\"",
    "",
    "You can put the notes in the photo's caption, or send them as a separate message — both work.",
  ].join("\n");
}

/** Layer 2, part 2 — controls and honest limits. */
export function guideControlsMessage(): string {
  return [
    "🎛 *Buttons and commands*",
    "",
    "Every button is just a shortcut — typing the word always works too, from anywhere in the conversation.",
    "",
    commandLines(),
    "",
    "*What I can't do*",
    "• Guess your price or stock — you tell me those",
    `• Draft more than ${MAX_BATCH_SIZE} products in one batch (start another straight after)`,
    "• Push anything until your Jumia store is connected",
    "• Read videos, voice notes or documents — photos only",
    "",
    "Each drafted product uses credits from your PandaWorld balance.",
  ].join("\n");
}

/** The *help* reply. Shares BOT_COMMANDS with the guide so the two can
 *  never disagree about what exists. */
export function helpMessage(): string {
  return [
    "Here's what I understand at any point in the conversation:",
    "",
    commandLines(),
    "",
    "Reply *how it works* for the full guide.",
  ].join("\n");
}

/**
 * What to say when a seller sends something the bot cannot read.
 *
 * Before this, contentOf() reduced a video, voice note or document to an
 * empty object and the message fell through the state machine in total
 * silence — the seller sees their product video delivered, and nothing
 * comes back. Silence is the worst possible answer during someone's first
 * minutes with the bot.
 */
export function unsupportedMediaMessage(kind: string): string {
  const cannot =
    kind === "video"                      ? "I can't watch videos"
    : kind === "audio" || kind === "voice" ? "I can't listen to voice notes"
    : kind === "document"                  ? "I can't open documents"
    : kind === "sticker"                   ? "I can't read stickers"
    : kind === "location"                  ? "I can't use a location"
    : kind === "contacts"                  ? "I can't use a contact card"
    :                                        "I can't read that kind of message";
  return `📷 ${cannot} — send a *photo* of the product instead, and type any details as text.`;
}
