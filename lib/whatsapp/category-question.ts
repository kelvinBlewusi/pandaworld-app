/**
 * The "which category does Vendor Center accept?" question — asked in
 * WhatsApp when Jumia refuses our category pick with "You can't list
 * products in this category" a second time (see askSellerForCategory in
 * lib/whatsapp/intake.ts).
 *
 * The seller can see which categories Vendor Center accepts and we can't,
 * so once one automatic redraft has failed they are the best source. This
 * module is the pure half: which categories to suggest, and how to read a
 * typed reply. Nothing here writes or sends.
 */

import { getListableCategories, type JumiaCategoryRow } from "@/lib/jumia/categories";
import { searchCategoriesByText } from "@/lib/jumia/category-search";
import { blockedCategoryCodes, sellerCountry } from "@/lib/jumia/unlistable-categories";

export interface CategoryChoice {
  code: number;
  name: string;
  path: string;
}

function toChoice(c: JumiaCategoryRow): CategoryChoice {
  return { code: Number(c.code), name: c.name, path: c.path };
}

/**
 * Categories a seller can pick from: Jumia's listable leaves. A non-leaf
 * draws the same "choose a more specific category" rejection we're trying
 * to get out of, so offering one would just repeat it.
 */
export async function listableLeafCategories(): Promise<JumiaCategoryRow[]> {
  return (await getListableCategories()).filter((c) => c.is_leaf);
}

/**
 * Codes this seller must not be offered: everything Jumia has refused in
 * their country, plus the category the listing is in right now. The
 * current one is added explicitly because a seller whose connection has no
 * country has no blocklist to catch it.
 */
export async function refusedCategoryCodes(userId: string, currentCode: string | null): Promise<Set<number>> {
  const refused = await blockedCategoryCodes(await sellerCountry(userId));
  if (currentCode && /^\d+$/.test(currentCode)) refused.add(Number(currentCode));
  return refused;
}

/**
 * Up to `limit` suggestions for the question's list: the AI's own ranked
 * alternates from the last draft first (the best signal we have), then
 * fuzzy matches on the title. Callers pass `pickable` already stripped of
 * refused codes.
 */
export function suggestCategories(
  listing:  { title: string | null; category_alternates?: { code: number }[] | null },
  pickable: JumiaCategoryRow[],
  limit = 5,
): CategoryChoice[] {
  const byCode = new Map(pickable.map((c) => [Number(c.code), c]));
  const out: CategoryChoice[] = [];
  const add = (code: number) => {
    const c = byCode.get(Number(code));
    if (c && !out.some((o) => o.code === Number(c.code))) out.push(toChoice(c));
  };
  for (const a of listing.category_alternates ?? []) add(a.code);
  if (listing.title) {
    for (const c of searchCategoriesByText(listing.title, pickable, limit * 2)) add(c.code);
  }
  return out.slice(0, limit);
}

/** Lowercase words, "&" read as "and", plurals folded ("Power Banks" ≡ "power bank"). */
function normalizeWords(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w))
    .join(" ");
}

/** A stored category path as normalized segments: "A > B & C" → ["a", "b and c"]. */
function segments(path: string): string[] {
  return path.split(">").map(normalizeWords).filter(Boolean);
}

// What separates the levels of a pasted breadcrumb: ">" as we write paths,
// the "›"/"»"/"→" glyphs sites use, "|", a line break per level (how a
// breadcrumb copied off a web page often pastes), or a spaced " / ".
const PASTED_SEPARATOR_RE = /\s*(?:>|›|»|→|\||\n|\s\/\s)\s*/;

/**
 * What the seller sent, as category segments. Accepts a bare name, a full
 * or partial path, a breadcrumb copied off a Jumia product page (leading
 * "Home" dropped), or a link to a Jumia category page (its slug). A link to
 * a product page carries no category, so it's flagged instead.
 */
export function parseCategoryAnswer(text: string): { raw: string[]; normalized: string[]; productLink: boolean } {
  const url = text.match(/(?:https?:\/\/)?(?:www\.)?jumia\.[a-z.]+(\/\S*)?/i);
  if (url) {
    const parts = (url[1] ?? "").split(/[?#]/)[0].split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    if (!last) return { raw: [], normalized: [], productLink: false };
    if (/\.html?$/i.test(last)) return { raw: [], normalized: [], productLink: true };
    const name = last.replace(/[-_]+/g, " ");
    return { raw: [name], normalized: [normalizeWords(name)].filter(Boolean), productLink: false };
  }

  const raw = text.split(PASTED_SEPARATOR_RE).map((s) => s.trim()).filter((s) => normalizeWords(s));
  while (raw.length > 0 && normalizeWords(raw[0]) === "home") raw.shift();
  return { raw, normalized: raw.map(normalizeWords), productLink: false };
}

export type CategoryAnswer =
  /** One category fits what the seller sent: use it. */
  | { kind: "match"; category: CategoryChoice }
  /**
   * The seller picks: several categories share the name they sent
   * (exact), they named a parent (under), or there were only near matches.
   */
  | { kind: "choose"; exact: boolean; under?: string; options: CategoryChoice[] }
  /** The seller named a category Jumia has already refused here. */
  | { kind: "refused"; name: string }
  /** A link to a product page, which doesn't say its category. */
  | { kind: "product_link" }
  | { kind: "none" };

/** Order categories by how well they fit the product's title; unmatched keep their order at the end. */
function rankByTitle(options: JumiaCategoryRow[], title: string | null | undefined): JumiaCategoryRow[] {
  if (!title || options.length < 2) return options;
  const order = searchCategoriesByText(title, options, options.length).map((c) => Number(c.code));
  const rank = (c: JumiaCategoryRow) => {
    const i = order.indexOf(Number(c.code));
    return i === -1 ? order.length : i;
  };
  return [...options].sort((a, b) => rank(a) - rank(b));
}

/**
 * Read the seller's answer against Jumia's categories.
 *
 * Works from the most specific thing they sent. A breadcrumb copied off a
 * product page often ends with the product's own name and starts with
 * sections the public site names differently from Vendor Center, so no
 * single segment is trusted to be the category:
 *
 *   1. The deepest segment that is a category's own name. Ties (the same
 *      name in several departments) go to the categories whose path shares
 *      the most of the other segments sent.
 *   2. Otherwise the deepest segment naming a parent, whose categories are
 *      offered ranked by the product title — "Mobile Accessories" alone
 *      can't say which one.
 *   3. Otherwise near matches.
 *
 * Only a single clear fit is applied without asking; everything else is
 * shown back as a list, because switching to a category the seller didn't
 * mean costs another Jumia rejection.
 */
export function matchCategoryAnswer(
  text:    string,
  leaves:  JumiaCategoryRow[],
  refused: Set<number>,
  opts:    { title?: string | null; limit?: number } = {},
): CategoryAnswer {
  const limit = opts.limit ?? 5;
  const { raw, normalized: typed, productLink } = parseCategoryAnswer(text);
  if (productLink) return { kind: "product_link" };
  if (typed.length === 0) return { kind: "none" };

  const isOk = (c: JumiaCategoryRow) => !refused.has(Number(c.code));
  const indexed = leaves.map((c) => ({ c, path: segments(c.path), name: normalizeWords(c.name) }));

  // 1. A segment that names a category itself.
  for (let i = typed.length - 1; i >= 0; i--) {
    const hits = indexed.filter((x) => x.name === typed[i] || x.path[x.path.length - 1] === typed[i]);
    if (hits.length === 0) continue;

    const context = typed.filter((_, j) => j !== i);
    const overlap = (x: (typeof hits)[number]) => context.filter((t) => x.path.includes(t)).length;
    const best = Math.max(...hits.map(overlap));
    const ok = hits.filter((x) => isOk(x.c));
    const bestOk = ok.length > 0 ? Math.max(...ok.map(overlap)) : -1;
    // The seller's path points at a refused category more precisely than
    // at any allowed one: that's the one they meant.
    if (ok.length === 0 || bestOk < best) {
      return { kind: "refused", name: hits.find((x) => overlap(x) === best)!.c.name };
    }
    const top = ok.filter((x) => overlap(x) === bestOk).map((x) => x.c);
    if (top.length === 1) return { kind: "match", category: toChoice(top[0]) };
    return { kind: "choose", exact: true, options: rankByTitle(top, opts.title).slice(0, 10).map(toChoice) };
  }

  // 2. A segment that names a parent.
  for (let i = typed.length - 1; i >= 0; i--) {
    const under = indexed.filter((x) => x.path.slice(0, -1).includes(typed[i]));
    if (under.length === 0) continue;
    const ok = under.filter((x) => isOk(x.c)).map((x) => x.c);
    if (ok.length === 0) return { kind: "refused", name: raw[i] };
    if (ok.length === 1) return { kind: "match", category: toChoice(ok[0]) };
    return { kind: "choose", exact: false, under: raw[i], options: rankByTitle(ok, opts.title).slice(0, 10).map(toChoice) };
  }

  // 3. Near matches.
  const near = searchCategoriesByText(raw.join(" "), leaves.filter(isOk), limit);
  if (near.length > 0) {
    return { kind: "choose", exact: false, options: near.map((c) => ({ code: c.code, name: c.name, path: c.path })) };
  }
  return { kind: "none" };
}

/** Jumia's public shop for a seller's country, where they can look up a similar product's category. */
const JUMIA_STOREFRONTS: Record<string, string> = {
  GH: "jumia.com.gh",
  NG: "jumia.com.ng",
  KE: "jumia.co.ke",
  EG: "jumia.com.eg",
  MA: "jumia.ma",
  SN: "jumia.sn",
  CI: "jumia.ci",
};

export function jumiaStorefront(country: string | null): string {
  return (country && JUMIA_STOREFRONTS[country.toUpperCase()]) || "Jumia";
}

/**
 * The last resort when the seller doesn't know the category: look up a
 * similar product that's already listed on Jumia and paste its category.
 * Our editor has no Vendor Center-style category picker, so it's no help
 * for a category Jumia keeps refusing.
 */
export function findOnJumiaTip(country: string | null): string {
  return (
    `Search ${jumiaStorefront(country)} for a product like this one and open it. ` +
    `Its category path is at the top of the page, e.g. Phones & Tablets > Accessories > Power Banks. ` +
    `Copy it and paste it here: the whole path, part of it, or just the last name all work.`
  );
}

/** "I don't know" and friends: the seller gets findOnJumiaTip instead. */
export const CATEGORY_SKIP_RE = /^(?:(?:skip|no|nope|later|idk|dunno)[.!]*$|not sure|i(?:'m| am) not sure|i don'?t know|no idea)/i;

/**
 * Could this message be an answer to the category question at all? Things
 * that clearly aren't (a bare number, a tapped button's id, a submit or
 * "2: …" edit command, a quick "ok"/"thanks") drop the question and go
 * through the normal flow instead, the same way awaitingPriceFor lets go
 * of anything that isn't a price. Generous on length: a breadcrumb pasted
 * off a product page can end with a long product name.
 */
export function looksLikeCategoryAnswer(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 400) return false;
  if (/^\d+$/.test(t)) return false;
  if (/^(?!https?:)[a-z_]+:\S/i.test(t)) return false;
  if (/^submit\b/i.test(t)) return false;
  if (/^\d+\s*[:.)-]/.test(t)) return false;
  if (/^(hi|hello|hey|ok|okay|thanks|thank you|thx|yes|yeah|done|good|great|cool|nice)[.!]*$/i.test(t)) return false;
  return true;
}

/** A list row for a category: the name as the title, where it sits as the subtitle. */
export function categoryListRow(listingId: string, c: CategoryChoice): { id: string; title: string; description?: string } {
  const parent = c.path.split(">").map((s) => s.trim()).filter(Boolean).slice(0, -1).join(" > ");
  // Meta caps a row description at 72 characters; the end of the path
  // says more than its start ("… > Accessories" beats "Phones & Tab…").
  const description = parent.length > 72 ? `…${parent.slice(parent.length - 71)}` : parent;
  return {
    id:    `recat:${listingId}:${c.code}`,
    title: c.name,
    ...(description ? { description } : {}),
  };
}
