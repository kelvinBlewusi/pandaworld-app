/**
 * Short, whimsical filler stories sent when a seller taps "Tell me a
 * story" while a big batch (10+ products) drafts in the background — see
 * startBatchAnalysis and handleAnalyzingMessage in lib/whatsapp/intake.ts.
 * Deliberately hardcoded and instant (no AI call) — the whole point is to
 * fill dead air during a slow batch, not add more latency to it.
 */

const STORIES: string[] = [
  "🐼 Once, a small panda opened a stall at the market with just one photo of a scarf. By evening, three more pandas had copied the idea — and the market got a little more colourful because of it.",
  "🐼 A young trader used to spend hours writing descriptions by paw. One day she found a shortcut, sold her whole stock by lunchtime, and spent the afternoon napping in the sun instead.",
  "🐼 They say the best market stalls aren't the loudest — just the ones that show up, photo after photo, listing after listing, until customers start showing up on their own.",
  "🐼 A wise old panda once said: \"You don't need to sell everything today. You just need to list one more thing than yesterday.\"",
  "🐼 There's a legend about a market so busy that the pandas running it built a machine to write listings for them — freeing up their paws for the important work: eating bamboo.",
];

/** Picks a random story — different each time, no state to track between calls. */
export function pickStory(): string {
  return STORIES[Math.floor(Math.random() * STORIES.length)];
}
