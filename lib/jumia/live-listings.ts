/**
 * Learning from listings that went live — see
 * supabase/migrations/2026-09-28_jumia-live-listings.sql.
 *
 * Every listing Jumia accepts is recorded with its country, category and
 * title (from logFeedOutcome). When the AI drafts a new product,
 * provenCategoriesFor finds live listings in the seller's country whose
 * titles describe the same kind of product, and hands their categories to
 * runAutoAnalyze as extra candidates, marked as accepted by Jumia.
 *
 * Accepted is not the same as right: real live listings include a safety
 * helmet under "Plate Casters" and a yoga mat under "Clinometers". So a
 * live category is only offered, never applied, and one whose own name
 * shares no word with the product is dropped before the AI sees it.
 */

import { createServerClient } from "@/lib/supabase/server";
import type { JumiaCategoryRow } from "@/lib/jumia/categories";

/**
 * Record (or refresh) a listing that went live. Best-effort and never
 * throws: it runs inside outcome logging, which must not fail a push.
 */
export async function recordLiveListing(
  listingId:    string,
  country:      string,
  categoryCode: number,
  title:        string,
): Promise<void> {
  try {
    const db = createServerClient();
    const row = { country, category_code: categoryCode, title, went_live_at: new Date().toISOString() };
    const { data: existing } = await db
      .from("jumia_live_listings")
      .select("listing_id")
      .eq("listing_id", listingId)
      .maybeSingle();
    if (existing) {
      await db.from("jumia_live_listings").update(row).eq("listing_id", listingId);
    } else {
      await db.from("jumia_live_listings").insert({ listing_id: listingId, ...row });
    }
  } catch (e) {
    console.warn(`[live-listings] failed to record ${listingId}: ${(e as Error).message}`);
  }
}

/**
 * Stop learning from a listing: Jumia's quality check rejected it after
 * the feed went through (lib/jumia/qc-followup.ts), so its category was
 * never really accepted. Best-effort and never throws.
 */
export async function forgetLiveListing(listingId: string): Promise<void> {
  try {
    const db = createServerClient();
    await db.from("jumia_live_listings").delete().eq("listing_id", listingId);
  } catch (e) {
    console.warn(`[live-listings] failed to forget ${listingId}: ${(e as Error).message}`);
  }
}

export interface LiveExample {
  title:         string;
  category_code: number;
}

/** The country's most recent live listings. Empty on any failure. */
export async function liveExamples(country: string, limit = 2000): Promise<LiveExample[]> {
  try {
    const db = createServerClient();
    const { data } = await db
      .from("jumia_live_listings")
      .select("title, category_code")
      .eq("country", country)
      .order("went_live_at", { ascending: false })
      .limit(limit);
    return ((data ?? []) as LiveExample[]).map((r) => ({ title: r.title, category_code: Number(r.category_code) }));
  } catch (e) {
    console.warn(`[live-listings] failed to read examples for ${country}: ${(e as Error).message}`);
    return [];
  }
}

// Words that say nothing about what the product is.
const STOPWORDS = new Set([
  "and", "with", "for", "the", "of", "set", "piece", "pieces", "large", "small", "new",
  "design", "style", "type", "pack", "multi", "pro", "plus", "max", "mini", "size",
  "color", "colour",
]);

/**
 * A title's product words: lowercased, plurals folded, and without spec
 * tokens (anything with a digit: "20000mah", "1.8l", "4gb"), which say
 * which model it is rather than what kind of product.
 */
export function productTokens(text: string): string[] {
  const out: string[] = [];
  for (let w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3 || /\d/.test(w) || STOPWORDS.has(w)) continue;
    if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

/**
 * The part of a drafted title that names the product. Our titles read
 * "Product Name - feature, feature", and the features ("Adjustable
 * Straps", "Stainless Steel") are shared across unrelated products.
 */
export function productHead(title: string): string {
  return title.split(/\s+-\s+|,/)[0] ?? title;
}

export interface ProvenCategory {
  code:  number;
  /** How closely the best live listing's title matched, 0..1. */
  score: number;
  /** That listing's title — shown to the AI as the evidence. */
  exampleTitle: string;
}

/**
 * Categories that live listings like this product went live in.
 *
 * Similarity compares the product words in the two titles' heads, with
 * rare words ("kettle", "chainsaw") counting for more than common ones
 * ("electric", "portable"). A match is either a two-way (Dice) overlap of
 * at least `threshold`, or one name containing nearly all of the other's
 * words. Measured on the 60 live Ghana listings (leave-one-out,
 * 2026-09-28), each rule caught good pairs the other missed: two
 * headphone models (Dice), "Portable Cordless Chainsaw" ~ "Mini
 * Chainsaw" (containment).
 *
 * `listable` must already exclude categories Jumia refuses in this
 * country. A category is kept only if it's still listable and its own
 * name shares a word with the product (title or keywords), which drops
 * the miscategorised live listings a plain title match would pass on.
 */
export function findProvenCategories(
  product:  { title: string; keywords?: string[] },
  examples: LiveExample[],
  listable: Map<number, Pick<JumiaCategoryRow, "code" | "name">>,
  opts:     { threshold?: number; limit?: number } = {},
): ProvenCategory[] {
  const threshold = opts.threshold ?? 0.5;
  const limit = opts.limit ?? 2;
  const query = productTokens(productHead(product.title));
  if (query.length === 0 || examples.length === 0) return [];

  const heads = examples.map((e) => productTokens(productHead(e.title)));
  const df = new Map<string, number>();
  for (const tokens of heads) for (const t of tokens) df.set(t, (df.get(t) ?? 0) + 1);
  const idf = (t: string) => Math.log(1 + examples.length / (1 + (df.get(t) ?? 0)));
  const weight = (tokens: string[]) => tokens.reduce((sum, t) => sum + idf(t), 0);
  const queryWeight = weight(query);

  // The whole title here, not just its head: "Safety Helmet - Hard Hat"
  // is relevant to a category named "Hard Hats".
  const relevant = new Set([...productTokens(product.title), ...productTokens((product.keywords ?? []).join(" "))]);
  const best = new Map<number, ProvenCategory>();

  examples.forEach((example, i) => {
    const tokens = heads[i];
    const shared = tokens.filter((t) => query.includes(t));
    if (shared.length === 0) return;
    const exampleWeight = weight(tokens);
    const dice = (2 * weight(shared)) / (queryWeight + exampleWeight);
    // Also a match when one name contains all of the other's words: a
    // drafted "Portable Power Bank Fast Charging" vs a live "Power Bank"
    // scores only 0.44 on the two-way overlap above.
    const containment = weight(shared) / Math.min(queryWeight, exampleWeight);
    if (dice < threshold && containment < 0.9) return;
    const score = Math.max(dice, containment * 0.8);

    const category = listable.get(example.category_code);
    if (!category) return;
    if (!productTokens(category.name).some((t) => relevant.has(t))) return;

    const current = best.get(example.category_code);
    if (!current || score > current.score) {
      best.set(example.category_code, { code: example.category_code, score, exampleTitle: example.title });
    }
  });

  return Array.from(best.values()).sort((a, b) => b.score - a.score).slice(0, limit);
}

/** findProvenCategories over the country's live listings. Empty without a country. */
export async function provenCategoriesFor(
  country:  string | null,
  product:  { title: string; keywords?: string[] },
  listable: JumiaCategoryRow[],
): Promise<ProvenCategory[]> {
  if (!country) return [];
  const examples = await liveExamples(country);
  if (examples.length === 0) return [];
  return findProvenCategories(product, examples, new Map(listable.map((c) => [Number(c.code), c])));
}
