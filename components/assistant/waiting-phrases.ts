/**
 * What the web chat says while a reply is on its way (owner, 2026-10-09:
 * "interactive or engaging changing or motion texts like the size of the
 * chat timestamp ... loading, on it, checking it out, working on it, hang
 * tight, reading from your shop ..."). Picked by the words of what the
 * seller just sent, and shown only while the page waits: the reply replaces
 * them the moment it's there, so they never add time. Pure.
 */

export type WaitTopic = "photos" | "polish" | "listing" | "stock" | "orders" | "payouts" | "change" | "rejected" | "report" | "shop" | "general";

const PHRASES: Record<WaitTopic, string[]> = {
  photos:   ["Got your photos", "Looking at the photos", "Spotting the product", "Reading the labels", "Working out the details"],
  polish:   ["On it", "Polishing images", "Brightening the background", "Cleaning up the edges", "Making it shine"],
  listing:  ["On it", "Drafting", "Writing the title", "Picking the category", "Writing the description", "Adding images", "Checking Jumia's rules"],
  stock:    ["Opening the shop", "Checking shelves", "Counting inventory", "Walking the aisles", "Tallying it up"],
  orders:   ["Opening the order book", "Checking your orders", "Reading from Jumia", "Counting sales", "Adding it up"],
  payouts:  ["Opening your statements", "Reading your payouts", "Adding it up", "Checking the numbers"],
  change:   ["On it", "Finding the product", "Reading from your shop", "Getting the change ready", "Double-checking"],
  rejected: ["Opening quality control", "Reading Jumia's reasons", "Finding the fix", "Working on it"],
  report:   ["Walking in the shop", "Looking at the shop", "Querying Jumia", "Crunching the numbers", "Putting it together"],
  shop:     ["Opening the shop", "Reading from your shop", "Looking at the shelves", "Querying", "Putting it together"],
  general:  ["On it", "Checking it out", "Working on it", "Hang tight", "Thinking it through"],
};

/** What the seller's message is about, for the phrases. */
export function waitTopic(text: string | null | undefined, opts: { photos?: boolean; form?: boolean } = {}): WaitTopic {
  const t = (text ?? "").toLowerCase();
  if (/\bpolish|\bbackground|\benhance/.test(t)) return "polish";
  if (opts.form) return "listing";
  if (opts.photos) return "photos";
  if (/\breject|\bqc\b|quality check|\bfix\b/.test(t)) return "rejected";
  if (/\bpayouts?\b|\bpaid\b|\bstatements?\b|\bbalance\b|\bearn/.test(t)) return "payouts";
  if (/\borders?\b|\bsales?\b|\bsold\b|\bsell(?:ing|s)?\b|\bbuyers?\b|\bship|\bdeliver|\breturns?\b/.test(t)) return "orders";
  if (/\bstock\b|\binventory\b|\bquantit|\brestock|\bhow many\b.*\b(?:left|have)\b/.test(t)) return "stock";
  if (/\b(?:change|update|set|edit|rename|turn (?:on|off)|switch|raise|lower|discount|sale price|price)\b/.test(t)) return "change";
  if (/\b(?:list|draft|new products?|submit|publish)\b/.test(t)) return "listing";
  if (/\b(?:report|insight|health|overview|summary|best ?sellers?|slow|analy[sz])/.test(t)) return "report";
  if (/\b(?:shop|products?|catalog|listings?|items?)\b/.test(t)) return "shop";
  return "general";
}

/** The phrases to show in turn: the topic's, then a few of the general ones. */
export function waitPhrases(topic: WaitTopic): string[] {
  const own = PHRASES[topic];
  const tail = topic === "general" ? [] : PHRASES.general.filter((p) => !own.includes(p)).slice(1);
  return [...own, ...tail];
}
