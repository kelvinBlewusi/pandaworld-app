/**
 * lib/scraper.ts
 *
 * Server-side product URL scraper.
 * Extracts title, description, price, brand, and image URLs from any product page
 * using only standard `fetch` — no headless browser required.
 */

export interface ScrapedProduct {
  title:       string | null;
  description: string | null;
  brand:       string | null;
  price:       number | null;
  /** Raw image URLs from the source page (not yet in our storage) */
  imageUrls:   string[];
  sourceUrl:   string;
}

const UA =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

// ─── HTML mini-parser helpers ─────────────────────────────────────────────────

function getMeta(html: string, property: string): string | null {
  // Matches both property="…" and name="…" meta variants in either attribute order
  const esc = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re1 = new RegExp(
    `<meta[^>]+(?:property|name)=["']${esc}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const re2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${esc}["']`,
    "i"
  );
  const m = html.match(re1) ?? html.match(re2);
  return m ? decodeHtmlEntities(m[1].trim()) : null;
}

function getJsonLd(html: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  const re =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(m[1]);
      if (Array.isArray(parsed)) results.push(...(parsed as Record<string, unknown>[]));
      else results.push(parsed as Record<string, unknown>);
    } catch {
      /* ignore malformed JSON-LD */
    }
  }
  return results;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function getPageTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return m ? decodeHtmlEntities(m[1].trim()) : null;
}

function extractImages(html: string, baseUrl: string): string[] {
  const seen = new Set<string>();
  const imgs: string[] = [];

  const add = (src: string | null | undefined) => {
    if (!src) return;
    try {
      const abs = src.startsWith("http") ? src : new URL(src, baseUrl).href;
      // Skip tiny icons, SVGs, loading placeholders, tracking pixels
      if (
        abs.includes(".svg") ||
        abs.includes("1x1") ||
        abs.includes("pixel") ||
        abs.includes("blank") ||
        /icon|logo|sprite|favicon/i.test(abs)
      )
        return;
      if (!seen.has(abs)) {
        seen.add(abs);
        imgs.push(abs);
      }
    } catch {
      /* ignore invalid URLs */
    }
  };

  // 1. og:image — usually the best hero image
  add(getMeta(html, "og:image"));
  add(getMeta(html, "og:image:secure_url"));
  add(getMeta(html, "twitter:image"));
  add(getMeta(html, "product:image"));

  // 2. JSON-LD Product images
  const lds = getJsonLd(html);
  for (const ld of lds) {
    const type = ld["@type"];
    if (type === "Product" || type === "ItemPage" || type === "WebPage") {
      const img = ld.image;
      if (typeof img === "string") add(img);
      else if (Array.isArray(img))
        (img as unknown[]).forEach(
          (i) => typeof i === "string" && add(i)
        );
      else if (img && typeof img === "object" && "url" in img)
        add((img as { url: string }).url);
    }
  }

  // 3. <img> tags — look for data-src or src pointing at jpg/png/webp
  const imgRe =
    /<img[^>]+(?:data-src|src)=["']([^"'?#]+\.(?:jpg|jpeg|png|webp)(?:\?[^"']*)?)/gi;
  let m: RegExpExecArray | null;
  while ((m = imgRe.exec(html)) !== null && imgs.length < 12) {
    add(m[1]);
  }

  return imgs.slice(0, 8);
}

// ─── JSON-LD product helpers ───────────────────────────────────────────────────

function jsonLdPrice(lds: Record<string, unknown>[]): number | null {
  for (const ld of lds) {
    if (ld["@type"] !== "Product") continue;
    const offers = ld.offers as Record<string, unknown> | undefined;
    if (!offers) continue;
    const priceVal =
      offers.price ?? offers.lowPrice ?? offers.highPrice;
    if (priceVal != null) {
      const n = parseFloat(String(priceVal).replace(/[^0-9.]/g, ""));
      if (!isNaN(n) && n > 0) return n;
    }
  }
  return null;
}

function jsonLdBrand(lds: Record<string, unknown>[]): string | null {
  for (const ld of lds) {
    if (ld["@type"] !== "Product") continue;
    const brand = ld.brand;
    if (!brand) continue;
    if (typeof brand === "string") return brand.trim() || null;
    if (typeof brand === "object") {
      const b = brand as Record<string, unknown>;
      const name = String(b.name ?? b["@name"] ?? "").trim();
      if (name) return name;
    }
  }
  return null;
}

function jsonLdDescription(lds: Record<string, unknown>[]): string | null {
  for (const ld of lds) {
    if (ld["@type"] === "Product" && ld.description) {
      const d = String(ld.description).trim();
      if (d) return decodeHtmlEntities(d);
    }
  }
  return null;
}

// ─── Main scrape ──────────────────────────────────────────────────────────────

export async function scrapeProductUrl(url: string): Promise<ScrapedProduct> {
  let html: string;

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
      // 15 s timeout — supported in Node 18+
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    html = await res.text();
  } catch (e) {
    throw new Error(`Could not fetch URL: ${(e as Error).message}`);
  }

  const lds = getJsonLd(html);

  // ── Title ──────────────────────────────────────────────────────────────────
  const title =
    getMeta(html, "og:title") ??
    getMeta(html, "twitter:title") ??
    getPageTitle(html) ??
    null;

  // ── Description ────────────────────────────────────────────────────────────
  const description =
    getMeta(html, "og:description") ??
    getMeta(html, "description") ??
    getMeta(html, "twitter:description") ??
    jsonLdDescription(lds) ??
    null;

  // ── Brand ──────────────────────────────────────────────────────────────────
  const brand =
    getMeta(html, "product:brand") ??
    getMeta(html, "og:brand") ??
    jsonLdBrand(lds) ??
    null;

  // ── Price (raw value — currency unknown) ───────────────────────────────────
  let price: number | null = null;
  const priceStr =
    getMeta(html, "product:price:amount") ??
    getMeta(html, "og:price:amount") ??
    getMeta(html, "price");
  if (priceStr) {
    const n = parseFloat(priceStr.replace(/[^0-9.]/g, ""));
    if (!isNaN(n) && n > 0) price = n;
  }
  if (price === null) price = jsonLdPrice(lds);

  // ── Images ─────────────────────────────────────────────────────────────────
  const imageUrls = extractImages(html, url);

  return { title, description, brand, price, imageUrls, sourceUrl: url };
}
