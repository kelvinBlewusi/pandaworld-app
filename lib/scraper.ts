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

// Multiple real-browser UAs to cycle through on failure
const USER_AGENTS = [
  // Chrome 124 on Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  // Chrome 124 on Mac
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  // Firefox 125 on Windows
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0",
  // Safari on Mac
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Safari/605.1.15",
];

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

// ─── URL slug → readable title ────────────────────────────────────────────────

/**
 * Best-effort product title from the URL path segment.
 * e.g. "samsung-galaxy-a16-128gb-4gb-ram-50mp-camera-6.7-5000mah-black-24-months-warranty-300525223"
 *   → "Samsung Galaxy A16 128gb 4gb Ram 50mp Camera 6.7 5000mah Black 24 Months Warranty"
 */
function titleFromSlug(url: string): string | null {
  try {
    const pathname = new URL(url).pathname;
    // Take the last non-empty path segment, strip file extension
    const segments = pathname.split("/").filter(Boolean);
    let slug = segments[segments.length - 1] ?? "";
    if (!slug) return null;

    // Strip file extension (e.g. .html, .htm)
    slug = slug.replace(/\.[a-z]{2,4}$/, "");

    // Remove trailing numeric IDs (e.g. -300525223 or just 300525223)
    const cleaned = slug.replace(/-\d{5,}$/, "").trim();
    if (!cleaned) return null;

    // Convert slug to title case words
    return cleaned
      .split("-")
      .filter(Boolean)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(" ")
      .trim() || null;
  } catch {
    return null;
  }
}

// ─── Scraping bypass services ────────────────────────────────────────────────
//
// Many marketplaces (Jumia, Amazon, Shopify-on-Cloudflare) use Cloudflare bot
// management which blocks server-side fetch regardless of User-Agent — they
// fingerprint TLS/JA3/IP. To get the real HTML we route through a paid bypass
// service that runs a real headless browser.
//
// Configured via env vars (any one is enough):
//   SCRAPER_API_KEY   — scraperapi.com  (5000 free/mo, simplest)
//   SCRAPINGBEE_KEY   — scrapingbee.com (1000 free/mo)
//   ZENROWS_KEY       — zenrows.com     (1000 free/mo)
//
// Domains that need a bypass are listed below. Other URLs use direct fetch.

const CLOUDFLARE_DOMAINS = [
  "jumia.com",
  "jumia.com.gh",
  "jumia.com.ng",
  "jumia.co.ke",
  "jumia.com.eg",
  "jumia.ma",
  "jumia.sn",
  "jumia.ci",
  "jumia.co.tz",
  "jumia.co.ug",
];

function needsBypass(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return CLOUDFLARE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

async function fetchViaBypass(url: string): Promise<string | null> {
  // Try ScraperAPI first (cheapest credit cost)
  const scraperApiKey = process.env.SCRAPER_API_KEY;
  if (scraperApiKey) {
    const proxyUrl = `https://api.scraperapi.com/?api_key=${scraperApiKey}&url=${encodeURIComponent(url)}&render=true&country_code=us`;
    try {
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(60_000) });
      if (res.ok) return await res.text();
      console.warn(`[scraper] ScraperAPI returned ${res.status}`);
    } catch (e) {
      console.warn(`[scraper] ScraperAPI error:`, (e as Error).message);
    }
  }

  // ScrapingBee fallback
  const scrapingBeeKey = process.env.SCRAPINGBEE_KEY;
  if (scrapingBeeKey) {
    const proxyUrl = `https://app.scrapingbee.com/api/v1/?api_key=${scrapingBeeKey}&url=${encodeURIComponent(url)}&render_js=true`;
    try {
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(60_000) });
      if (res.ok) return await res.text();
      console.warn(`[scraper] ScrapingBee returned ${res.status}`);
    } catch (e) {
      console.warn(`[scraper] ScrapingBee error:`, (e as Error).message);
    }
  }

  // ZenRows fallback
  const zenrowsKey = process.env.ZENROWS_KEY;
  if (zenrowsKey) {
    const proxyUrl = `https://api.zenrows.com/v1/?apikey=${zenrowsKey}&url=${encodeURIComponent(url)}&js_render=true&antibot=true`;
    try {
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(60_000) });
      if (res.ok) return await res.text();
      console.warn(`[scraper] ZenRows returned ${res.status}`);
    } catch (e) {
      console.warn(`[scraper] ZenRows error:`, (e as Error).message);
    }
  }

  return null;
}

// ─── HTTP fetch with UA cycling ───────────────────────────────────────────────

async function fetchHtml(url: string): Promise<{ html: string; status: number }> {
  const baseHeaders = {
    Accept:          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    Pragma:          "no-cache",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Upgrade-Insecure-Requests": "1",
  };

  let lastError: string = "";

  for (const ua of USER_AGENTS) {
    try {
      const res = await fetch(url, {
        headers: { ...baseHeaders, "User-Agent": ua },
        signal:  AbortSignal.timeout(15_000),
        redirect: "follow",
      });

      if (res.ok) {
        const html = await res.text();
        return { html, status: res.status };
      }

      lastError = `HTTP ${res.status}`;

      // Don't retry on client errors other than 403 (e.g. 404 = page gone)
      if (res.status !== 403 && res.status !== 429) {
        throw new Error(`HTTP ${res.status} from ${url}`);
      }

      // Brief pause before next UA attempt
      await new Promise((r) => setTimeout(r, 300));
    } catch (e) {
      if ((e as Error).message.startsWith("HTTP ")) throw e;
      lastError = (e as Error).message;
    }
  }

  throw new Error(`Could not fetch URL: ${lastError} from ${url}`);
}

// ─── Main scrape ──────────────────────────────────────────────────────────────

export async function scrapeProductUrl(url: string): Promise<ScrapedProduct> {
  let html: string | null = null;

  // 1. For known Cloudflare-protected sites, try the bypass service first
  if (needsBypass(url)) {
    console.info(`[scraper] ${new URL(url).hostname} is Cloudflare-protected — using bypass service`);
    html = await fetchViaBypass(url);
    if (!html) {
      console.warn(`[scraper] Bypass service unavailable or failed — falling back to direct fetch`);
    }
  }

  // 2. Fall back to direct fetch with UA rotation
  if (!html) {
    try {
      const result = await fetchHtml(url);
      html = result.html;
    } catch (e) {
      // 3. If everything failed (or domain was Cloudflare-protected with no key), try bypass as last resort
      if (!needsBypass(url)) {
        const bypassed = await fetchViaBypass(url);
        if (bypassed) html = bypassed;
      }

      if (!html) {
        // 4. Last-ditch: extract title from URL slug so the AI can still generate a listing
        const msg = (e as Error).message;
        const isBlocked = msg.includes("403") || msg.includes("429") || msg.includes("Cloudflare");

        if (isBlocked || needsBypass(url)) {
          const slugTitle = titleFromSlug(url);
          if (slugTitle) {
            console.info(`[scraper] All scrape methods blocked — using slug fallback: "${slugTitle}"`);
            return {
              title:       slugTitle,
              description: null,
              brand:       null,
              price:       null,
              imageUrls:   [],
              sourceUrl:   url,
            };
          }
        }

        throw new Error(`Could not fetch URL: ${msg}`);
      }
    }
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
