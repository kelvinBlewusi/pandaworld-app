/**
 * Short jokes sent when a seller taps "Tell me a joke" while a big batch
 * (10+ products) drafts in the background — see startBatchAnalysis and
 * handleAnalyzingMessage in lib/whatsapp/intake.ts.
 *
 * Deliberately hardcoded and instant (no AI call) — the whole point is to
 * fill dead air during a slow batch, not add more latency to it. An AI
 * joke would also be unpredictable in a way this cannot afford: these land
 * in a stranger's business chat, so every one of them is read before it
 * ships. Clean, no punching down, nothing that assumes a culture or a
 * language beyond the one the bot already speaks.
 */

const JOKES: string[] = [
  "😄 I told my wife she was drawing her eyebrows too high. She looked surprised.",
  "😄 Why don't skeletons fight each other? They don't have the guts.",
  "😄 I'm reading a book about anti-gravity. It's impossible to put down.",
  "😄 What do you call a fake noodle? An impasta.",
  "😄 I would tell you a construction joke, but I'm still working on it.",
  "😄 Why did the scarecrow win an award? He was outstanding in his field.",
  "😄 I used to hate facial hair, but then it grew on me.",
  "😄 What do you call cheese that isn't yours? Nacho cheese.",
  "😄 Parallel lines have so much in common. It's a shame they'll never meet.",
  "😄 I'm on a seafood diet. I see food and I eat it.",
  "😄 Why don't scientists trust atoms? Because they make up everything.",
  "😄 I tried to catch fog yesterday. Mist.",
  "😄 What's orange and sounds like a parrot? A carrot.",
  "😄 My boss told me to have a good day. So I went home.",
  "😄 Why did the bicycle fall over? It was two tired.",
  "😄 I ordered a chicken and an egg online. I'll let you know.",
  "😄 What did one wall say to the other? I'll meet you at the corner.",
  "😄 I have a joke about time travel, but you didn't like it.",
  "😄 Why can't your nose be 12 inches long? Because then it would be a foot.",
  "😄 I asked the librarian if the library had books on paranoia. She whispered, \"They're right behind you.\"",
  "😄 What do you call a bear with no teeth? A gummy bear.",
  "😄 I'm terrible at maths. That's a problem I can't solve.",
  "😄 Why did the coffee file a police report? It got mugged.",
  "😄 Two fish are in a tank. One says, \"Do you know how to drive this thing?\"",
  "😄 I bought shoes from a drug dealer once. I don't know what he laced them with, but I was tripping all day.",
  "😄 What do you call a pile of cats? A meowtain.",
  "😄 My friend keeps saying \"cheer up, it could be worse, you could be stuck underground in a hole full of water.\" I know he means well.",
  "😄 Why are elevator jokes so good? They work on so many levels.",
  "😄 I told my computer I needed a break. Now it won't stop sending me KitKats.",
  "😄 What's the best thing about Switzerland? I don't know, but the flag is a big plus.",
];

/**
 * A random joke.
 *
 * Genuinely random per call, with no ordering and no state kept between
 * calls — which does mean the same joke can come up twice in a row. That
 * is the trade the seller asked for: "sent randomly when requested without
 * any order to it". Tracking what each seller has already heard would need
 * per-conversation state for a filler message, which is more machinery
 * than the feature is worth.
 */
export function pickJoke(): string {
  return JOKES[Math.floor(Math.random() * JOKES.length)];
}

/** Exported for the test that guards against duplicates creeping in. */
export const JOKE_COUNT = JOKES.length;
export { JOKES };
