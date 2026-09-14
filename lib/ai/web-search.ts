/**
 * Google Custom Search wrapper — Tier 1.1 of the Google Cloud plan.
 *
 * Why this exists:
 *   The auto-analyze pipeline already runs Pass A (vision) + combined
 *   Pass B+C (rank + fill) + gap-fill (catches empty required fields).
 *   When the seller's images don't show specs like Volume / Capacity /
 *   Battery / Size, the AI has to guess from general knowledge. Often
 *   it returns null or a weak default.
 *
 *   With this module, the gap-fill step can FIRST search Google for
 *   "{brand} {title}" and read the snippets from the top spec page,
 *   then ask Gemini to fill the gaps using that as ground truth. Real
 *   data > guesses.
 *
 * Cost:
 *   Google Custom Search JSON API — $5 per 1000 queries.
 *   First 100 queries / day are FREE.
 *   We cache per-query for 1 hour in-memory so re-analyses + retries
 *   don't re-bill. Hard timeout of 6s so a slow Google day can't stall
 *   the pipeline.
 *
 * Setup (one-time, for the project owner):
 *   1. Go to https://programmablesearchengine.google.com/ → "Add"
 *   2. Name it "PandaWorld Spec Lookup", search the entire web
 *   3. Copy the "Search engine ID" (looks like "f12abc34d..." )
 *   4. In Google Cloud Console → APIs & Services → enable
 *      "Custom Search API"
 *   5. Create a SEPARATE API key for this — do NOT reuse GOOGLE_API_KEY.
 *      Google will not let one key hold both the Gemini API restriction
 *      and any other: ticking Custom Search greys Gemini out with
 *      "Cannot be combined with the currently selected API restrictions",
 *      because Gemini keys must be bound to a service account. Since
 *      GOOGLE_API_KEY is the AI Studio fallback for generation,
 *      embeddings and extension-fill, restricting it to Custom Search
 *      would take all of those down.
 *   6. Add to Vercel env (Production scope):
 *        GOOGLE_CSE_ID      = <id from step 3>
 *        GOOGLE_CSE_API_KEY = <the separate key from step 5>
 *
 *   7. The engine must actually search the web. A site-restricted engine
 *      returns results only from those sites, which for product specs is
 *      worse than no grounding at all — the AI is told to treat snippets
 *      as ground truth, so a wrongly-scoped engine attributes another
 *      retailer's data to the seller's product.
 *
 * Graceful fallback:
 *   If GOOGLE_CSE_ID isn't set, the module returns empty results
 *   without throwing. The analyze pipeline continues exactly as
 *   before web-search existed.
 */

export interface WebSearchResult {
  title:   string;
  snippet: string;
  link:    string;
}

const WEB_SEARCH_TIMEOUT_MS = 6_000;
const WEB_SEARCH_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_RESULTS = 5;

// In-memory cache keyed by lowercased query. Survives across requests
// within the same Vercel serverless instance. Bounded by the natural
// lifetime of the process; no LRU eviction needed at our scale.
const _cache = new Map<string, { results: WebSearchResult[]; expires: number }>();

// Set once the API answers with something no retry can fix — a disabled
// API, a key that isn't allowed to call it, a bad search-engine id, or an
// exhausted daily quota. Null means "no permanent problem seen".
//
// Confirmed live on 2026-09-14: every gap-fill was paying for a round trip
// to be told
//   403 "Requests to this API customsearch method
//        google.customsearch.v1.CustomSearchService.List are blocked."
// and swallowing it as an ordinary miss, so grounding had been silently
// off for an unknown length of time while still costing a call per
// analysis. A configuration error is not a cache miss and should not be
// retried on every single listing.
let _disabledReason: string | null = null;

/** Permanent-looking API failures, by status. A 5xx or a timeout is NOT
 *  in here — those are worth retrying. */
function permanentFailureReason(status: number, body: string): string | null {
  if (status === 403) {
    return /blocked|not enabled|disabled|PERMISSION_DENIED|forbidden/i.test(body)
      ? "the Custom Search API is not enabled for this key's project, or the key's API restrictions exclude it"
      : "access forbidden";
  }
  if (status === 400) {
    return /API key not valid|invalid.*(key|cx)|Request contains an invalid argument/i.test(body)
      ? "the Custom Search key or GOOGLE_CSE_ID is not valid"
      : null;
  }
  if (status === 429) return "daily Custom Search quota exhausted (100/day on the free tier)";
  return null;
}

function pruneExpired(): void {
  const now = Date.now();
  _cache.forEach((entry, key) => {
    if (entry.expires <= now) _cache.delete(key);
  });
}

/**
 * Search Google for `query` via the Custom Search JSON API. Returns
 * up to MAX_RESULTS items (title + snippet + link). Returns [] when:
 *   - GOOGLE_CSE_ID is not configured
 *   - no Custom Search key is configured
 *   - the query is empty
 *   - the API returns non-2xx
 *   - the request times out at WEB_SEARCH_TIMEOUT_MS
 *
 * Never throws. Caller can always treat the result as a "best-effort
 * extra context" boost — the rest of the pipeline must still work
 * when this returns nothing.
 */
/**
 * The key Custom Search runs on.
 *
 * Its own variable, because Google forbids combining the Gemini API
 * restriction with any other on a single key — so the key that serves
 * AI Studio generation, embeddings and extension-fill physically cannot
 * also be allowed to call Custom Search.
 *
 * Falls back to GOOGLE_API_KEY so nothing breaks before the new variable
 * is set; that fallback is what is currently 403ing with
 * API_KEY_SERVICE_BLOCKED, which is exactly the state this separation
 * resolves.
 */
function customSearchApiKey(): string | undefined {
  return process.env.GOOGLE_CSE_API_KEY ?? process.env.GOOGLE_API_KEY;
}

export async function webSearch(query: string): Promise<WebSearchResult[]> {
  const apiKey = customSearchApiKey();
  const cseId  = process.env.GOOGLE_CSE_ID;
  const clean  = query.trim();

  if (!apiKey || !cseId || clean.length === 0) return [];
  if (_disabledReason) return [];

  // Cache lookup.
  pruneExpired();
  const cacheKey = clean.toLowerCase().slice(0, 256);
  const cached = _cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.results;
  }

  const url =
    `https://www.googleapis.com/customsearch/v1` +
    `?key=${encodeURIComponent(apiKey)}` +
    `&cx=${encodeURIComponent(cseId)}` +
    `&q=${encodeURIComponent(clean)}` +
    `&num=${MAX_RESULTS}` +
    `&safe=active`;

  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS) });
    const elapsed = Date.now() - t0;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const permanent = permanentFailureReason(res.status, text);

      if (permanent) {
        // Latch off for this process. pg_cron and Vercel recycle
        // instances often enough that fixing the config takes effect
        // without a deploy, and a config error that repeats on every
        // analysis is noise that buries real failures.
        _disabledReason = permanent;
        console.error(
          `[web-search] DISABLED for this process — HTTP ${res.status}: ${permanent}. ` +
            `Gap-fill will run WITHOUT web grounding until this is fixed. ` +
            `Enable "Custom Search API" in the project, then allow it on the key. Note that ` +
            `Google will NOT let one key hold both the Gemini API restriction and Custom ` +
            `Search — set GOOGLE_CSE_API_KEY to a SEPARATE key rather than reusing ` +
            `GOOGLE_API_KEY, which the AI Studio paths depend on. Raw: ${text.slice(0, 200)}`,
        );
        return [];
      }

      console.warn(
        `[web-search] HTTP ${res.status} after ${elapsed}ms (transient, will retry next call) — ${text.slice(0, 200)}`,
      );
      return [];
    }

    const data = (await res.json()) as {
      items?: Array<{ title?: string; snippet?: string; link?: string }>;
    };

    const items = (data.items ?? [])
      .slice(0, MAX_RESULTS)
      .map((it) => ({
        title:   String(it.title ?? "").trim(),
        snippet: String(it.snippet ?? "").trim().replace(/\s+/g, " "),
        link:    String(it.link ?? "").trim(),
      }))
      .filter((it) => it.title.length > 0 || it.snippet.length > 0);

    _cache.set(cacheKey, { results: items, expires: Date.now() + WEB_SEARCH_CACHE_TTL_MS });

    console.info(`[web-search] q="${clean.slice(0, 80)}" hits=${items.length} ms=${elapsed}`);
    return items;
  } catch (e) {
    const elapsed = Date.now() - t0;
    console.warn(`[web-search] failed after ${elapsed}ms: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Format the top-N results as a single text block suitable for
 * prompting Gemini. Title + snippet only (no link — Gemini doesn't
 * need it). Truncated for prompt-size sanity.
 *
 * Returns an empty string when there are no results, so the caller
 * can safely concatenate it into a prompt without checking length.
 */
export function formatSearchSnippetsForPrompt(results: WebSearchResult[], maxItems = 3): string {
  if (results.length === 0) return "";
  const top = results.slice(0, maxItems);
  const lines = top.map((r, i) => {
    const t = r.title.slice(0, 120);
    const s = r.snippet.slice(0, 400);
    return `${i + 1}. ${t}\n   ${s}`;
  });
  return `\n\nWEB SEARCH RESULTS (Google snippets for the product — use as ground truth for specs the images don't clearly show; verify before trusting):\n${lines.join("\n")}\n`;
}

/**
 * Cheap helper: true when the project is configured to actually call
 * the Custom Search API. Use this for short-circuit checks in callers
 * so we don't pay any wall-clock time building queries that will be
 * thrown away anyway.
 */
export function isWebSearchEnabled(): boolean {
  if (_disabledReason) return false;
  return Boolean(customSearchApiKey() && process.env.GOOGLE_CSE_ID);
}

/** Why web search switched itself off in this process, or null. Exported
 *  for tests and for anything that wants to report configuration health. */
export function webSearchDisabledReason(): string | null {
  return _disabledReason;
}

/** Tests only — clears the latch. */
export function __resetWebSearchLatch(): void {
  _disabledReason = null;
}
